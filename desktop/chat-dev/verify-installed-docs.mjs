import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const require = createRequire('/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const { chromium } = require('playwright');
const docs = process.argv[2] || '/Applications/MemoSim.app/Contents/docs';
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ offline: true });
  const requests = [];
  await context.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  const failures = [];
  const files = readdirSync(path.join(docs, 'dict')).filter(name => name.endsWith('.html'));
  for (const [index, name] of files.entries()) {
    await page.goto(pathToFileURL(path.join(docs, 'dict', name)).href, { waitUntil: 'domcontentloaded' });
    const state = await page.evaluate(() => ({
      heading: document.querySelector('main h1,main h2')?.textContent?.trim(),
      text: document.querySelector('main')?.textContent?.length || 0,
      brokenImages: [...document.images].filter(image => image.complete && !image.naturalWidth).map(image => image.src),
      scripts: [...document.scripts].map(script => script.src),
    }));
    if (!state.heading || state.text < 80 || state.brokenImages.length || state.scripts.some(src => /^https?:/.test(src))) failures.push({ name, ...state });
    if ((index + 1) % 100 === 0) console.log(`Rendered ${index + 1}/${files.length} installed dictionary pages offline`);
  }
  if (requests.length) failures.push({ networkRequests: requests });
  const pdf = readFileSync(path.join(docs, 'manual.pdf'));
  if (pdf.subarray(0, 5).toString() !== '%PDF-') failures.push({ error: 'PDF signature invalid' });
  const report = { checkedAtUTC: new Date().toISOString(), docs, dictionaryPagesRendered: files.length, attemptedExternalRequests: requests.length, pdfBytes: pdf.length, failures };
  writeFileSync('/Users/lilo-jali/Documents/MemoSim Releases/1.0.4-build2-help-20261119/installed-docs-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
} finally { await browser.close(); }
