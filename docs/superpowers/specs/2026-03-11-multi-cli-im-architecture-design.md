# Multi-CLI / Multi-IM Architecture Design

Date: 2026-03-11

## Context

claude-code-robot bridges Lark (Feishu) group threads to CLI coding agents via PTY.
It currently supports Claude Code, Aiden, and partially CoCo (Trae), but CLI-specific
logic is scattered across `daemon.ts` (1498 lines) and `worker.ts` with if/else chains.
Lark is hardcoded throughout with no abstraction. Adding a new CLI or IM requires
touching multiple files.

## Goals

1. **CLI adapter layer** — adding a new CLI tool (CoCo, Codex, future tools) means
   adding one adapter file, not touching core logic.
2. **Session backend abstraction** — support node-pty (default) and tmux (optional)
   so physical terminal, web terminal, and IM messages can all connect to the same session.
3. **IM-ready core** — design the session/worker core to be IM-agnostic. Define the
   ImAdapter interface now, implement only Lark. Future IMs (Slack, Discord) require
   adding an adapter, not rewriting core logic.
4. **Decompose daemon.ts** — split the 1498-line monolith into focused modules by
   responsibility.
5. **Incremental migration** — every step runs and can be verified on master. No big
   bang rewrites.

## Non-Goals

- Implementing a second IM adapter (Slack, etc.) — only the interface is defined.
- TmuxBackend full implementation — only a stub + interface.
- Pipe/headless mode (`--print`) — out of scope for now, can be added as a backend later.

---

## Core Abstractions

### 1. CliAdapter — CLI Tool Adapter

```typescript
// src/adapters/cli/types.ts

interface PtyHandle {
  write(data: string): void;
}

interface CliAdapter {
  /** Unique identifier: 'claude-code' | 'aiden' | 'coco' | 'codex' */
  id: string;

  /** Build spawn arguments for the CLI */
  buildArgs(opts: {
    sessionId: string;
    resume: boolean;
    workingDir: string;
  }): { bin: string; args: string[] };

  /** Write user input to PTY, handling CLI-specific paste behavior */
  writeInput(pty: PtyHandle, content: string): void;

  /** MCP server config: where to register and in what format */
  mcpConfig: {
    path: string;              // e.g. ~/.claude.json
    format: 'json' | 'toml';
    key: string;               // JSON path to mcpServers object
  };

  /** Additional completion marker regex (beyond generic quiescence) */
  completionPattern?: RegExp;

  /** Whether the CLI uses alternate screen buffer */
  altScreen: boolean;
}
```

Each CLI gets its own file exporting a `CliAdapter` object:

| CLI | File | Key differences |
|-----|------|-----------------|
| Claude Code | `claude-code.ts` | `--session-id`, `--dangerously-skip-permissions`, `content\r` input |
| Aiden | `aiden.ts` | `--permission-mode agentFull`, delayed `\r` for paste |
| CoCo | `coco.ts` | `--session-id`, `--yolo`, standard input (TBD) |
| Codex | `codex.ts` | `codex` subcommand pattern, `--yolo`, alt-screen |

### 2. SessionBackend — PTY / tmux Abstraction

```typescript
// src/adapters/backend/types.ts

interface SpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

interface SessionBackend {
  spawn(bin: string, args: string[], opts: SpawnOpts): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;

  /** Attach info for external clients (tmux session name, etc.) */
  getAttachInfo?(): { type: 'tmux'; sessionName: string } | null;
}
```

Two implementations:
- **PtyBackend** — wraps current node-pty logic. Default, zero external dependencies.
- **TmuxBackend** — wraps `tmux new-session` / `send-keys` / `capture-pane`.
  Enables: physical `tmux attach`, web terminal, and Lark all connected to the same
  session. Stub in Phase 7, full implementation later.

### 3. ImAdapter — IM Platform Interface

```typescript
// src/im/types.ts

interface ImMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: 'user' | 'bot';
  content: string;
  msgType: string;
  attachments?: ImAttachment[];
  createTime: string;
}

interface ImAttachment {
  type: 'image' | 'file';
  path: string;
  name: string;
}

interface ImUser {
  id: string;           // platform-specific user ID
  identifier: string;   // original input (email prefix, open_id, etc.)
}

interface ImCard {
  /** Opaque card payload — built by IM-specific card builder */
  payload: unknown;
}

interface ImEventHandler {
  onNewTopic(msg: ImMessage, chatId: string, chatType: 'group' | 'p2p'): Promise<void>;
  onThreadReply(msg: ImMessage, threadId: string): Promise<void>;
  onCardAction(action: ImCardAction): Promise<void>;
}

interface ImCardAction {
  actionType: string;
  threadId: string;
  operatorId?: string;
  value?: Record<string, unknown>;
}

interface ImAdapter {
  start(handler: ImEventHandler): Promise<void>;
  stop(): Promise<void>;

  sendMessage(threadId: string, content: string, format: 'text' | 'rich'): Promise<string>;
  replyMessage(messageId: string, content: string, format: 'text' | 'rich'): Promise<string>;
  updateMessage(messageId: string, content: string): Promise<void>;
  sendCard(threadId: string, card: ImCard): Promise<string>;
  updateCard(messageId: string, card: ImCard): Promise<void>;

  resolveUsers(identifiers: string[]): Promise<ImUser[]>;
  sendDirectMessage(userId: string, content: string): Promise<void>;

  downloadAttachment(messageId: string, resourceKey: string): Promise<string>;
  getThreadMessages(threadId: string, limit: number): Promise<ImMessage[]>;

  /** Get bot's own user ID (for filtering self-messages) */
  getBotUserId(): string | undefined;
}
```

Only `LarkImAdapter` is implemented. Core modules depend on `ImAdapter`, never on
Lark-specific types directly.

---

## Directory Structure

```
src/
  adapters/
    cli/
      types.ts              # CliAdapter interface
      registry.ts           # id -> adapter mapping + factory + ensureMcpConfig
      claude-code.ts
      aiden.ts
      coco.ts
      codex.ts              # stub
    backend/
      types.ts              # SessionBackend interface
      pty-backend.ts        # node-pty implementation
      tmux-backend.ts       # stub (future)
  im/
    types.ts                # ImAdapter + ImEventHandler + ImMessage interfaces
    lark/
      adapter.ts            # LarkImAdapter implements ImAdapter
      client.ts             # Lark HTTP API calls (renamed from lark-client.ts)
      event-dispatcher.ts   # Lark WSClient + event routing
      card-builder.ts       # Lark card JSON generation
      card-handler.ts       # Card button interaction logic
      message-parser.ts     # Lark event -> ImMessage normalization
  core/
    session-manager.ts      # Session CRUD, activeSessions Map, topic/reply handling
    worker-pool.ts          # Worker fork, IPC, restart, double-fork guard
    command-handler.ts      # /close /status /cost /schedule daemon commands
    scheduler.ts            # Cron task management (moved from src/)
  tools/
    index.ts                # MCP tool registry
    send-to-thread.ts       # MCP tool: send message (uses ImAdapter in Phase 6)
    get-thread-messages.ts
    react-to-message.ts
  services/
    session-store.ts        # unchanged
    schedule-store.ts       # unchanged
    message-queue.ts        # unchanged
    project-scanner.ts      # unchanged
  utils/
    logger.ts               # unchanged
    terminal-renderer.ts    # unchanged
    idle-detector.ts        # new: extracted from worker.ts onPtyData
  worker.ts                 # uses CliAdapter + SessionBackend
  daemon.ts                 # thin entry: load config, wire modules, start
  config.ts                 # adds cliId, backendType
  types.ts                  # shared types + IPC message definitions
  index.ts                  # MCP server entry (unchanged)
  index-daemon.ts           # daemon entry (unchanged)
  cli.ts                    # CLI commands (unchanged)
```

### daemon.ts decomposition mapping

| Current daemon.ts content | Moves to |
|---------------------------|----------|
| `activeSessions` Map, session create/close/restore | `core/session-manager.ts` |
| `forkWorker()`, IPC handling, restart logic | `core/worker-pool.ts` |
| Lark WSClient, `im.message.receive_v1` dispatch | `im/lark/event-dispatcher.ts` |
| `card.action.trigger` handling | `im/lark/card-handler.ts` |
| `buildSessionCard()` etc. | `im/lark/card-builder.ts` |
| `/close`, `/status`, `/cost` commands | `core/command-handler.ts` |
| `buildNewTopicPrompt()`, permission checks | `core/session-manager.ts` |
| `ensureMcpConfig()` | `adapters/cli/registry.ts` |
| Startup/shutdown glue | `daemon.ts` (~80-100 lines) |

### Thin daemon.ts sketch

```typescript
import { config } from './config.js';
import { getCliAdapter } from './adapters/cli/registry.js';
import { LarkImAdapter } from './im/lark/adapter.js';
import { SessionManager } from './core/session-manager.js';
import { WorkerPool } from './core/worker-pool.js';
import { Scheduler } from './core/scheduler.js';

export async function startDaemon() {
  const cli = getCliAdapter(config.daemon.cliId);
  const im = new LarkImAdapter(config.lark);
  const sessions = new SessionManager(config.session);
  const workers = new WorkerPool(cli, config);
  const scheduler = new Scheduler(sessions, workers);

  await im.start({
    onNewTopic: (msg, chatId, chatType) =>
      sessions.handleNewTopic(msg, chatId, chatType, workers, im),
    onThreadReply: (msg, threadId) =>
      sessions.handleThreadReply(msg, threadId, workers, im),
    onCardAction: (action) =>
      sessions.handleCardAction(action, workers, im),
  });

  scheduler.start();
  // graceful shutdown handlers...
}
```

---

## Worker Refactoring

### CliAdapter usage in worker

Worker receives `cliId` and `backendType` via IPC init message, resolves the
adapter from the registry, and delegates all CLI-specific behavior:

```typescript
// Spawn
const { bin, args } = cli.buildArgs({ sessionId, resume, workingDir });
backend.spawn(bin, args, { cwd, cols, rows, env });

// Input
cli.writeInput(backend, content);  // adapter handles paste quirks

// Idle detection
const detector = new IdleDetector(cli);
backend.onData((data) => {
  detector.feed(data);
  // ... broadcast to WS, scrollback, etc.
});
detector.onIdle(() => markPromptReady());
```

### IPC protocol changes

Only the `init` message changes:

```typescript
type DaemonToWorker =
  | { type: 'init';
      sessionId: string;
      chatId: string;
      rootMessageId: string;
      workingDir: string;
      cliId: string;            // replaces claudePath
      backendType: 'pty' | 'tmux';  // new
      prompt: string;
      resume?: boolean;
      ownerOpenId?: string;
    }
  | { type: 'message'; content: string }
  | { type: 'close' }
  | { type: 'restart' }
```

WorkerToDaemon messages are unchanged.

### IdleDetector extraction

```typescript
// src/utils/idle-detector.ts

class IdleDetector {
  constructor(cli: CliAdapter);

  /** Feed PTY output data for analysis */
  feed(data: string): void;

  /** Register idle callback */
  onIdle(cb: () => void): void;

  /** Reset state (call when new input is sent) */
  reset(): void;

  /** Cleanup timers */
  dispose(): void;
}
```

Internally manages: quiescence timer, spinner tracking, CLI-specific completion
pattern matching. All the logic currently in `onPtyData()` related to idle detection
moves here.

---

## CLI Adapter Details

### writeInput implementations

| CLI | Behavior |
|-----|----------|
| Claude Code | `pty.write(content + '\r')` |
| Aiden | `pty.write(content)` → 200ms delay → `pty.write('\r')` → if multiline: 200ms → `pty.write('\r')` |
| CoCo | `pty.write(content + '\r')` (to be verified) |
| Codex | `pty.write(content + '\r')` (alt-screen handling TBD) |

### MCP config locations

| CLI | Path | Format |
|-----|------|--------|
| Claude Code | `~/.claude.json` | JSON, key `mcpServers` |
| Aiden | `~/.aiden/.mcp.json` | JSON, key `mcpServers` |
| CoCo | `~/.trae/.mcp.json` | JSON, key `mcpServers` |
| Codex | `~/.codex/config.toml` | TOML, section `[mcp_servers]` |

### Spawn args

| CLI | New session | Resume | Permission bypass |
|-----|-------------|--------|-------------------|
| Claude Code | `--session-id <id>` | `--resume <id>` | `--dangerously-skip-permissions` |
| Aiden | (auto) | `--resume <id>` | `--permission-mode agentFull` |
| CoCo | `--session-id <id>` | `--resume <id>` | `--yolo` |
| Codex | (auto) | `codex resume <id>` | `--yolo` |

---

## Migration Plan

Incremental on master, 7 phases. Each phase produces runnable code.

### Phase 1: Extract CliAdapter interface + implementations
- New files: `adapters/cli/types.ts`, `registry.ts`, `claude-code.ts`, `aiden.ts`,
  `coco.ts`, `codex.ts`
- Pure additions, no existing code modified.

### Phase 2: Extract SessionBackend interface + PtyBackend
- New files: `adapters/backend/types.ts`, `pty-backend.ts`
- Pure additions, no existing code modified.

### Phase 3: Worker switches to adapters
- Refactor `worker.ts`: remove `detectCliKind()` and inline if/else chains.
  Use CliAdapter + PtyBackend.
- Extract `utils/idle-detector.ts` from `onPtyData()` logic.
- IPC `init` message adds `cliId`, `backendType`.
- `config.ts` adds `cliId` config.
- **Verify**: build + restart, test Claude Code and Aiden sessions via Lark.

### Phase 4: Define ImAdapter + decompose daemon.ts core
- New file: `im/types.ts` (ImAdapter interface).
- Extract from daemon.ts: `core/session-manager.ts`, `core/worker-pool.ts`,
  `core/command-handler.ts`.
- Move `scheduler.ts` → `core/scheduler.ts`.
- daemon.ts becomes thin entry (~80-100 lines).
- **Verify**: functionality unchanged, code is reorganized.

### Phase 5: Extract Lark layer
- Extract: `im/lark/event-dispatcher.ts`, `im/lark/card-handler.ts`.
- Move: `lark-client.ts` → `im/lark/client.ts`,
  `card-builder.ts` → `im/lark/card-builder.ts`,
  `message-parser.ts` → `im/lark/message-parser.ts`.
- New: `im/lark/adapter.ts` (LarkImAdapter).
- **Verify**: build + restart, full regression.

### Phase 6: MCP tools use ImAdapter
- MCP tools call ImAdapter methods instead of importing lark client directly.
- MCP server process instantiates the correct IM adapter from config.
- **Verify**: send_to_thread, get_thread_messages, react_to_message all work.

### Phase 7: CoCo full support + TmuxBackend stub
- Complete `coco.ts` adapter (verify spawn args, input, idle detection).
- New: `adapters/backend/tmux-backend.ts` (implements SessionBackend, experimental).
- Config supports `BACKEND_TYPE=tmux`.
- Update documentation.

### Phase dependencies

```
Phase 1 (cli adapters) ──┐
Phase 2 (backend)     ───┼──> Phase 3 (worker) ──> Phase 4 (core split)
                                                       ──> Phase 5 (lark split)
                                                           ──> Phase 6 (mcp tools)
                                                               ──> Phase 7 (coco + tmux)
```

Phase 1 and 2 are independent and can be done in parallel.

---

## Config Changes

```env
# .env additions
CLI_ID=claude-code          # claude-code | aiden | coco | codex
BACKEND_TYPE=pty             # pty | tmux (default: pty)
```

```typescript
// config.ts additions
daemon: {
  cliId: process.env.CLI_ID ?? 'claude-code',
  backendType: (process.env.BACKEND_TYPE ?? 'pty') as 'pty' | 'tmux',
  // claudePath removed — CLI adapter resolves binary path internally
}
```

`CLAUDE_PATH` is kept as an optional override: if set, the resolved CLI adapter
uses it instead of its default binary name.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| daemon.ts split introduces subtle bugs | Each phase verified with build + restart + Lark test |
| Import path changes break MCP server | Phase 6 is isolated; MCP server is a separate entry point |
| CoCo PTY behavior differs from assumed | coco.ts adapter is verified empirically in Phase 7 |
| Codex alt-screen breaks terminal renderer | Codex adapter is a stub; full support deferred until tested |
| TmuxBackend complexity | Stub only in Phase 7; full implementation is a separate project |
