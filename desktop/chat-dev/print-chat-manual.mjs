import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const require = createRequire('/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const { chromium } = require('playwright');
const input = process.argv[2] || '/Users/lilo-jali/Documents/MemoSim Training Evidence/memosim-manual.html';
const output = process.argv[3] || path.join(path.dirname(input), 'MemoSim Manual.pdf');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ offline: true });
  await context.route(/^https?:/, route => route.abort());
  const page = await context.newPage();
  await page.goto(pathToFileURL(input).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(details => { details.open = true; });
    document.querySelectorAll('img').forEach(image => { image.loading = 'eager'; });
  });
  await page.waitForFunction(() => [...document.images].every(image => image.complete), null, { timeout: 30000 });
  const broken = await page.evaluate(() => [...document.images].filter(image => !image.naturalWidth).length);
  if (broken) throw new Error(`${broken} manual images failed`);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => {
    document.querySelectorAll('.evidence-panel[data-panel="test"]').forEach(panel => {
      const note = document.createElement('p');
      note.className = 'print-validation-note';
      note.textContent = 'Detailed machine-readable validation and the full tool transcript are preserved in the interactive HTML edition. Recorded terminal experiment results are printed in the Result section.';
      panel.prepend(note);
    });
  });
  await page.addStyleTag({ content: '@media print{.evidence-panel[data-panel="tools"],.scenario-record,.evidence-panel[data-panel="test"] pre{display:none!important}.cover{break-inside:avoid}.scenario-head .field-note{font-size:9pt}.scenario-head .field-note strong{font-size:10pt}}' });
  await page.pdf({ path: output, format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, margin: { top: '15mm', bottom: '18mm', left: '14mm', right: '14mm' },
    headerTemplate: '<span></span>',
    footerTemplate: '<div style="font:9px sans-serif;width:100%;padding:0 40px;color:#52736b;display:flex;justify-content:space-between"><span>MemoSim 1.0.4 · Chat-first field manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    outline: true });
  if (readFileSync(output).subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid generated PDF');
  console.log(JSON.stringify({ input, output, bytes: statSync(output).size, offline: true, brokenImages: broken }));
} finally { await browser.close(); }
