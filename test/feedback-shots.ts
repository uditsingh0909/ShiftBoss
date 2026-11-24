// Screenshots of what changed, for asking people for feedback: bun test/feedback-shots.ts <outDir>
// Read-only: opens pages, hovers and opens menus, never clicks anything that changes data.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.SHIFTBOSS_URL ?? 'http://127.0.0.1:4400';
const OUT = process.argv[2] ?? join(import.meta.dir, '..', 'data', 'feedback');
mkdirSync(OUT, { recursive: true });
function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(root)) for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) { const p = join(root, d, rel); if (existsSync(p)) return p; }
  }
  return ['C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
}

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: 'dark' });
await page.addInitScript(() => localStorage.setItem('shiftboss-tour-seen', JSON.stringify(['home', 'tasks', 'task', 'needs', 'promises', 'intake', 'session', 'settings', 'welcome', 'monitors'])));
const hideDetails = () => page.addStyleTag({ content: '.alert-slide .faint { visibility: hidden; }' });
const go = async (hash: string, wait = 1800) => { await page.goto(BASE + '/' + hash); await page.waitForTimeout(wait); await hideDetails(); };
const shot = (name: string, clip?: { x: number; y: number; width: number; height: number }) => page.screenshot({ path: join(OUT, name + '.png'), clip });

// 1. Sidebar, on the Sessions page
await go('#/');
await shot('1-sidebar');
// 2. The mode switch at the bottom of the sidebar, open
await page.locator('[aria-haspopup="menu"][title^="Mode"]').first().click();
await page.waitForTimeout(500);
await shot('2-mode-switch', { x: 0, y: 380, width: 700, height: 620 });
await page.keyboard.press('Escape');
// 3. Task board, hovering a card shows its quick actions
await go('#/tasks');
const card = page.locator('.stage-col > div, .stage-col article').nth(1);
await card.hover().catch(() => {});
await page.waitForTimeout(500);
await shot('3-task-quick-actions');
// 4. Settings: Mode, Your way of working, Notifications
await go('#/settings');
await shot('4-settings');
await go('#/settings/notifications', 2200);
await shot('5-notifications');
// 6. Needs you, with approvals
await go('#/needs');
await shot('6-needs-approvals');
// 7. Monitors
await go('#/monitors');
await shot('7-monitors');
// 8. Intake rows with source buttons and direction
await go('#/intake');
await shot('8-sources');
// 9. Get started
await go('#/welcome');
await shot('9-get-started');
await browser.close();
console.log('saved to', OUT);
