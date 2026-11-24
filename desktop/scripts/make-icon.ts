// Renders the ShiftBoss mark to a 1024 px PNG for `tauri icon`. bun scripts/make-icon.ts
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="0" y="0" width="1024" height="1024" rx="224" fill="#050505"/>
  <rect x="232" y="232" width="560" height="560" rx="132" fill="none" stroke="#F4F4F5" stroke-width="44"/>
  <path d="M368 420h288M368 512h176M368 604h240" stroke="#F4F4F5" stroke-width="44" stroke-linecap="round"/>
  <circle cx="704" cy="320" r="40" fill="#4ADE80"/>
</svg>`;
const chrome = ['chromium-1255', 'chromium-1148'].map((r) => join(homedir(), 'AppData', 'Local', 'ms-playwright', r, 'chrome-win64', 'chrome.exe')).find(existsSync) ?? process.env.CHROME_PATH;
const browser = await chromium.launch({ executablePath: chrome });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
const out = join(import.meta.dir, '..', 'icon.png');
await page.locator('svg').screenshot({ path: out, omitBackground: true });
await browser.close();
console.log('icon →', out);
