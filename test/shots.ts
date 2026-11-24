// Screenshots of the main screens for docs: bun test/shots.ts <outDir>
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.FOREMAN_URL ?? 'http://127.0.0.1:4400';
const OUT = process.argv[2] ?? join(import.meta.dir, '..', 'data', 'shots');
mkdirSync(OUT, { recursive: true });
const chrome = ['chromium-1255', 'chromium-1148'].map((r) => join(homedir(), 'AppData', 'Local', 'ms-playwright', r, 'chrome-win64', 'chrome.exe')).find(existsSync) ?? process.env.CHROME_PATH;

const snap = await (await fetch(BASE + '/api/snapshot')).json();
const session = [...snap.sessions].sort((a: any, b: any) => b.lines.length - a.lines.length)[0]?.name;
const task = snap.tasks.find((t: any) => t.stage >= 2 && t.stage <= 4)?.id ?? snap.tasks[0]?.id;
const shots: [string, string, string][] = [
  ['sessions', '#/', 'sessions running'], ['tasks', '#/tasks', 'in flight'], ['needs', '#/needs', 'Needs you'],
  ['intake', '#/intake', 'messages read today'], ['health', '#/health', 'Session health'], ['releases', '#/releases', 'Production'],
];
if (session) shots.splice(1, 0, ['session', '#/session/' + encodeURIComponent(session), session]);
if (task) shots.splice(3, 0, ['task', '#/task/' + task, task]);

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
for (const [name, hash, expect] of shots) {
  await page.goto(BASE + '/' + hash);
  await page.getByText(expect, { exact: false }).first().waitFor({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1600);
  await page.screenshot({ path: join(OUT, name + '.jpg'), type: 'jpeg', quality: 78 });
}
await browser.close();
console.log(shots.map((s) => s[0]).join(' '));
