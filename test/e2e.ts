// Browser check against a running ShiftBoss: opens every screen, fails on any page error or
// console error, and saves a screenshot of each. Run with: bun test/e2e.ts [outDir]
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.SHIFTBOSS_URL ?? 'http://127.0.0.1:4400';
const OUT = process.argv[2] ?? join(import.meta.dir, '..', 'data', 'e2e');
mkdirSync(OUT, { recursive: true });

// Any Chromium will do: CHROME_PATH, a Playwright download of any version, or an installed Chrome / Edge.
function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pw = [join(homedir(), 'AppData', 'Local', 'ms-playwright'), join(homedir(), '.cache', 'ms-playwright'), join(homedir(), 'Library', 'Caches', 'ms-playwright')];
  for (const root of pw) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(root, dir, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) if (existsSync(p)) return p;
  return undefined;
}

const snap = await (await fetch(BASE + '/api/snapshot')).json();
const session = snap.sessions[0]?.name;
const task = snap.tasks[0]?.id;
const routes: [string, string, string][] = [
  ['home', '/', 'sessions running'], ['roster', '/roster', 'Every session'], ['health', '/health', 'Session health'],
  ['overlap', '/overlap', 'Overlap check'], ['tasks', '/tasks', 'in flight'], ['intake', '/intake', 'messages read today'],
  ['needs', '/needs', 'Needs you'], ['promises', '/promises', 'waiting on you'], ['audit', '/audit', 'in your name'],
  ['report', '/report', 'Copy'], ['settings', '/settings', 'Save'], ['welcome', '/welcome', 'Set up ShiftBoss'], ['setup', '/setup', 'Connect your sessions'],
  ['monitors', '/monitors', 'watched'],
];
if (session) routes.push(['session', '/session/' + encodeURIComponent(session), session]);
if (task) routes.push(['task', '/task/' + task, task]);

const chrome = findChrome();
if (!chrome) { console.log('No Chrome, Edge or Chromium found. Set CHROME_PATH to one, or run: bunx playwright install chromium'); process.exit(2); }
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const failures: string[] = [];
for (const width of [1920, 390]) {
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1080 } });
  // Guided tours would cover the screenshots; mark every page's tour as seen.
  await page.addInitScript(() => localStorage.setItem('shiftboss-tour-seen', JSON.stringify(['home', 'tasks', 'task', 'needs', 'promises', 'intake', 'session', 'settings', 'welcome'])));
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  for (const [name, hash, expect] of routes) {
    errs.length = 0;
    await page.goto(BASE + hash);
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
// The sidebar: collapses to a rail and remembers it; on a phone it is a drawer from the menu button.
{
  const seen = () => localStorage.setItem('shiftboss-tour-seen', JSON.stringify(['home', 'tasks', 'task', 'needs', 'promises', 'intake', 'session', 'settings', 'welcome']));
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(seen);
  await page.goto(BASE + '/tasks');
  try {
    await page.getByRole('link', { name: /^Overlaps/ }).waitFor({ timeout: 6000 });
    await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, 'rail-1920.png') });
    await page.reload();
    await page.getByRole('button', { name: 'Expand the sidebar' }).waitFor({ timeout: 6000 });
    await page.getByRole('button', { name: 'Expand the sidebar' }).click();
  } catch { failures.push('sidebar: collapse did not work or was not remembered'); }
  await page.close();
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript(seen);
  await phone.goto(BASE + '/tasks');
  try {
    await phone.getByRole('button', { name: /^Open menu/ }).click();
    const tasks = phone.getByRole('link', { name: /^Tasks/ });
    await tasks.waitFor({ timeout: 3000 });
    await phone.waitForTimeout(700);
    await phone.screenshot({ path: join(OUT, 'drawer-390.png') });
    if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) failures.push('390px drawer: page scrolls sideways');
    await phone.getByRole('link', { name: /^Settings/ }).click();
    await phone.waitForTimeout(700);
    if (await phone.locator('.side.open').count()) failures.push('390px drawer: did not close after choosing a screen');
  } catch { failures.push('390px drawer: menu did not open'); }
  await phone.close();
}
// The tour shows on a first visit and goes away with Skip.
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(BASE + '/tasks');
  try {
    await page.locator('.tour-card').waitFor({ timeout: 6000 });
    await page.screenshot({ path: join(OUT, 'tour-1920.png') });
    await page.getByRole('button', { name: 'Skip' }).click();
    await page.reload();
    await page.waitForTimeout(2500);
    if (await page.locator('.tour-card').count()) failures.push('tour: shows again after Skip');
  } catch { failures.push('tour: did not show on a first visit to Tasks'); }
  await page.close();
}
// Plain paths: an old #/ link lands on the path, and a click inside the app moves without a reload.
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => localStorage.setItem('shiftboss-tour-seen', JSON.stringify(['home', 'tasks', 'task', 'needs', 'promises', 'intake', 'session', 'settings', 'welcome'])));
  await page.goto(BASE + '/#/needs');
  try {
    await page.getByText('Needs you', { exact: false }).first().waitFor({ timeout: 6000 });
    if (new URL(page.url()).pathname !== '/needs') failures.push('urls: #/needs did not become /needs (got ' + page.url() + ')');
    await page.evaluate(() => { (window as any).__noReload = true; });
    await page.getByRole('link', { name: /^Promises/ }).first().click();
    await page.getByText('waiting on you', { exact: false }).first().waitFor({ timeout: 6000 });
    if (new URL(page.url()).pathname !== '/promises') failures.push('urls: sidebar click did not go to /promises');
    if (!(await page.evaluate(() => (window as any).__noReload))) failures.push('urls: a sidebar click reloaded the page');
    await page.goBack();
    await page.getByText('Needs you', { exact: false }).first().waitFor({ timeout: 6000 });
    if (new URL(page.url()).pathname !== '/needs') failures.push('urls: Back did not return to /needs');
  } catch (e) { failures.push('urls: ' + (e as Error).message.split('\n')[0]); }
  // Lists: a date range and a pager on Intake; Custom asks for dates and refuses more than 90 days.
  try {
    await page.goto(BASE + '/intake');
    await page.getByRole('group', { name: 'Date range' }).first().waitFor({ timeout: 6000 });
    await page.getByRole('button', { name: 'Today', exact: true }).first().click();
    await page.getByRole('button', { name: 'Custom', exact: true }).first().click();
    if (!(await page.locator('#intake-range-from').count())) failures.push('lists: Custom shows no date fields');
    await page.fill('#intake-range-from', '2020-01-01');
    if (!(await page.getByText('At most 90 days').count())) failures.push('lists: a 90+ day custom range was not refused');
    await page.getByRole('button', { name: 'All', exact: true }).first().click();
    await page.getByText(/of \d+ · page \d+ of \d+/).first().waitFor({ timeout: 6000 });
    for (const path of ['/tasks', '/promises', '/audit', '/monitors']) {
      await page.goto(BASE + path);
      try { await page.getByRole('group', { name: 'Date range' }).first().waitFor({ timeout: 6000 }); }
      catch { failures.push(`lists: no date range on ${path}`); }
    }
  } catch (e) { failures.push('lists: ' + (e as Error).message.split('\n')[0]); }
  await page.close();
}
await browser.close();
if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
console.log(`ok: ${routes.length} screens x 2 widths, screenshots in ${OUT}`);
