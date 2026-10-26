import { expect, test, type Locator, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

test.setTimeout(60_000);

const PAYLOAD = {
  present: true,
  capacity_pct: 51,
  period_type: '5h',
  reset_at: '2026-10-13T07:30:00Z',
  level: 'max',
  windows: [
    { id: '5h', used_pct: 51, reset_at: '2026-10-13T07:30:00Z' },
    { id: '7d', used_pct: 72, reset_at: '2026-10-20T07:30:00Z' },
  ],
};

async function openUsage(page: Page, language = 'en', fontSizeLevel = 3, theme = 'dark', stale = false) {
  await page.addInitScript(({ payload, appVersion, language, fontSizeLevel }) => {
    localStorage.setItem('lastSeenChangelogVersion', appVersion);
    localStorage.setItem('language', language);
    localStorage.setItem('fontSizeLevel', String(fontSizeLevel));
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      claudePermissionMode: 'bypassPermissions',
    }));

    const bridge = window as unknown as {
      sendToJava: (message: string) => void;
      updateClaudePlanUsage?: (json: string) => void;
      updateDependencyStatus?: (json: string) => void;
    };
    bridge.sendToJava = (message) => {
      if (message.startsWith('get_claude_plan_usage:')) {
        setTimeout(() => bridge.updateClaudePlanUsage?.(JSON.stringify(payload)), 0);
      }
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => bridge.updateDependencyStatus?.(JSON.stringify({
          'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
          'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
        })), 0);
      }
    };
  }, { payload: { ...PAYLOAD, stale }, appVersion: APP_VERSION, language, fontSizeLevel });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
  await expect(page.locator('.plan-usage-pct')).toHaveText('51%');
  await expect(page.locator('.sdk-warning-bar')).toHaveCount(0);
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const viewport = page.viewportSize()!;
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return box !== null
      && box.x >= -1 && box.y >= -1
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1;
  }, { message: 'The complete indicator or tooltip must fit inside the viewport' }).toBe(true);
}

for (const variant of [
  { name: 'Chinese at 100%', language: 'zh', level: 3, theme: 'dark', scale: 1 },
  { name: 'Chinese at 140%', language: 'zh', level: 6, theme: 'light', scale: 1.4 },
  { name: 'English at 80%', language: 'en', level: 1, theme: 'dark', scale: 0.8 },
]) {
  test(`compact usage and full details fit the viewport: ${variant.name}`, async ({ page }, testInfo) => {
    await openUsage(page, variant.language, variant.level, variant.theme);
    const summary = page.locator('.plan-usage');

    await expect.poll(() => page.locator('#app').evaluate((app) => Number(getComputedStyle(app).zoom))).toBe(variant.scale);
    await expect(summary).toBeVisible();
    await expect(page.locator('.plan-usage-reset')).toHaveCount(0);
    await expectInsideViewport(page, summary);
    await summary.hover();

    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('51%');
    await expect(tooltip).toContainText('72%');
    await expect(tooltip).toContainText(variant.language === 'zh' ? '重置时间' : 'Resets:');
    await expect(tooltip).toContainText('2026');
    await expectInsideViewport(page, tooltip);
    const details = tooltip.locator('.plan-usage-details');
    expect(await details.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('claude-plan-usage.png') });

    if (await details.evaluate((element) => element.scrollHeight > element.clientHeight + 1)) {
      await tooltip.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(tooltip).toBeVisible();
    }

    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
  });
}

test('keyboard dismissal and period switching work with the detail tooltip', async ({ page }) => {
  await openUsage(page);
  const summary = page.locator('.plan-usage');
  const tooltip = page.getByRole('tooltip');

  await summary.focus();
  await expect(tooltip).toBeVisible();
  await summary.press('Escape');
  await expect(tooltip).toBeHidden();

  await summary.getByRole('button', { name: 'Click period label to switch window' }).click();
  await expect(page.locator('.plan-usage-window')).toHaveText('7d');
  await expect(page.locator('.plan-usage-pct')).toHaveText('72%');
  expect(await page.evaluate(() => localStorage.getItem('ccgui.planUsage.windowId'))).toBe('7d');

  await summary.hover();
  await expect(tooltip).toContainText('7d · 72% used');
  await expectInsideViewport(page, tooltip);

  // Keep the keyboard trigger active when resizing moves the summary away from the mouse.
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await summary.focus();
  await expect(tooltip).toBeVisible();
  await page.setViewportSize({ width: 393, height: 365 });
  await expectInsideViewport(page, summary);
  await expectInsideViewport(page, tooltip);
});

async function waitForTooltipAnimation(tooltip: Locator) {
  await expect.poll(() => tooltip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.width - (element as HTMLElement).offsetWidth) <= 1
      && Number(getComputedStyle(element).opacity) === 1;
  })).toBe(true);
}

for (const height of [550, 600]) {
  test(`open usage tooltip follows input dragging at ${height}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1018, height });
    await openUsage(page, 'zh', 6);
    const summary = page.locator('.plan-usage');
    const tooltip = page.getByRole('tooltip');
    await page.mouse.move(0, 0);
    await summary.focus();
    await expect(tooltip).toBeVisible();
    await waitForTooltipAnimation(tooltip);
    const before = (await summary.boundingBox())!;
    const handle = (await page.locator('.resize-handle--n').boundingBox())!;

    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(1, handle.y - 80, { steps: 8 });
    try {
      await expect(summary).toBeFocused();
      await expect(tooltip).toBeVisible();
      await expect.poll(async () => before.y - (await summary.boundingBox())!.y).toBeGreaterThan(30);
      await expectInsideViewport(page, tooltip);
      await expect.poll(async () => {
        const anchor = (await summary.boundingBox())!;
        const popup = (await tooltip.boundingBox())!;
        const gapAbove = anchor.y - popup.y - popup.height;
        const gapBelow = popup.y - anchor.y - anchor.height;
        return (gapAbove >= -1 && gapAbove <= 24) || (gapBelow >= -1 && gapBelow <= 24);
      }, { message: 'The tooltip must follow the summary without covering it' }).toBe(true);
    } finally {
      await page.mouse.up();
    }
    await expect(tooltip).toBeVisible();
    await expectInsideViewport(page, tooltip);
    await page.screenshot({ path: testInfo.outputPath('usage-after-input-drag.png') });
    await summary.press('Escape');
    await expect(tooltip).toBeHidden();
  });
}

test('keyboard scrolls all usage details without losing summary focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1018, height: 365 });
  await openUsage(page, 'zh', 6, 'dark', true);
  const summary = page.locator('.plan-usage');
  const tooltip = page.getByRole('tooltip');
  const details = tooltip.locator('.plan-usage-details');
  await summary.focus();
  await expect(tooltip).toBeVisible();
  await waitForTooltipAnimation(tooltip);
  expect(await details.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await summary.press('PageDown');
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(summary).toBeFocused();
  await summary.press('End');
  await expect.poll(() => details.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  // Verify the last line is in the visible area, not just present in the DOM.
  expect(await details.evaluate((element) => {
    const text = element.firstChild;
    if (!text?.textContent) return false;
    const start = text.textContent.lastIndexOf('\n') + 1;
    if (!text.textContent.slice(start).includes('刷新失败')) return false;
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, text.textContent.length);
    const line = range.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();
    return line.top >= viewport.top - 1 && line.bottom <= viewport.bottom + 1;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('usage-keyboard-scroll-footer.png') });

  await summary.press('Home');
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBe(0);
  await summary.press('ArrowDown');
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await summary.press('ArrowUp');
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBe(0);
  await summary.press('End');
  const bottom = await details.evaluate((element) => element.scrollTop);
  await summary.press('PageUp');
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeLessThan(bottom);
  await summary.press('Tab');
  await expect(summary.getByRole('button')).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => details.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
  await page.keyboard.press('Enter');
  await expect(page.locator('.plan-usage-window')).toHaveText('7d');
  await expect(page.locator('.plan-usage-pct')).toHaveText('72%');
  await expect(summary.getByRole('button')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(summary).toBeFocused();
  await summary.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(summary).toBeFocused();
});
