import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { globalConfigPath } from '../src/global-config.js';

// The TraeX plugin path uses async `spawn` (so install-now can run live from the
// dashboard without blocking the daemon event loop); the official-integration
// path still uses `spawnSync`/`execSync` (unused in these traex-only tests).
const spawn = vi.fn();
const spawnSync = vi.fn();
const execSync = vi.fn();

vi.mock('node:child_process', () => ({ spawn, spawnSync, execSync }));

/** Fake ChildProcess that emits its configured output once listeners attach. */
function makeChild(result: { stdout?: string; stderr?: string; code?: number; error?: Error }) {
  const c: any = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  // setImmediate fires after spawnHerdrAsync has synchronously attached its
  // stdout/stderr/close/error listeners.
  setImmediate(() => {
    if (result.error) { c.emit('error', result.error); return; }
    if (result.stdout != null) c.stdout.emit('data', Buffer.from(result.stdout));
    if (result.stderr != null) c.stderr.emit('data', Buffer.from(result.stderr));
    c.emit('close', result.code ?? 0);
  });
  return c;
}

/** Make `spawn` return the given results in call order (last repeats). */
function queueSpawn(...results: Array<Parameters<typeof makeChild>[0]>) {
  let i = 0;
  spawn.mockImplementation(() => makeChild(results[Math.min(i++, results.length - 1)] ?? { code: 0 }));
}

const LIST_EMPTY = { stdout: '{"result":{"plugins":[]}}', code: 0 };
const INSTALL_OK = { stdout: 'installed', code: 0 };
const ACTION_OK = { stdout: 'hooks written', code: 0 };

async function loadSubject() {
  vi.resetModules();
  return import('../src/setup/ensure-herdr-integrations.js');
}

describe('ensureHerdrIntegrations TraeX plugin opt-in', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-herdr-int-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', '');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', '');
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    spawn.mockReset();
    spawnSync.mockReset();
    execSync.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('does not install anything for traex unless the global opt-in is enabled', async () => {
    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({ attempted: false, enabled: false, skippedReason: 'disabled' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('requires an operator-supplied plugin spec when enabled', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({ attempted: false, enabled: true, skippedReason: 'missing_spec' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('installs the configured spec and invokes install action only after a fresh install', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    queueSpawn(LIST_EMPTY, INSTALL_OK, ACTION_OK);

    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({
      attempted: true, enabled: true, spec: 'trusted/repo#v1',
      installed: true, alreadyInstalled: false, actionInvoked: true,
    });
    expect(spawn).toHaveBeenNthCalledWith(2, 'herdr', ['plugin', 'install', 'trusted/repo#v1', '--yes'], expect.any(Object));
    expect(spawn).toHaveBeenNthCalledWith(3, 'herdr', ['plugin', 'action', 'invoke', 'com.traex.herdr-integration.install'], expect.any(Object));
  });

  it('skips install and action when the plugin is already installed (top-level JSON shape)', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    queueSpawn({ stdout: '{"plugins":[{"id":"com.traex.herdr-integration"}]}', code: 0 });

    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin).toMatchObject({ attempted: true, installed: false, alreadyInstalled: true, actionInvoked: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('falls back to substring detection when plugin-list JSON shape is unknown', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    queueSpawn({ stdout: '{"unexpected":"com.traex.herdr-integration"}', code: 0 });

    const { ensureHerdrIntegrations } = await loadSubject();
    const result = await ensureHerdrIntegrations(['traex']);

    expect(result.traexPlugin?.alreadyInstalled).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports install and action failures with a manual command using the configured spec', async () => {
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_ENABLED', 'true');
    vi.stubEnv('BOTMUX_HERDR_TRAEX_PLUGIN_SPEC', 'trusted/repo#v1');
    queueSpawn(LIST_EMPTY, { stderr: 'network', code: 1 });

    const { ensureHerdrIntegrations } = await loadSubject();
    const installFail = await ensureHerdrIntegrations(['traex']);
    expect(installFail.traexPlugin?.failed).toMatchObject({
      step: 'install',
      reason: 'network',
      manualCommand: 'herdr plugin install trusted/repo#v1 --yes && herdr plugin action invoke com.traex.herdr-integration.install',
    });

    spawn.mockReset();
    queueSpawn(LIST_EMPTY, INSTALL_OK, { stderr: 'action boom', code: 1 });
    const actionFail = await ensureHerdrIntegrations(['traex']);
    expect(actionFail.traexPlugin?.failed).toMatchObject({ step: 'action', reason: 'action boom' });
  });
});

describe('installTraexPluginNow (live install)', () => {
  beforeEach(() => { spawn.mockReset(); });

  it('installs a fresh plugin and invokes the install action', async () => {
    queueSpawn(LIST_EMPTY, INSTALL_OK, ACTION_OK);
    const { installTraexPluginNow } = await loadSubject();
    const r = await installTraexPluginNow('  trusted/repo#v1  '); // trims
    expect(r).toMatchObject({ spec: 'trusted/repo#v1', installed: true, alreadyInstalled: false, actionInvoked: true });
  });

  it('is a no-op skip when the spec is blank', async () => {
    const { installTraexPluginNow } = await loadSubject();
    const r = await installTraexPluginNow('   ');
    expect(r).toMatchObject({ attempted: false, skippedReason: 'missing_spec' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips install when already present', async () => {
    queueSpawn({ stdout: '{"result":{"plugins":[{"plugin_id":"com.traex.herdr-integration"}]}}', code: 0 });
    const { installTraexPluginNow } = await loadSubject();
    const r = await installTraexPluginNow('trusted/repo#v1');
    expect(r).toMatchObject({ alreadyInstalled: true, actionInvoked: false });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('maybeInstallTraexPluginOnSettingsChange', () => {
  it('installs only when the write touched herdrTraexPlugin AND it is enabled with a spec', async () => {
    const { maybeInstallTraexPluginOnSettingsChange } = await loadSubject();
    const installFn = vi.fn(async (spec: string) => ({
      attempted: true, enabled: true, spec, installed: true, alreadyInstalled: false, actionInvoked: true,
    }));

    // untouched patch → no-op
    expect(await maybeInstallTraexPluginOnSettingsChange(false, { enabled: true, spec: 'a/b' }, installFn)).toBeUndefined();
    // touched but disabled → no-op
    expect(await maybeInstallTraexPluginOnSettingsChange(true, { enabled: false, spec: 'a/b' }, installFn)).toBeUndefined();
    // touched + enabled but blank spec → no-op
    expect(await maybeInstallTraexPluginOnSettingsChange(true, { enabled: true, spec: '  ' }, installFn)).toBeUndefined();
    expect(installFn).not.toHaveBeenCalled();

    // touched + enabled + spec → installs
    const r = await maybeInstallTraexPluginOnSettingsChange(true, { enabled: true, spec: 'a/b' }, installFn);
    expect(installFn).toHaveBeenCalledWith('a/b');
    expect(r).toMatchObject({ installed: true });
  });
});
