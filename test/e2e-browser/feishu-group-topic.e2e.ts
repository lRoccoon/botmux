/**
 * Group chat topic/thread creation test:
 *
 * Verifies that bots reply using TOPIC REPLIES (话题回复) in regular group chats.
 *
 * Feishu UI indicators:
 *  - "查看更早 N 条话题回复" or "N 条话题回复" → topic mode (reply_in_thread=true)
 *  - "N 条回复" (without "话题") → regular inline reply mode
 *  - "回复话题" → thread reply input (present in both modes, not a reliable indicator)
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { Browser, Page, BrowserContext } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { existsSync } from 'node:fs';
import {
  createBrowser,
  createPage,
  createAgent,
  checkPrerequisites,
  STORAGE_STATE_PATH,
  testMessage,
  sendMentionMessage,
  navigateToMessenger,
  openChat,
  getGroupChatName,
} from './helpers.js';

describe('group chat topic reply mode', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let agent: PlaywrightAgent;

  beforeAll(async () => {
    checkPrerequisites();
    if (!existsSync(STORAGE_STATE_PATH)) {
      throw new Error(
        'storageState.json not found. Run: pnpm test:e2e-browser:setup',
      );
    }
    browser = await createBrowser();
    ({ context, page } = await createPage(browser));
    agent = createAgent(page);

    await navigateToMessenger(page);
    await openChat(page, agent, getGroupChatName());
  }, 120_000);

  afterAll(async () => {
    await agent?.destroy();
    await context?.close();
    await browser?.close();
  });

  it('bot uses topic replies (话题回复) in regular group', async () => {
    const msg = testMessage('topic-mode');
    await sendMentionMessage(page, agent, 'Claude', msg);

    // Wait for bot to respond
    await agent.aiWaitFor(
      `聊天中"${msg}"消息附近出现了来自机器人的回复`,
      { timeoutMs: 90_000, checkIntervalMs: 5_000 },
    );

    // Wait a few seconds for thread indicator to appear
    await page.waitForTimeout(5000);

    // KEY ASSERTION: check for "话题回复" text in the thread indicator.
    // Feishu shows "查看更早 N 条话题回复" or "N 条话题回复" when
    // reply_in_thread=true is used. This is different from "N 条回复"
    // (without 话题) which indicates regular inline replies.
    await agent.aiAssert(
      `消息"${msg}"所在区域可以看到包含"话题回复"的文字（例如"查看更早 N 条话题回复"或"N 条话题回复"），` +
        '这说明机器人使用了话题模式回复',
    );
  }, 240_000);
});
