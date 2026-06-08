import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktopPetSnapshot, buildDesktopPetSnapshotWithBotmuxStatus } from './snapshot.js';
import { desktopPetCookieName, startDesktopPetServer } from './server.js';

export type DesktopPetLaunchMode = 'native' | 'browser' | 'none';

export interface DesktopPetLaunchModeInput {
  platform?: NodeJS.Platform;
  browserMode: boolean;
  noOpen: boolean;
}

export async function runDesktopPetCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'help';
  switch (sub) {
    case 'start':
      await runDesktopPetStart(args.slice(1));
      return;
    case 'snapshot':
      console.log(JSON.stringify(buildDesktopPetSnapshot(), null, 2));
      return;
    case 'help':
    case '--help':
    case '-h':
      printDesktopPetUsage();
      return;
    default:
      console.error(`unknown desktop-pet subcommand: ${sub}`);
      printDesktopPetUsage();
      process.exit(1);
  }
}

function printDesktopPetUsage(): void {
  console.log(`botmux desktop-pet — local native desktop pet

Usage:
  botmux desktop-pet start [--browser|--no-open]
  botmux desktop-pet snapshot

Notes:
  - This path does not require an Apple developer account.
  - On macOS, start opens a native transparent WebKit panel like Kaboo.
  - --browser falls back to a normal browser app window.
  - The standard Codex pet rows are preserved; nine template actions are
    appended as rows 9-17 with 8 frames each.
`);
}

async function runDesktopPetStart(args: string[]): Promise<void> {
  const noOpen = args.includes('--no-open');
  const browserMode = args.includes('--browser');
  const launchMode = chooseDesktopPetLaunchMode({ platform: process.platform, browserMode, noOpen });
  let closeRequested = false;
  const server = await startDesktopPetServer({
    snapshot: () => buildDesktopPetSnapshotWithBotmuxStatus(),
    quit: () => {
      closeRequested = true;
      void server.close().finally(() => process.exit(0));
    },
  });

  console.log('botmux desktop pet starting...');
  console.log(`Native URL: ${server.url}`);
  console.log(`Browser fallback URL: ${server.browserUrl}`);
  console.log('Press Ctrl+C to stop.');

  let nativeChild: ChildProcess | null = null;
  if (launchMode === 'native') {
    try {
      nativeChild = runNativeMacPet(server.url, server.token);
    } catch (err) {
      console.error(`Native desktop pet failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Falling back to browser app window. Pass --browser to use this path directly.');
      openBrowserApp(server.browserUrl);
    }
  } else if (launchMode === 'browser') {
    const opened = openBrowserApp(server.browserUrl);
    if (!opened) {
      console.log('Could not auto-open a browser app window. Open the URL above manually.');
    }
  }

  const stop = async () => {
    if (closeRequested) return;
    closeRequested = true;
    if (nativeChild && !nativeChild.killed) nativeChild.kill('SIGTERM');
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  if (nativeChild) {
    await new Promise<void>((resolve) => {
      nativeChild?.once('exit', () => resolve());
    });
    await stop();
    return;
  }
  await new Promise<void>(() => {});
}

export function chooseDesktopPetLaunchMode(input: DesktopPetLaunchModeInput): DesktopPetLaunchMode {
  if (input.noOpen) return 'none';
  if (input.platform === 'darwin' && !input.browserMode) return 'native';
  return 'browser';
}

function runNativeMacPet(url: string, token: string): ChildProcess {
  const helper = ensureNativeMacHelper();
  const child = spawn(helper, [
    '--url', url,
    '--cookie-name', desktopPetCookieName,
    '--cookie-value', token,
  ], {
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

function ensureNativeMacHelper(): string {
  const source = fileURLToPath(new URL('./native/botmux_desktop_pet_window_darwin.m', import.meta.url));
  if (!existsSync(source)) throw new Error(`native helper source not found: ${source}`);
  const outDir = join(homedir(), '.botmux', 'desktop-pet');
  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, 'botmux-desktop-pet-window');
  const moduleCache = join(outDir, 'clang-module-cache');
  const needsBuild = !existsSync(output) || statSync(output).mtimeMs < statSync(source).mtimeMs;
  if (!needsBuild) return output;
  mkdirSync(moduleCache, { recursive: true });

  const clang = resolveClangInvocation();
  const result = spawnSync(clang.command, [
    ...clang.args,
    '-x', 'objective-c',
    '-fobjc-arc',
    '-fmodules',
    `-fmodules-cache-path=${moduleCache}`,
    '-framework', 'Cocoa',
    '-framework', 'WebKit',
    source,
    '-o', output,
  ], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(detail || `clang exited with status ${result.status}`);
  }
  return output;
}

function resolveClangInvocation(): { command: string; args: string[] } {
  if (existsSync('/usr/bin/xcrun')) {
    return { command: '/usr/bin/xcrun', args: ['--sdk', 'macosx', 'clang'] };
  }
  return { command: '/usr/bin/clang', args: [] };
}

export function openBrowserApp(url: string): boolean {
  if (process.platform === 'darwin') {
    const chrome = '/Applications/Google Chrome.app';
    if (existsSync(chrome)) {
      spawn('open', ['-na', 'Google Chrome', '--args', `--app=${url}`], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return true;
    }
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  const command = process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
