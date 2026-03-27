import { describe, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync } from 'node:fs';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  getRequiredEnv,
  STORAGE_STATE_PATH,
} from './helpers.js';

describe('feishu bot reply', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let agent: PlaywrightAgent;

  beforeAll(async () => {
    checkPrerequisites();

    if (!existsSync(STORAGE_STATE_PATH)) {
      throw new Error(
        'storageState.json not found. Run setup first: pnpm test:e2e-browser:setup',
      );
    }

    browser = await createBrowser();
    ({ context, page } = await createPage(browser));
    agent = createAgent(page);
  });

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('should receive bot reply after sending a message', async () => {
    const groupUrl = getRequiredEnv('FEISHU_TEST_GROUP_URL');
    const testMessage = `e2e-test-${Date.now()}`;

    // 1. Navigate to the test group
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // 2. Type and send a message
    await agent.aiAct(
      `在消息输入框中输入 "${testMessage}" 然后按 Enter 发送`,
    );

    // 3. Wait for bot to reply (60s — CLI spawn can be slow)
    await agent.aiWaitFor(
      '页面上出现了新的消息回复，不是我刚才发送的消息',
      { timeoutMs: 60_000, checkIntervalMs: 5_000 },
    );

    // 4. Assert bot replied
    await agent.aiAssert('聊天中有来自机器人的回复消息');
  }, 120_000);
});
