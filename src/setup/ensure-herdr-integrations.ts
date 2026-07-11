/**
 * Install herdr agent integrations for the CLI adapters configured in
 * bots.json. herdr integrations are official hooks/plugins that report
 * semantic agent state (working/blocked/idle/done) back to herdr — without
 * them, herdr falls back to screen heuristics, which are noisier.
 *
 * Per user decision in setup, we only install integrations for CLIs that
 * the current `bots.json` actually uses. Mappings come from
 * https://herdr.dev/docs/integrations/ (claude/codex/opencode/hermes are
 * the ones with botmux adapter equivalents). TraeX is not built into herdr
 * upstream yet; optional TraeX plugin bootstrap is dashboard/env opt-in and
 * uses an operator-supplied plugin spec. The `pi`, `omp`, `qodercli` upstream
 * integrations have no botmux adapter and are not auto-installed.
 *
 * Like ensureTmux/ensureHerdr, this never throws — failures only generate
 * warnings. The caller decides whether to surface them.
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import type { CliId } from '../adapters/cli/types.js';
import { resolveHerdrTraexPluginConfig } from '../config.js';

/**
 * Map botmux CliId → herdr integration name. CLIs with no upstream
 * integration are intentionally absent (we won't try to install them).
 * `codex-app` shares the same `~/.codex` config as `codex`, so they
 * dedupe to the same `codex` install.
 */
const CLI_TO_HERDR_INTEGRATION: Partial<Record<CliId, string>> = {
  'claude-code': 'claude',
  'codex': 'codex',
  'codex-app': 'codex',
  'opencode': 'opencode',
  'hermes': 'hermes',
};

const TRAEX_PLUGIN_ID = 'com.traex.herdr-integration';

function traexPluginInstallCommand(spec: string): string {
  return `herdr plugin install ${spec} --yes && herdr plugin action invoke ${TRAEX_PLUGIN_ID}.install`;
}

/**
 * Author-recommended community plugin source for the TraeX↔herdr integration.
 * Surfaced in the dashboard ONLY as a one-click suggestion the operator must
 * actively select — it is NEVER a silent default and is NEVER auto-installed.
 * botmux ships no default `spec`; operators should verify (and preferably pin)
 * the source before enabling it. Empty string ⇒ no recommendation offered.
 */
export const TRAEX_RECOMMENDED_SPEC = 'Phoobobo/herdr-traex-integration';

export interface HerdrIntegrationResult {
  /** Integrations we attempted (after dedup + filtering by available CLIs). */
  attempted: string[];
  /** Newly installed during this run. */
  installed: string[];
  /** Already-present integrations we skipped. */
  alreadyInstalled: string[];
  /** Integrations whose `herdr integration install` returned non-zero. */
  failed: { name: string; reason: string; manualCommand?: string }[];
  /** TraeX herdr plugin status, when a herdr+traex bot exists. */
  traexPlugin?: {
    attempted: boolean;
    enabled: boolean;
    spec?: string;
    installed: boolean;
    alreadyInstalled: boolean;
    actionInvoked: boolean;
    skippedReason?: 'disabled' | 'missing_spec';
    failed?: { step: 'install' | 'action'; reason: string; manualCommand: string };
  };
  /** CliIds in bots.json that have no upstream herdr integration mapping. */
  unsupportedCliIds: CliId[];
}

/**
 * Read `herdr integration status` and parse out which integrations are
 * already installed. Output format from herdr varies across versions, so
 * we use a forgiving line-based regex: any line containing the integration
 * name plus a clear "installed" / "version N" marker counts as installed.
 *
 * Returns undefined if the command itself failed (herdr binary issue) —
 * caller should treat that as "unknown" and attempt install anyway; herdr
 * itself short-circuits a duplicate install.
 */
function listInstalledIntegrations(): Set<string> | undefined {
  try {
    const out = execSync('herdr integration status', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    const installed = new Set<string>();
    for (const line of out.split('\n')) {
      const lower = line.toLowerCase();
      // Match e.g. "claude  installed (version 4)" or "codex: version 4 installed"
      // Be forgiving: presence of integration name + "version" or "installed" suffices.
      for (const name of new Set(Object.values(CLI_TO_HERDR_INTEGRATION))) {
        if (!name) continue;
        if (lower.includes(name) && (lower.includes('installed') || /version\s*\d+/.test(lower))) {
          installed.add(name);
        }
      }
    }
    return installed;
  } catch {
    return undefined;
  }
}

function spawnHerdr(args: string[], timeout = 60_000): { ok: true; stdout: string } | { ok: false; reason: string; stdout: string } {
  const result = spawnSync('herdr', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    encoding: 'utf-8',
  });
  const stderr = (result.stderr ?? '').toString().trim();
  const stdout = (result.stdout ?? '').toString().trim();
  if (result.status === 0) return { ok: true, stdout };
  return {
    ok: false,
    reason: stderr || stdout || (result.error ? String(result.error.message ?? result.error) : `exit ${result.status}`),
    stdout,
  };
}

function installSingleIntegration(name: string): { ok: true } | { ok: false; reason: string } {
  const result = spawnHerdr(['integration', 'install', name]);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

/**
 * Async sibling of `spawnHerdr`. The TraeX plugin path uses this (not the sync
 * `spawnSync`) so it can also run live from the dashboard's settings-write
 * handler without blocking the daemon event loop for up to 120s during a
 * `herdr plugin install`. Never rejects — resolves an ok/err discriminated
 * union just like `spawnHerdr`.
 */
function spawnHerdrAsync(args: string[], timeout = 60_000): Promise<{ ok: true; stdout: string } | { ok: false; reason: string; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: { ok: true; stdout: string } | { ok: false; reason: string; stdout: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('herdr', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ ok: false, reason: `timeout after ${timeout}ms`, stdout: stdout.trim() });
    }, timeout);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => done({ ok: false, reason: String((err as any)?.message ?? err), stdout: stdout.trim() }));
    child.on('close', (code) => {
      const out = stdout.trim();
      if (code === 0) return done({ ok: true, stdout: out });
      done({ ok: false, reason: stderr.trim() || out || `exit ${code}`, stdout: out });
    });
  });
}

function pluginsArrayFromJson(parsed: any): any[] | undefined {
  if (Array.isArray(parsed?.result?.plugins)) return parsed.result.plugins;
  if (Array.isArray(parsed?.plugins)) return parsed.plugins;
  if (Array.isArray(parsed?.data?.plugins)) return parsed.data.plugins;
  if (Array.isArray(parsed)) return parsed;
  return undefined;
}

async function isTraexPluginInstalled(): Promise<boolean> {
  const result = await spawnHerdrAsync(['plugin', 'list', '--json'], 5000);
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    const plugins = pluginsArrayFromJson(parsed);
    if (plugins) {
      return plugins.some((p: any) =>
        p?.plugin_id === TRAEX_PLUGIN_ID || p?.id === TRAEX_PLUGIN_ID || p?.name === TRAEX_PLUGIN_ID,
      );
    }
    return result.stdout.includes(TRAEX_PLUGIN_ID);
  } catch {
    return result.stdout.includes(TRAEX_PLUGIN_ID);
  }
}

/**
 * Install/verify the TraeX herdr plugin for an already-resolved, non-empty
 * operator-supplied spec. Async so it can run both at startup (awaited by
 * ensureHerdrIntegrations) and live from the dashboard settings-write handler.
 * Idempotent: if the plugin is already installed we skip both the install and
 * the install action (never re-runs the ~/.trae hook writer on every call).
 */
export async function installTraexPluginNow(spec: string): Promise<NonNullable<HerdrIntegrationResult['traexPlugin']>> {
  const trimmed = spec.trim();
  if (!trimmed) {
    return { attempted: false, enabled: true, installed: false, alreadyInstalled: false, actionInvoked: false, skippedReason: 'missing_spec' };
  }

  const manualCommand = traexPluginInstallCommand(trimmed);
  const alreadyInstalled = await isTraexPluginInstalled();
  if (alreadyInstalled) {
    return { attempted: true, enabled: true, spec: trimmed, installed: false, alreadyInstalled: true, actionInvoked: false };
  }

  console.log(`   安装 herdr TraeX plugin: ${trimmed}`);
  const install = await spawnHerdrAsync(['plugin', 'install', trimmed, '--yes'], 120_000);
  if (!install.ok) {
    return {
      attempted: true, enabled: true, spec: trimmed, installed: false, alreadyInstalled: false, actionInvoked: false,
      failed: { step: 'install', reason: install.reason, manualCommand },
    };
  }

  const action = await spawnHerdrAsync(['plugin', 'action', 'invoke', `${TRAEX_PLUGIN_ID}.install`], 60_000);
  if (!action.ok) {
    return {
      attempted: true, enabled: true, spec: trimmed, installed: true, alreadyInstalled: false, actionInvoked: false,
      failed: { step: 'action', reason: action.reason, manualCommand },
    };
  }

  return { attempted: true, enabled: true, spec: trimmed, installed: true, alreadyInstalled: false, actionInvoked: true };
}

/**
 * Live (dashboard) path: when a settings-write flips the TraeX plugin config,
 * install immediately instead of waiting for the next daemon restart. Returns
 * undefined (no-op) unless the write actually touched `herdrTraexPlugin` AND
 * the resolved config is enabled with a non-empty spec — so unrelated settings
 * writes never trigger an install, and enabling without a spec stays a no-op
 * (the UI surfaces the required-spec hint). `installFn` is injectable for tests.
 */
export async function maybeInstallTraexPluginOnSettingsChange(
  patchTouchedHerdrTraex: boolean,
  resolved: { enabled: boolean; spec: string } | undefined,
  installFn: (spec: string) => Promise<NonNullable<HerdrIntegrationResult['traexPlugin']>> = installTraexPluginNow,
): Promise<NonNullable<HerdrIntegrationResult['traexPlugin']> | undefined> {
  if (!patchTouchedHerdrTraex) return undefined;
  if (!resolved?.enabled || !resolved.spec.trim()) return undefined;
  return installFn(resolved.spec);
}

/**
 * Startup path: resolve the opt-in config (default OFF + operator-supplied
 * spec, no botmux default source), then delegate to installTraexPluginNow.
 */
async function ensureTraexPlugin(): Promise<NonNullable<HerdrIntegrationResult['traexPlugin']>> {
  const cfg = resolveHerdrTraexPluginConfig();
  if (!cfg.enabled) {
    return { attempted: false, enabled: false, installed: false, alreadyInstalled: false, actionInvoked: false, skippedReason: 'disabled' };
  }
  if (!cfg.spec) {
    return { attempted: false, enabled: true, installed: false, alreadyInstalled: false, actionInvoked: false, skippedReason: 'missing_spec' };
  }
  return installTraexPluginNow(cfg.spec);
}

/**
 * Install herdr integrations for the given CLI ids. Caller is responsible
 * for ensuring `herdr` itself is on PATH first (use ensureHerdr).
 *
 * @param cliIds De-duped CliIds collected from bots.json. Order doesn't
 *               matter; we map → herdr integration → de-dup again before
 *               touching the filesystem.
 */
export async function ensureHerdrIntegrations(cliIds: Iterable<CliId>): Promise<HerdrIntegrationResult> {
  const seenCli = new Set<CliId>(cliIds);
  const unsupportedCliIds: CliId[] = [];
  const targetIntegrations = new Set<string>();
  const wantsTraex = seenCli.has('traex');
  for (const cli of seenCli) {
    if (cli === 'traex') continue; // handled by the community plugin path below.
    const integration = CLI_TO_HERDR_INTEGRATION[cli];
    if (!integration) {
      unsupportedCliIds.push(cli);
      continue;
    }
    targetIntegrations.add(integration);
  }

  const result: HerdrIntegrationResult = {
    attempted: [...targetIntegrations].sort(),
    installed: [],
    alreadyInstalled: [],
    failed: [],
    unsupportedCliIds,
  };

  if (wantsTraex) result.traexPlugin = await ensureTraexPlugin();
  if (targetIntegrations.size === 0) return result;

  const alreadyInstalled = listInstalledIntegrations();

  for (const name of result.attempted) {
    if (alreadyInstalled?.has(name)) {
      result.alreadyInstalled.push(name);
      continue;
    }
    console.log(`   安装 herdr integration: ${name}`);
    const r = installSingleIntegration(name);
    if (r.ok) {
      result.installed.push(name);
    } else {
      result.failed.push({ name, reason: r.reason, manualCommand: `herdr integration install ${name}` });
    }
  }

  return result;
}
