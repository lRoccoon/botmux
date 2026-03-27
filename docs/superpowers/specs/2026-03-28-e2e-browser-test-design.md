# E2E Browser Test Design

## Goal

Build a browser-based E2E test framework for botmux that verifies the full message flow through Feishu web UI: send a message in a topic group → bot creates a thread and replies with a message card.

Tests are publishable to GitHub with zero credential leakage. Anyone can clone the repo, provide their own Feishu account and Midscene API key, and run the tests.

## Tech Stack

- **Midscene.js** (`@midscene/web`) — AI vision-driven page interaction, uses natural language instead of CSS selectors
- **Playwright** — Browser automation engine (Midscene wraps it)
- **Vitest** — Test runner (reuses existing project configuration)

## Credential Management

All sensitive data lives in gitignored files:

| File | Contents | In Git? |
|------|----------|---------|
| `.env` | Midscene API key, Feishu test group URL | No (gitignored) |
| `storageState.json` | Feishu login cookies/localStorage | No (gitignored) |
| `.env.example` | Template showing required variables | Yes |

### `.env.example` variables

```bash
# Feishu test group URL (the topic group where the bot is added)
FEISHU_TEST_GROUP_URL=https://xxx.feishu.cn/next/messenger/...

# Midscene AI model configuration
MIDSCENE_MODEL_NAME=your-model-name
MIDSCENE_MODEL_API_KEY=your-api-key
MIDSCENE_MODEL_BASE_URL=https://your-endpoint
MIDSCENE_MODEL_FAMILY=your-model-family
```

## File Structure

```
test/e2e-browser/
  setup-login.ts          # One-time login script, saves storageState.json
  feishu-bot-reply.e2e.ts # Core test: send message → bot replies → verify card
  helpers.ts              # Shared utilities (browser launch, page/agent creation)
```

## Browser Configuration

```typescript
const BROWSER_CONFIG = {
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
};
```

### System Font Requirements

Headless Linux environments need fonts for emoji and CJK rendering:

- `fonts-noto-color-emoji` — color emoji rendering
- `fonts-noto-cjk` — Chinese/Japanese/Korean font support

The setup script checks for these and prints install instructions if missing.

## Workflow

### One-time Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Install Playwright browsers
npx playwright install chromium

# 3. Install system fonts (if missing)
apt install fonts-noto-color-emoji fonts-noto-cjk

# 4. Copy and fill in env vars
cp .env.example .env
# Edit .env with your Midscene API key and Feishu group URL

# 5. Login to Feishu (opens browser, user logs in manually)
pnpm test:e2e-browser:setup
# Script detects successful login and saves storageState.json
```

### Running Tests

```bash
pnpm test:e2e-browser
```

### npm Scripts

```json
{
  "test:e2e-browser:setup": "tsx test/e2e-browser/setup-login.ts",
  "test:e2e-browser": "vitest run test/e2e-browser/"
}
```

## Test: feishu-bot-reply.e2e.ts

### Flow

1. Launch Chromium with saved `storageState.json` (viewport 1920x1080)
2. Navigate to the Feishu test group URL from `.env`
3. Use Midscene AI to type a test message (e.g., `"e2e-test-{timestamp}"`) in the input box and send
4. Wait for bot to reply (Midscene `aiWaitFor` with timeout)
5. Assert that a bot reply / message card appeared in the thread

### Key Decisions

- **Message uniqueness**: Each test run uses a timestamped message to avoid collisions
- **Timeout**: 60s for bot reply (CLI spawn + first response can be slow)
- **No card interaction yet**: Phase 1 only verifies the reply appears; card button tests come later

## setup-login.ts

### Flow

1. **Pre-flight checks**:
   - Playwright browsers installed?
   - System fonts (emoji, CJK) installed?
   - `.env` file exists with required variables?
2. **Open browser** (headed mode, not headless) at Feishu login page
3. **Wait for user** to complete login manually
4. **Detect login success** by checking URL change or presence of messenger UI elements
5. **Save** `storageState.json` via `context.storageState({ path: ... })`
6. **Print** success message and close browser

## helpers.ts

Exports:
- `createBrowser()` — launches Chromium with proper config
- `createPage(browser)` — creates context with storageState + viewport + locale
- `createAgent(page)` — wraps page with Midscene `PlaywrightAgent`
- `checkPrerequisites()` — validates fonts, env vars, storageState existence

## Future Expansion (Out of Scope)

These are not part of Phase 1 but the framework supports adding them:

- Card button interaction tests (expand/collapse, restart, close)
- Web Terminal link accessibility verification
- Multi-bot @mention routing tests
- Screenshot comparison / visual regression
