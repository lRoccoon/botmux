import {
  beginVcPollingPass,
  buildVcMeetingWorkflowPayload,
  collectStableTranscriptItems,
  createVcMeetingSessionState,
  ingestNormalizedVcMeetingItems,
} from '../vc-agent/meeting-state.js';
import { fetchMeetingEventsAsBot, joinMeetingAsBot } from '../vc-agent/polling-source.js';
import {
  buildVcMeetingTriggerRequest,
  dispatchVcMeetingWorkflow,
  findOnlineDaemon,
} from '../vc-agent/trigger.js';
import type { NormalizedVcMeetingItem } from '../vc-agent/types.js';

function argValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function intArg(args: string[], name: string, fallback: number, min: number, max: number): number {
  const raw = argValue(args, name);
  const n = raw ? Number(raw) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function usage(): void {
  console.log(`botmux vc-agent <command>

Commands:
  tat-gate   Verify bot identity can read real transcript/chat items from a meeting
  poll       Run the P0 polling bridge and trigger a workflow with stable meeting state

Examples:
  botmux vc-agent tat-gate --meeting-id <meeting_id>
  botmux vc-agent tat-gate --meeting-number 123456789
  botmux vc-agent poll --meeting-id <meeting_id> --bot <larkAppId> --chat-id <oc_xxx> --workflow-id meeting-agent-attention
  botmux vc-agent poll --meeting-id <meeting_id> --page-token-mode incremental ...
`);
}

function resolveMeetingId(args: string[], opts: { allowJoin?: boolean } = {}): { meetingId: string; joined: boolean } {
  const meetingId = argValue(args, '--meeting-id');
  if (meetingId) return { meetingId, joined: false };
  const meetingNumber = argValue(args, '--meeting-number');
  if (!meetingNumber) throw new Error('missing --meeting-id or --meeting-number');
  if (opts.allowJoin === false) {
    throw new Error('--meeting-number would make the bot join the meeting; use --meeting-id for dry-run');
  }
  const joined = joinMeetingAsBot({
    meetingNumber,
    password: argValue(args, '--password'),
    profile: argValue(args, '--profile'),
  });
  return { meetingId: joined.meetingId, joined: true };
}

async function cmdTatGate(args: string[]): Promise<void> {
  const { meetingId, joined } = resolveMeetingId(args);
  const { raw, batch } = fetchMeetingEventsAsBot({
    meetingId,
    pageSize: intArg(args, '--page-size', 100, 20, 100),
    pageAll: true,
    profile: argValue(args, '--profile'),
  });
  const rawProblem = larkCliErrorSummary(raw);
  const contentItems = batch.items.filter((item) =>
    item.type === 'chat_received' || item.type === 'transcript_received',
  );
  const ok = !rawProblem && (contentItems.length > 0 || hasFlag(args, '--allow-empty-content'));
  const summary = {
    ok,
    meetingId,
    joined,
    totalItems: batch.items.length,
    transcriptItems: batch.items.filter((item) => item.type === 'transcript_received').length,
    chatItems: batch.items.filter((item) => item.type === 'chat_received').length,
    pageToken: batch.pageToken,
    ...(rawProblem ? { larkCliError: rawProblem } : {}),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!ok) {
    if (rawProblem) {
      console.error(`TAT read gate failed: lark-cli returned an error payload: ${rawProblem}`);
    } else {
      console.error('TAT read gate failed: bot identity did not read transcript_received/chat_received items. Make sure someone speaks or sends chat during the gate.');
    }
    console.error(`raw lark-cli payload excerpt: ${rawExcerpt(raw)}`);
    process.exit(2);
  }
}

function rawExcerpt(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 2_000);
  } catch {
    return String(raw).slice(0, 2_000);
  }
}

function larkCliErrorSummary(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, any>;
  const code = r.code ?? r.error?.code ?? r.data?.code;
  const msg = r.msg ?? r.message ?? r.error?.msg ?? r.error?.message ?? r.data?.msg;
  if (code !== undefined && code !== 0 && code !== '0') {
    return [String(code), typeof msg === 'string' ? msg : undefined].filter(Boolean).join(' ');
  }
  if (r.error && (typeof r.error === 'string' || typeof r.error === 'object')) {
    return typeof r.error === 'string' ? r.error : rawExcerpt(r.error);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmdPoll(args: string[]): Promise<void> {
  const larkAppId = argValue(args, '--bot') ?? process.env.BOTMUX_LARK_APP_ID;
  const chatId = argValue(args, '--chat-id');
  const workflowId = argValue(args, '--workflow-id');
  if (!larkAppId) throw new Error('missing --bot <larkAppId> (or BOTMUX_LARK_APP_ID)');
  if (!chatId) throw new Error('missing --chat-id <oc_...>');
  if (!workflowId) throw new Error('missing --workflow-id <id>');
  const daemon = findOnlineDaemon(larkAppId);
  const dryRun = hasFlag(args, '--dry-run');
  if (!daemon && !dryRun) throw new Error(`no online botmux daemon found for bot ${larkAppId}`);

  const { meetingId, joined } = resolveMeetingId(args, { allowJoin: !dryRun });
  const state = createVcMeetingSessionState({
    meeting: { id: meetingId },
    attentionTargetOpenId: argValue(args, '--attention-target'),
    notificationChatId: argValue(args, '--notification-chat-id'),
  });
  const pollMs = intArg(args, '--poll-ms', 10_000, 1_000, 300_000);
  const maxPolls = intArg(args, '--max-polls', hasFlag(args, '--once') ? 1 : Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = intArg(args, '--page-size', 100, 20, 100);
  const stabilizePollWindows = intArg(args, '--stabilize-windows', 1, 0, 10);
  const lookbackMs = intArg(args, '--lookback-ms', 30_000, 0, 30 * 60_000);
  const pageTokenMode = parsePageTokenMode(args);
  const idlePollsBeforeSoftClose = intArg(args, '--idle-polls-before-soft-close', 0, 0, 10_000);
  const instruction = argValue(args, '--instruction');

  console.error(`vc-agent polling started: meetingId=${meetingId}${joined ? ' joined=true' : ''} workflow=${workflowId} chat=${chatId}`);

  for (let poll = 0; poll < maxPolls; poll += 1) {
    beginVcPollingPass(state);
    const fallbackStart = pageTokenMode === 'incremental' || state.ingestion.lastSeenEventTime === undefined
      ? undefined
      : new Date(Math.max(0, state.ingestion.lastSeenEventTime - lookbackMs)).toISOString();
    const { batch } = fetchMeetingEventsAsBot({
      meetingId,
      pageToken: pageTokenMode === 'incremental' ? state.ingestion.pageToken : undefined,
      start: fallbackStart,
      pageSize,
      pageAll: true,
      profile: argValue(args, '--profile'),
    });
    state.meeting = { ...state.meeting, ...batch.meeting, id: meetingId };
    state.ingestion.pageToken = batch.pageToken;

    const ingest = ingestNormalizedVcMeetingItems(state, batch.items);
    const stableTranscripts = collectStableTranscriptItems(state, { stabilizePollWindows });
    const outgoing: NormalizedVcMeetingItem[] = [...ingest.acceptedItems, ...stableTranscripts];
    if (outgoing.length > 0) {
      const payload = buildVcMeetingWorkflowPayload(state, outgoing, {
        pageToken: batch.pageToken,
        hasMore: batch.hasMore,
      });
      if (dryRun) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const trigger = buildVcMeetingTriggerRequest({
          larkAppId,
          chatId,
          workflowId,
          payload,
          instruction,
        });
        const result = await dispatchVcMeetingWorkflow({ daemon: daemon!, trigger });
        if (!result.ok) throw new Error(`workflow trigger failed: ${result.error ?? result.errorCode ?? 'unknown error'}`);
        console.error(`vc-agent dispatched poll=${state.ingestion.pollOrdinal} items=${outgoing.length} trigger=${result.triggerId ?? ''}`);
      }
    }

    if (idlePollsBeforeSoftClose > 0 && state.ingestion.emptyPollCount >= idlePollsBeforeSoftClose) {
      console.error(`vc-agent soft close: ${state.ingestion.emptyPollCount} empty polls`);
      break;
    }
    if (poll + 1 < maxPolls) await sleep(pollMs);
  }
}

function parsePageTokenMode(args: string[]): 'time-window' | 'incremental' {
  const raw = argValue(args, '--page-token-mode') ?? 'time-window';
  if (raw === 'time-window' || raw === 'incremental') return raw;
  throw new Error('--page-token-mode must be time-window or incremental');
}

export async function cmdVcAgent(command: string, args: string[]): Promise<void> {
  try {
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      usage();
      return;
    }
    if (command === 'tat-gate') {
      await cmdTatGate(args);
      return;
    }
    if (command === 'poll') {
      await cmdPoll(args);
      return;
    }
    usage();
    throw new Error(`unknown vc-agent command: ${command}`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
