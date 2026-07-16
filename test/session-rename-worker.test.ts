import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');

function caseRegion(name: string): string {
  const start = workerSource.indexOf(`case '${name}':`);
  const next = workerSource.indexOf("\n    case '", start + 1);
  return workerSource.slice(start, next);
}

describe('worker native session rename queue', () => {
  it('queues rename IPC without opening a renderer or usage turn', () => {
    const region = caseRegion('rename_session');
    expect(region).toContain('desiredSessionRename = msg.title');
    expect(region).toContain('pendingSessionRename = msg.title');
    expect(region).toContain('void flushPending()');
    expect(region).not.toContain('renderer?.markNewTurn()');
    expect(region).not.toContain('usageLimitTracker.beginTurn');
  });

  it('waits for prompt readiness, uses the adapter command, and runs before user prompts', () => {
    const start = workerSource.indexOf('async function flushPending()');
    const end = workerSource.indexOf('\nfunction sendToPty(', start);
    const region = workerSource.slice(start, end);
    const renameIdx = region.indexOf('buildSessionRenameCommand');
    const promptLoopIdx = region.indexOf('while (pendingMessages.length > 0');

    expect(region).toContain('const sessionRenameReady = isPromptReady && pendingSessionRename !== null');
    expect(region).toContain('if (sessionRenameInFlight) return');
    expect(region).toContain('if (commandLineWritesPending > 0) return');
    expect(region).toContain('const rawInputReady = isPromptReady');
    expect(region).toContain('const targetBackend = backend');
    expect(region).toContain('await sendRawCommandLineSerially(targetBackend, buildRename(title))');
    expect(region).toContain('if (backend !== targetBackend) return');
    expect(region).toContain("effectiveBackendType === 'riff'");
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    expect(renameIdx).toBeLessThan(promptLoopIdx);
  });

  it('blocks type-ahead messages until the rename command returns to prompt', () => {
    const sendToPtyStart = workerSource.indexOf('function sendToPty(');
    const sendToPtyEnd = workerSource.indexOf('// ─── Screen Update Timer', sendToPtyStart);
    const sendToPtyRegion = workerSource.slice(sendToPtyStart, sendToPtyEnd);
    const readyStart = workerSource.indexOf('function markPromptReady()');
    const readyEnd = workerSource.indexOf('\nfunction persistCliSessionId', readyStart);
    const readyRegion = workerSource.slice(readyStart, readyEnd);

    expect(sendToPtyRegion).toContain('!sessionRenameInFlight && commandLineWritesPending === 0 && shouldWriteNow');
    expect(readyRegion).toContain('clearSessionRenameInFlight()');
    expect(workerSource).toContain('waitForSessionRenameToSettle');
    expect(readyRegion).toContain('if (sessionRenameWriteInProgress)');
    expect(readyRegion).toContain('if (sessionRenameWriteFailed)');
    expect(readyRegion).toContain('ptyActivitySequence <= sessionRenamePromptActivityFloor');
    expect(readyRegion).toContain('if (!nativeAdminEmptyComposerVisible())');
    expect(workerSource).toContain('renderer?.cursorLinePrefix()');
    expect(workerSource).toContain('function fireTranscriptDrivenIdle()');
    expect(workerSource).toContain("if (sessionRenameInFlight) {\n    log('Ignoring transcript-driven idle");
  });

  it('fails closed with a user-visible restart instruction instead of using a time-only readiness guess', () => {
    const killStart = workerSource.indexOf('function killCli(opts:');
    const killEnd = workerSource.indexOf('// ─── HTTP + WebSocket Server', killStart);
    const killRegion = workerSource.slice(killStart, killEnd);
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);

    expect(flushRegion).toContain('command failed');
    expect(flushRegion).toContain('notifyNativeAdminWriteFailure()');
    expect(workerSource).toContain("? '请先执行 /disconnect，再重新 /adopt 后重试 /rename。'");
    expect(workerSource).toContain(": '请执行 /restart 后重试 /rename。'");
    expect(workerSource).not.toContain('armSessionRenameIdleTimeout');
    expect(workerSource).not.toContain('SESSION_RENAME_IDLE_TIMEOUT_MS');
    expect(workerSource).toContain('finishSessionRenameWrite(false)');
    expect(killRegion).toContain('clearSessionRenameInFlight()');
  });

  it('re-applies the desired title after a Botmux-forwarded native rotation', () => {
    const detectorStart = workerSource.indexOf('function isBotmuxOwnedNativeRotation');
    const detectorEnd = workerSource.indexOf('\n/** Deliver passthrough', detectorStart);
    const detectorRegion = workerSource.slice(detectorStart, detectorEnd);
    const deliveryStart = workerSource.indexOf('async function deliverRawInput');
    const deliveryEnd = workerSource.indexOf('\n/** Inputs written to the CLI', deliveryStart);
    const region = workerSource.slice(deliveryStart, deliveryEnd);

    expect(detectorRegion).toContain("if (effectiveBackendType === 'riff') return false");
    expect(detectorRegion).toContain('cliAdapter?.nativeSessionRotationCommands');
    expect(region).toContain('const isNativeRotation = isBotmuxOwnedNativeRotation(msg.content)');
    expect(region).toContain('if (isNativeRotation && desiredSessionRename !== null)');
    expect(region).toContain('pendingSessionRename = desiredSessionRename');
    expect(region).toContain('if (ownsNativeTitleSequence) beginSessionRenameWrite()');
    expect(region.indexOf('pendingSessionRename = desiredSessionRename'))
      .toBeLessThan(region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content)'));
    expect(region.indexOf('beginSessionRenameWrite()'))
      .toBeLessThan(region.indexOf('await sendRawCommandLineSerially(targetBackend, msg.content)'));
  });

  it('serializes passthrough writes and applies deferred rotation before the final rename', () => {
    const rawRegion = caseRegion('raw_input');
    expect(rawRegion).toContain('const waitsForRotationPrompt = desiredSessionRename !== null');
    expect(rawRegion).toContain('(!isPromptReady || commandLineWritesPending > 0)');
    expect(rawRegion).toContain('|| pendingRawInputs.length > 0');
    expect(rawRegion).toContain('pendingRawInputs.push(msg)');
    expect(rawRegion).toContain('await deliverRawInput(msg)');

    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const flushRegion = workerSource.slice(flushStart, flushEnd);
    expect(flushRegion).toContain('pendingRawInputs.shift()');
    expect(flushRegion).toContain('await deliverRawInput(raw)');
    expect(flushRegion).toContain('const rawRotationCanPrecedeRename = rawInputReady');
    expect(flushRegion).toContain('(pendingSessionRename === null || rawRotationCanPrecedeRename)');
    expect(workerSource).toContain('await sendRawCommandLineSerially(targetBackend, msg.content)');
    expect(flushRegion.indexOf('await deliverRawInput(raw)'))
      .toBeLessThan(flushRegion.indexOf('await sendRawCommandLineSerially(targetBackend, buildRename(title))'));
  });

  it('does not carry a desired native title across restart, while preserving accepted input', () => {
    const killStart = workerSource.indexOf('function killCli(opts:');
    const killEnd = workerSource.indexOf('// ─── HTTP + WebSocket Server', killStart);
    const killRegion = workerSource.slice(killStart, killEnd);
    const restartRegion = caseRegion('restart');
    const spawnStart = workerSource.indexOf('function spawnCli(');
    const spawnEnd = workerSource.indexOf('\n  // (startupCommands one-shot', spawnStart);
    const spawnRegion = workerSource.slice(spawnStart, spawnEnd);

    expect(killRegion).toContain('pendingSessionRename = null');
    expect(killRegion).toContain('desiredSessionRename = null');
    expect(spawnRegion).toContain('if (cliSpawnGeneration > 0)');
    expect(spawnRegion).toContain('desiredSessionRename = null');
    expect(killRegion).toContain('if (!opts.preserveQueuedInput)');
    expect(killRegion).toContain('pendingMessages.length = 0');
    expect(killRegion).toContain('pendingRawInputs.length = 0');
    expect(restartRegion).toContain('killCli({ preserveQueuedInput: true })');
    expect(restartRegion).toContain('restartInProgress = true');
    expect(restartRegion).toContain('restartBackendToReplace = backend');
    expect(restartRegion).toContain('inflightInputs.onTurnComplete()');
    expect(restartRegion).not.toContain('inflightInputs.onCliExit()');
    expect(workerSource).toContain("log('First-prompt fallback released restart input gate for replacement backend')");
    expect(workerSource).toContain('backend !== restartBackendToReplace');

    const sendStart = workerSource.indexOf('function sendToPty(');
    const sendEnd = workerSource.indexOf('// ─── Screen Update Timer', sendStart);
    const sendRegion = workerSource.slice(sendStart, sendEnd);
    expect(sendRegion).toContain('if (!backend || !cliAdapter || restartInProgress)');
    expect(sendRegion).toContain('pendingMessages.push(next)');
    expect(workerSource).toContain('const stashed = restartInProgress ? 0 : inflightInputs.onCliExit()');
  });

  it('serializes adopted user input behind native administrative commands', () => {
    const messageRegion = caseRegion('message');
    const helperStart = workerSource.indexOf('async function runAdoptInputSerially');
    const helperEnd = workerSource.indexOf('\nfunction isBotmuxOwnedNativeRotation', helperStart);
    const helperRegion = workerSource.slice(helperStart, helperEnd);

    expect(messageRegion).toContain('await runAdoptInputSerially(async () =>');
    expect(helperRegion).toContain('await waitForSessionRenameToSettle()');
    expect(helperRegion).toContain('if (isSessionRenameQueueBusy())');
    expect(helperRegion.indexOf('await waitForSessionRenameToSettle()'))
      .toBeLessThan(helperRegion.indexOf('await runCommandLineWriteSerially(async () =>'));
    expect(messageRegion).toContain('const targetBackend = backend');
    expect(messageRegion).toContain('if (backend !== targetBackend) return');
  });

  it('waits for a new prompt after startup commands before using cached admin readiness', () => {
    const flushStart = workerSource.indexOf('async function flushPending()');
    const flushEnd = workerSource.indexOf('\nfunction sendToPty(', flushStart);
    const region = workerSource.slice(flushStart, flushEnd);

    expect(region).toContain('const ranStartupCommands = await runStartupCommands()');
    expect(region).toContain('if (ranStartupCommands) return');
    expect(region).toContain('if (startupCommandsAwaitingPrompt)');
  });

  it('reports observed native session ids to the daemon without writing the store directly', () => {
    const start = workerSource.indexOf('function persistCliSessionId');
    const end = workerSource.indexOf('\nfunction observeCursorCliSessionId', start);
    const region = workerSource.slice(start, end);

    expect(region).toContain("send({ type: 'cli_session_id', cliSessionId })");
    expect(region).not.toContain('sessionStore');
  });

  it('ignores callbacks from a backend generation that has already been replaced', () => {
    expect(workerSource).toContain('if (backend === registeredBackend) onPtyData(data)');
    expect(workerSource).toContain('if (backend !== registeredBackend) return');
    expect(workerSource).toContain('if (backend !== idleBackend) return');
    expect(workerSource).toContain('if (backend === observeBe) onPtyData(data)');
    expect(workerSource).toContain('if (backend === herdrBe) onPtyData(data)');
    expect(workerSource).toContain('msg.generation !== readySignalGeneration');
    expect(workerSource).toContain('BOTMUX_READY_GENERATION = readySignalGeneration');
  });

  it('skips a startup command rejected before any byte was written', () => {
    const start = workerSource.indexOf('async function runStartupCommands()');
    const end = workerSource.indexOf('\nconst pendingMessages:', start);
    const region = workerSource.slice(start, end);

    expect(region).toContain('!e.mayHavePartialInput');
    expect(region).toContain('if (!sentAnyCommand)');
    expect(region).toContain('startupCommandsAwaitingPrompt = false');
    expect(region).toContain('return false');
  });

  it('carries a spawn-generation token through the SessionStart ready signal', () => {
    expect(cliSource).toContain('const generation = process.env.BOTMUX_READY_GENERATION');
    expect(cliSource).toContain('JSON.stringify({ sessionId, source, generation })');
    expect(daemonSource).toContain("ds.worker.send({ type: 'session_ready', source, generation }");
    expect(workerSource).toContain('msg.generation !== readySignalGeneration');
  });
});
