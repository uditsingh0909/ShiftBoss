// Browser check against a running ShiftBoss: opens every screen, fails on any page error or
// console error, and saves a screenshot of each. Run with: bun test/e2e.ts [outDir]
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.SHIFTBOSS_URL ?? 'http://127.0.0.1:4400';
const OUT = process.argv[2] ?? join(import.meta.dir, '..', 'data', 'e2e');
mkdirSync(OUT, { recursive: true });

function findChrome(): string | undefined {
  const root = join(homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const rev of ['chromium-1255', 'chromium-1148']) {
    const p = join(root, rev, 'chrome-win64', 'chrome.exe');
    if (existsSync(p)) return p;
    const q = join(root, rev, 'chrome-win', 'chrome.exe');
    if (existsSync(q)) return q;
  }
  return process.env.CHROME_PATH;
}

const snap = await (await fetch(BASE + '/api/snapshot')).json();
const session = snap.sessions[0]?.name;
const task = snap.tasks[0]?.id;
const routes: [string, string, string][] = [
  ['home', '#/', 'sessions running'], ['roster', '#/roster', 'Every session'], ['health', '#/health', 'Session health'],
  ['overlap', '#/overlap', 'Overlap check'], ['tasks', '#/tasks', 'in flight'], ['intake', '#/intake', 'messages read today'],
  ['needs', '#/needs', 'Needs you'], ['promises', '#/promises', 'waiting on you'], ['audit', '#/audit', 'in your name'],
  ['report', '#/report', 'Copy'], ['settings', '#/settings', 'Save'], ['welcome', '#/welcome', 'Set up ShiftBoss'], ['setup', '#/setup', 'Connect your sessions'],
];
if (session) routes.push(['session', '#/session/' + encodeURIComponent(session), session]);
if (task) routes.push(['task', '#/task/' + task, task]);

const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
const failures: string[] = [];
for (const width of [1920, 390]) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1080 } });
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  for (const [name, hash, expect] of routes) {
    errs.length = 0;
    await page.goto(BASE + '/' + hash);
    try {
      await page.getByText(expect, { exact: false }).first().waitFor({ timeout: 6000 });
    } catch { failures.push(`${width}px ${name}: did not show "${expect}"`); }
    await page.waitForTimeout(1500); // let entry animations finish before measuring
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (overflow && width === 390) failures.push(`${width}px ${name}: page scrolls sideways`);
    for (const e of errs) failures.push(`${width}px ${name}: ${e}`);
    await page.screenshot({ path: join(OUT, `${name}-${width}.png`), fullPage: false });
    // Dropdowns: the open list must be on top of everything (cards are their own layers).
    if (name === 'task') {
      const box = page.locator('[role="combobox"]').first();
      if (await box.count()) {
        await box.click();
        const list = page.locator('[role="listbox"]');
        try {
          await list.waitFor({ timeout: 3000 });
          await page.waitForTimeout(400);
          const onTop = await list.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return [[0.5, 0.25], [0.5, 0.75], [0.2, 0.5], [0.8, 0.5]].every(([x, y]) => el.contains(document.elementFromPoint(r.left + r.width * x, r.top + r.height * y)));
          });
          if (!onTop) failures.push(`${width}px task: something paints over the open dropdown`);
          await page.screenshot({ path: join(OUT, `dropdown-${width}.png`), fullPage: false });
        } catch { failures.push(`${width}px task: dropdown did not open`); }
        await page.keyboard.press('Escape');
      }
    }
  }
  await page.close();
}
await browser.close();
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log(`ok: ${routes.length} screens x 2 widths, screenshots in ${OUT}`);
