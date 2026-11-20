import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire('/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const { chromium } = require('playwright');
const result = await (await fetch('http://127.0.0.1:9238/modeler-js', { method: 'POST', body: 'location.href' })).text();
if (!/^http:\/\/127\.0\.0\.1:\d+\/modeler$/.test(result)) throw new Error('Expected isolated modeler URL');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(result);
  await page.getByRole('button', { name: 'Apply to model', exact: true }).waitFor();
  await page.getByLabel('Simulation timestep').waitFor();
  await page.screenshot({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), 'manual/assets/modeler.png'), fullPage: true });
  console.log('Captured real MemoSim System Dynamics modeler web view; native frame not shown.');
} finally { await browser.close(); }
