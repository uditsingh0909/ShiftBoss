// One screenshot of a task's session picker opened, to check the "Create new session" row by eye.
// Usage (server running): bun test/pick-shot.ts [out.png]
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.SHIFTBOSS_URL ?? 'http://127.0.0.1:4400';
const OUT = process.argv[2] ?? join(import.meta.dir, '..', 'data', 'e2e', 'session-pick.png');
function chrome(): string | undefined {
  const pw = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (existsSync(pw)) for (const d of readdirSync(pw).filter((x) => x.startsWith('chromium')).sort().reverse())
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) if (existsSync(join(pw, d, rel))) return join(pw, d, rel);
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']) if (existsSync(p)) return p;
}
const browser = await chromium.launch({ executablePath: chrome() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => localStorage.setItem('shiftboss-tour-seen', JSON.stringify(['home', 'tasks', 'task', 'needs', 'promises', 'intake', 'session', 'settings', 'welcome'])));
const snap = await (await fetch(BASE + '/api/snapshot')).json();
const task = snap.tasks.find((t: any) => t.stage < 6);
await page.goto(BASE + '/task/' + task.id);
await page.locator('button.pick-field', { hasText: 'Session ·' }).first().click();
await page.waitForTimeout(600);
await page.screenshot({ path: OUT });
await browser.close();
console.log(OUT);
