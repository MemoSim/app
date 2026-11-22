// Prints the MemoSim manual chapter set (user guide + tutorial + scenarios + legal) to A4 PDF.
// The inline primitive dictionary is excluded: it lives in dict/ as its own browsable pages and would
// turn a readable manual into a thousand-page dump.
import { createRequire } from 'node:module';
const require = createRequire('/Users/lilo-jali/Documents/MemoSim-repo/chat/package.json');
const { chromium } = require('playwright');
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const input = process.argv[2];
const output = process.argv[3];
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const context = await browser.newContext({ offline: true });
  await context.route(/^https?:/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(pathToFileURL(input).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    // The primitive dictionary lives in <details class="reference-extra">: opening or printing it would add ~900 pages.
    document.querySelectorAll('details:not(.reference-extra)').forEach((details) => { details.open = true; });
    document.querySelectorAll('img').forEach((image) => { image.loading = 'eager'; });
  });
  await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 30000 });
  await page.emulateMedia({ media: 'print' });
  await page.addStyleTag({
    content: `
      @media print {
        [id^="doc-dict-"], details.reference-extra, .dictionary-list, nav.toc, .search-box, .copy-btn, #copy-dialog { display: none !important; }
        /* screenshots are stored at retina size: without a cap each one consumes several pages */
        img { max-width: 100% !important; max-height: 200mm !important; width: auto !important; height: auto !important; }
        .cover, .editorial-section { break-inside: auto; }
        h2, h3 { break-after: avoid; }
        a[href^="#doc-dict-"] { color: inherit; text-decoration: none; }
        /* raw tool transcripts and per-scenario test panels are for the interactive edition, not the printed one */
        .evidence-panel[data-panel="tools"], .scenario-record, .evidence-panel[data-panel="test"] pre { display: none !important; }
        .scenario img, .scenario-stage img { max-height: 90mm !important; }
      }`,
  });
  await page.pdf({
    path: output,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    margin: { top: '15mm', bottom: '18mm', left: '14mm', right: '14mm' },
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="font:9px sans-serif;width:100%;padding:0 40px;color:#52736b;display:flex;justify-content:space-between"><span>MemoSim 1.1.4 · Chat-first user manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    outline: true,
  });
  console.log(JSON.stringify({ output, bytes: statSync(output).size }));
} finally {
  await browser.close();
}
