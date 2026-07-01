import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const triggerWorkflowFromEnvelopeMock = vi.hoisted(() => vi.fn());

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
    }
  }
  return { Client: FakeClient };
});

vi.mock('../src/workflows/trigger-from-envelope.js', () => ({
  triggerWorkflowFromEnvelope: triggerWorkflowFromEnvelopeMock,
}));

import { registerBot } from '../src/bot-registry.js';
import { __vcMeetingAgentTest } from '../src/daemon.js';

const APP_ID = 'cli_vc_daemon_test';

describe('VC meeting daemon session lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    triggerWorkflowFromEnvelopeMock.mockReset();
    __vcMeetingAgentTest.reset();
    registerBot({
      larkAppId: APP_ID,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      vcMeetingAgent: {
        enabled: true,
        workflowId: 'meeting-agent',
        chatId: 'oc_vc',
        flushIntervalMs: 100,
        stabilizeMs: 5_000,
      },
    });
  });

  afterEach(() => {
    __vcMeetingAgentTest.reset();
    vi.useRealTimers();
  });

  it('keeps an ended session after final flush failure, then timer retry closes it without repeated empty dispatch', async () => {
    triggerWorkflowFromEnvelopeMock
      .mockResolvedValueOnce({ ok: false, errorCode: 'trigger_failed', error: 'boom' })
      .mockResolvedValue({ ok: true, target: { workflowRunId: 'run_retry' } });

    await __vcMeetingAgentTest.handlePush({
      larkAppId: APP_ID,
      kind: 'meeting_activity',
      eventType: 'vc.bot.meeting_activity_v1',
      eventId: 'evt_activity',
      meeting: { id: 'm_retry', topic: 'Retry review' },
      raw: {
        event: {
          meeting_actitivty_items: [
            {
              activity_event_type: 'transcript_received',
              meeting: { id: 'm_retry', topic: 'Retry review' },
              transcript_received_items: [
                {
                  sentence_id: 'sent_retry',
                  speaker: { open_id: 'ou_a' },
                  text: 'ship the retry path',
                  start_time_ms: '1000',
                  end_time_ms: '1500',
                },
              ],
            },
          ],
        },
      },
    });
    expect(__vcMeetingAgentTest.hasSession(APP_ID, 'm_retry')).toBe(true);

    await __vcMeetingAgentTest.handlePush({
      larkAppId: APP_ID,
      kind: 'meeting_ended',
      eventType: 'vc.bot.meeting_ended_v1',
      eventId: 'evt_ended',
      meeting: { id: 'm_retry', topic: 'Retry review' },
      raw: { event: { meeting: { id: 'm_retry' } } },
    });

    expect(triggerWorkflowFromEnvelopeMock).toHaveBeenCalledTimes(1);
    expect(__vcMeetingAgentTest.hasSession(APP_ID, 'm_retry')).toBe(true);

    await vi.advanceTimersByTimeAsync(100);

    expect(triggerWorkflowFromEnvelopeMock).toHaveBeenCalledTimes(2);
    expect(__vcMeetingAgentTest.hasSession(APP_ID, 'm_retry')).toBe(false);
    expect(__vcMeetingAgentTest.sessionCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(300);

    expect(triggerWorkflowFromEnvelopeMock).toHaveBeenCalledTimes(2);
  });
});
