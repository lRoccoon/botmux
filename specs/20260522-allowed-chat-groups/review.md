# Review: 20260522-allowed-chat-groups

**Base:** master@f7d7241113b085c91ba3ac08dcf76bfa383fa903
**Head:** 55acbc0ebc2556015eda31e6135bfb006545e2a0
**Date:** 2026-05-22

## 🟢 Passing

| Item | Status | Evidence |
|---|---|---|
| FR-1 | Covered | d3462ba, `src/bot-registry.ts:44`, `src/bot-registry.ts:260-298`, `test/bot-registry.test.ts:363-375`. |
| FR-2 | Covered | d3462ba, `src/bot-registry.ts:67`, `src/bot-registry.ts:114`, `test/bot-registry.test.ts:87-90`; group members do not mutate `resolvedAllowedUsers`. |
| FR-5 | Covered | 55acbc0, `src/im/lark/event-dispatcher.ts:486-493`, `test/event-dispatcher.test.ts:439-448`. |
| FR-6 | Covered | 55acbc0, `test/event-dispatcher.test.ts:448` calls `canTalk` with `oc_different_chat`, proving membership is not a chat whitelist. |
| FR-7 | Covered | 55acbc0, `src/im/lark/event-dispatcher.ts:496-499`, `test/event-dispatcher.test.ts:451-460`. |
| FR-8 | Covered | Existing behavior retained by `allowedUsers.length === 0` branch at `src/im/lark/event-dispatcher.ts:490`; existing suites passed: 123 tests across target files. |
| FR-9 | Covered | No `setInterval` / `Cron` / `scheduler` references mention `allowedChatGroups`; daemon has one startup call at `src/daemon.ts:1164`. |
| FR-10 | Covered | d3462ba, `README.md:437,458`, `README.en.md:366,387`, `bots.json.example:7`, `src/setup/bot-config-editor.ts:221-226`, `src/cli.ts:568-574`. |
| T-1 | Covered | d3462ba. |
| T-2 | Partially covered | 781a22a covers `listChatMemberOpenIds` pagination and API error tests at `test/lark-client-allowed-chat-groups.test.ts:23-58`. |
| T-3 | Covered | 55acbc0. |
| T-4 | Covered | Fresh verification: `./node_modules/.bin/vitest run test/bot-registry.test.ts test/bot-config-editor.test.ts test/lark-client-allowed-chat-groups.test.ts test/event-dispatcher.test.ts` passed 4 files / 123 tests; grep found no refresh hook. |

## 🟡 Improvement

- Build command is blocked by existing environment issues: `npx tsc --noEmit` fails on `src/setup/register-app.ts` missing SDK export/types, and `corepack pnpm build` fails because current `pnpm-workspace.yaml` has no `packages` field. These are outside the feature diff, but final release verification still needs a working build path.

## 🔴 Blocking

- FR-3 / FR-4 are only partially verified: `src/daemon.ts:1037-1054` resolves group members and fail-closes per group, but no test proves daemon startup calls this resolver per configured chat and skips failed groups without granting access. Add a focused test around the daemon startup resolver or extract a testable helper, then re-run review.
- Security-sensitive authorization path changed (`src/im/lark/event-dispatcher.ts:486-493` and `src/daemon.ts:1037-1054`). Project rules require external AI review for auth/authorization changes before final push/MR/merge. This review is pending.
