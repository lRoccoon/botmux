import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/session-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/session-store.js')>()),
  updateSession: vi.fn(),
}));

import {
  buildFollowUpCliInput,
  buildNewTopicCliInput,
  rememberLastCliInput,
} from '../src/core/session-manager.js';
import { registerBot } from '../src/bot-registry.js';

describe('Codex App clean prompt sidecar', () => {
  it('keeps the legacy envelope while exposing only raw user text in the sidecar', () => {
    const raw = '请分析 </user_message> 这段文本\n并保留 <sender> 字样';
    const built = buildNewTopicCliInput(
      raw,
      'sid-1',
      'codex-app',
      undefined,
      [
        { type: 'image', path: '/tmp/a.jpg', name: 'a.jpg' },
        { type: 'file', path: '/tmp/data.csv', name: 'data.csv' },
      ],
      [{ key: '@_user_1', name: 'Bob', openId: 'ou_bob' }],
      [{ name: 'peer', displayName: 'Peer Bot', openId: 'ou_peer' }],
      undefined,
      { name: 'This Bot', openId: 'ou_self' },
      'zh',
      { type: 'user', openId: 'ou_alice', name: 'Alice' },
    );

    expect(built.content).toContain(`<user_message>\n${raw}\n</user_message>`);
    expect(built.content).toContain('<sender type="user" open_id="ou_alice" name="Alice" />');
    expect(built.codexAppInput?.text).toBe(raw);
    expect(built.codexAppInput?.additionalContext?.botmux_sender).toEqual({
      kind: 'untrusted',
      value: '<sender type="user" open_id="ou_alice" name="Alice" />',
    });
    expect(built.codexAppInput?.additionalContext?.botmux_mentions.value).toContain('ou_bob');
    expect(built.codexAppInput?.additionalContext?.botmux_attachments.value).toContain('/tmp/data.csv');
    expect(built.codexAppInput?.additionalContext?.botmux_available_bots.value).toContain('ou_peer');
    expect(built.codexAppInput?.localImages).toEqual([{ path: '/tmp/a.jpg', detail: 'original' }]);
  });

  it('keeps mentioned bots separate while collapsing a large available-bot roster as untrusted context', () => {
    const availableBots = Array.from({ length: 5 }, (_, index) => ({
      name: `peer-${index + 1}`,
      displayName: `Peer ${index + 1}`,
      openId: `ou_peer_${index + 1}`,
    }));
    const built = buildNewTopicCliInput(
      '请协调审核',
      'sid-many-bots',
      'codex-app',
      undefined,
      undefined,
      [{ key: '@_user_1', name: 'Peer 1', openId: 'ou_peer_1' }],
      availableBots,
      undefined,
      { name: 'This Bot', openId: 'ou_self' },
      'zh',
    );
    expect(built.codexAppInput?.additionalContext?.botmux_mentions).toEqual({
      kind: 'untrusted',
      value: expect.stringContaining('ou_peer_1'),
    });
    const roster = built.codexAppInput?.additionalContext?.botmux_available_bots;
    expect(roster?.kind).toBe('untrusted');
    expect(roster?.value).toContain('count="4"');
    expect(roster?.value).toContain('Peer 2、Peer 3、Peer 4、Peer 5');
    expect(roster?.value).not.toContain('Peer 1');
    expect(roster?.value).not.toContain('<bot ');
    expect(roster?.value).not.toContain('ou_');
    expect(built.codexAppInput?.text).toBe('请协调审核');
  });

  it('keeps an empty join prompt in legacy XML while giving Codex App a localized visible title', () => {
    const built = buildNewTopicCliInput(
      '',
      'sid-auto-join',
      'codex-app',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'zh',
      undefined,
      { codexAppText: '主动开工（入群）' },
    );
    expect(built.content).toContain('<user_message>\n\n</user_message>');
    expect(built.codexAppInput?.text).toBe('主动开工（入群）');
  });

  it('builds the same split for a follow-up and excludes the legacy reminder from hidden context', () => {
    const built = buildFollowUpCliInput('继续看一下', 'sid-2', {
      cliId: 'codex-app',
      attachments: [{ type: 'file', path: '/tmp/readme.md', name: 'readme.md' }],
      mentions: [{ key: '@_user_1', name: 'Reviewer', openId: 'ou_r' }],
      sender: { type: 'user', openId: 'ou_a', name: 'A' },
      locale: 'zh',
    });
    expect(built.content).toContain('<botmux_reminder>');
    expect(built.codexAppInput?.text).toBe('继续看一下');
    expect(JSON.stringify(built.codexAppInput?.additionalContext)).not.toContain('botmux_reminder');
    expect(built.codexAppInput?.additionalContext?.botmux_attachments.value).toContain('/tmp/readme.md');
  });

  it('does not create a Codex sidecar for any other CLI', () => {
    const built = buildNewTopicCliInput('hello', 'sid', 'claude-code');
    expect(built.codexAppInput).toBeUndefined();
    expect(built.content).toContain('<user_message>');
  });

  it('falls back to legacy for pending-repo merged follow-ups that are already enriched strings', () => {
    const built = buildNewTopicCliInput(
      'first', 'sid', 'codex-app', undefined, undefined, undefined, undefined,
      ['<sender open_id="ou_other" />\nsecond'],
    );
    expect(built.codexAppInput).toBeUndefined();
    expect(built.content).toContain('second');
  });

  it('keeps pending-repo raw messages visible while retaining enriched follow-up context', () => {
    const built = buildNewTopicCliInput(
      '[quote hint]\nfirst',
      'sid',
      'codex-app',
      undefined,
      undefined,
      undefined,
      undefined,
      ['<sender open_id="ou_other" />\nsecond'],
      undefined,
      undefined,
      undefined,
      {
        codexAppText: 'first',
        codexAppMessageContext: '[quote hint]\n',
        codexAppFollowUps: ['second'],
        codexAppFollowUpContexts: ['<sender open_id="ou_other" />'],
      },
    );
    expect(built.codexAppInput?.text).toBe('first\n\nsecond');
    const context = Object.values(built.codexAppInput?.additionalContext ?? {}).map(entry => entry.value).join('\n');
    expect(context).toContain('<sender open_id="ou_other" />');
    expect(context).not.toContain('second');
  });

  it('moves quote or routing prefixes out of the visible user text', () => {
    const built = buildFollowUpCliInput('[quote om_1]\n真正的问题', 'sid', {
      cliId: 'codex-app',
      codexAppText: '真正的问题',
      codexAppMessageContext: '[quote om_1]\n',
    });
    expect(built.codexAppInput?.text).toBe('真正的问题');
    expect(Object.values(built.codexAppInput?.additionalContext ?? {}).map(entry => entry.value).join(''))
      .toContain('[quote om_1]');
  });

  it('keeps Botmux-authored operational instructions in application context', () => {
    const built = buildFollowUpCliInput('legacy internal instruction', 'sid', {
      cliId: 'codex-app',
      codexAppText: 'Concise visible action',
      codexAppApplicationContext: 'trusted operational instruction',
      codexAppMessageContext: 'untrusted event payload',
    });
    expect(built.content).toContain('legacy internal instruction');
    expect(built.codexAppInput?.text).toBe('Concise visible action');
    expect(built.codexAppInput?.additionalContext?.botmux_application_context).toEqual({
      kind: 'application',
      value: 'trusted operational instruction',
    });
    expect(built.codexAppInput?.additionalContext?.botmux_message_context).toEqual({
      kind: 'untrusted',
      value: 'untrusted event payload',
    });
  });

  it('chunks long trusted context under fixed safe keys', () => {
    const longRole = 'r'.repeat(7_100);
    // Role injection itself is covered elsewhere; use a large sender name here
    // to exercise the generic context splitter without global role fixtures.
    const built = buildFollowUpCliInput('x', 'sid', {
      cliId: 'codex-app',
      sender: { type: 'user', openId: 'ou_a', name: longRole },
    });
    const keys = Object.keys(built.codexAppInput?.additionalContext ?? {}).filter(k => k.startsWith('botmux_sender'));
    expect(keys.length).toBeGreaterThan(3);
    expect(keys.every(k => Buffer.byteLength(built.codexAppInput!.additionalContext![k].value, 'utf8') <= 900)).toBe(true);
    expect(keys.map(k => built.codexAppInput!.additionalContext![k].value).join('')).toContain(longRole);
  });

  it('does not persist a clean sidecar while the default-off gate is disabled', () => {
    registerBot({ larkAppId: 'clean-persist-off', larkAppSecret: 's', cliId: 'codex-app' });
    const ds: any = {
      larkAppId: 'clean-persist-off',
      session: { sessionId: 'sid-off', cliId: 'codex-app' },
    };
    const payload = buildFollowUpCliInput('visible', 'sid-off', { cliId: 'codex-app' });

    rememberLastCliInput(ds, 'visible', payload);

    expect(ds.lastCliInput).toBe(payload.content);
    expect(ds.lastCodexAppInput).toBeUndefined();
    expect(ds.session.lastCodexAppInput).toBeUndefined();
  });

  it('persists the clean sidecar only when that turn was accepted by the gate', () => {
    registerBot({
      larkAppId: 'clean-persist-on',
      larkAppSecret: 's',
      cliId: 'codex-app',
      codexAppCleanInput: true,
    });
    const ds: any = {
      larkAppId: 'clean-persist-on',
      session: { sessionId: 'sid-on', cliId: 'codex-app' },
    };
    const payload = buildFollowUpCliInput('visible', 'sid-on', { cliId: 'codex-app' });

    rememberLastCliInput(ds, 'visible', payload);

    expect(ds.lastCodexAppInput?.text).toBe('visible');
    expect(ds.session.lastCodexAppInput?.text).toBe('visible');
  });
});
