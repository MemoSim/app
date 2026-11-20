import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(root, 'manual');
const require = createRequire(process.env.MEMOSIM_WEB_PACKAGE || '/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.route(/^https?:/, route => route.abort());
page.setDefaultTimeout(20000);
const errors = [];
const localHref = (current, href) => {
  const url = new URL(href, pathToFileURL(current));
  if (url.protocol !== 'file:') return null;
  return { file: fileURLToPath(url), hash: decodeURIComponent(url.hash.slice(1)) };
};
try {
  const parts = [];
  const chapterFiles = ['index.html', 'tutorial.html', 'dictionary.html', 'legal.html'];
  for (const name of chapterFiles) {
    console.log(`Preparing ${name}`);
    await page.goto(pathToFileURL(path.join(docs, name)).href, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.querySelectorAll('details').forEach(d => d.open = true); });
    const main = await page.locator('main').evaluate((node, filename) => {
      const clone = node.cloneNode(true);
      clone.id = filename + '-content';
      clone.querySelectorAll('img').forEach(image => image.removeAttribute('loading'));
      if (filename === 'dictionary') {
        clone.querySelectorAll('.dictionary-list, .search-box, nav.toc').forEach(element => element.remove());
        const note = document.createElement('p');
        note.innerHTML = 'This PDF includes the MemoSim workflow glossary and complete language reference by category. For interactive search and individual primitive pages, open the bundled <a href="dictionary.html">dictionary.html</a>.';
        clone.prepend(note);
      }
      clone.querySelectorAll('[id]').forEach(element => { element.id = filename + '-' + element.id; });
      clone.querySelectorAll('a[href^="#"]').forEach(link => {
        link.setAttribute('href', '#' + filename + '-' + link.getAttribute('href').slice(1));
      });
      return clone.innerHTML;
    }, name.replace('.html', ''));
    parts.push(`<article class="manual-part" id="part-${name.replace('.html', '')}"><div id="${name.replace('.html', '')}-content">${main}</div></article>`);
  }
  const combined = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>MemoSim 1.0.4 User Manual and Beginner Tutorial</title><link rel="stylesheet" href="docs.css"></head><body><main>
  <section><img src="assets/memosim-icon.png" width="96" alt="MemoSim"><h1>MemoSim 1.0.4</h1><p>User manual · Beginner tutorial · Language dictionary</p><p>Offline edition · November 19, 2026</p><p>Powered by NetLogo. Modified modeling workspace with assistant, live dashboard and visual System Dynamics.</p><p>This PDF includes the user guide, course, complete primitive reference and legal information. Searchable offline Help, copying code and lesson progress are available in the web edition.</p><nav class="print-toc">${chapterFiles.map(name => `<p><a href="#part-${name.replace('.html', '')}">${name.replace('.html', '')}</a></p>`).join('')}</nav></section>${parts.join('\n')}</main></body></html>`;
  writeFileSync(path.join(docs, 'print-manual.html'), combined);
  console.log('Rendering printable manual');
  await page.goto(pathToFileURL(path.join(docs, 'print-manual.html')).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.images].every(img => img.complete), null, { timeout: 20000 });
  await page.pdf({ path: path.join(docs, 'manual.pdf'), format: 'A4', printBackground: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:9px;width:100%;padding:0 40px;color:#526780;display:flex;justify-content:space-between"><span>MemoSim 1.0.4 · Powered by NetLogo</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margin: { top: '18mm', bottom: '20mm', left: '16mm', right: '16mm' }, outline: true });
  console.log('PDF generated; validating offline links and browser interactions');

  const walk = dir => readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name); return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const htmlFiles = walk(docs).filter(file => file.endsWith('.html'));
  const anchors = new Map();
  for (const file of htmlFiles) {
    const content = readFileSync(file, 'utf8');
    anchors.set(file, new Set([...content.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1])));
  }
  let links = 0;
  for (const file of htmlFiles) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
      const href = match[1].replaceAll('&amp;', '&');
      if (/^(https?:|mailto:|data:|javascript:)/.test(href)) continue;
      let target;
      try { target = localHref(file, href); } catch { errors.push(`${path.relative(docs, file)}: invalid ${href}`); continue; }
      if (!target) continue;
      links++;
      if (!existsSync(target.file)) errors.push(`${path.relative(docs, file)}: missing ${href}`);
      else if (target.hash && anchors.has(target.file) && !anchors.get(target.file).has(target.hash)) {
        errors.push(`${path.relative(docs, file)}: missing anchor ${href}`);
      }
    }
  }
  const browserTests = [];
  const noNetwork = [];
  const context = await browser.newContext();
  await context.route(/^https?:/, route => { noNetwork.push(route.request().url()); return route.abort(); });
  const offline = await context.newPage();
  for (const name of chapterFiles) {
    await offline.goto(pathToFileURL(path.join(docs, name)).href);
    await offline.locator('img').evaluateAll(images => images.forEach(img => img.loading = 'eager'));
    await offline.waitForFunction(() => [...document.images].every(img => img.complete), null, { timeout: 20000 });
    const brokenImages = await offline.locator('img').evaluateAll(images => images.filter(img => !img.complete || img.naturalWidth === 0).map(img => img.getAttribute('src')));
    if (brokenImages.length) errors.push(`${name}: images failed ${brokenImages.join(', ')}`);
    browserTests.push(`${name}: rendered without network`);
  }
  await offline.goto(pathToFileURL(path.join(docs, 'dictionary.html')).href);
  const search = offline.locator('[data-dictionary-search]');
  await search.fill('dashboard');
  const matching = await offline.locator('[data-search]:visible').count();
  if (matching < 1) errors.push('Dictionary search did not find dashboard');
  else browserTests.push('Dictionary search returns MemoSim workflow entries');
  await offline.goto(pathToFileURL(path.join(docs, 'tutorial.html')).href);
  if (await offline.locator('form[data-answer]').count()) {
    const quiz = offline.locator('form[data-answer]').first();
    await quiz.locator('[name=answer]').fill(await quiz.getAttribute('data-answer'));
    await quiz.locator('button[type=submit]').click();
    if (!(await quiz.innerText()).includes('Correct.')) errors.push('Tutorial quiz feedback failed');
    else browserTests.push('Tutorial quiz produces feedback offline');
  }
  if (await offline.locator('input[data-progress]').count()) {
    await offline.locator('input[data-progress]').first().check();
    await offline.reload();
    if (!(await offline.locator('input[data-progress]').first().isChecked())) errors.push('Tutorial progress persistence failed');
    else browserTests.push('Tutorial progress persists in browser storage');
  }
  await offline.setViewportSize({ width: 390, height: 844 });
  for (const name of ['index.html', 'dictionary.html', 'legal.html']) {
    await offline.goto(pathToFileURL(path.join(docs, name)).href);
    if (!(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)))
      errors.push(`${name}: overflows mobile viewport`);
    else browserTests.push(`${name}: fits 390px viewport`);
  }
  await offline.goto(pathToFileURL(path.join(docs, 'tutorial.html')).href);
  const fits = await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  if (!fits) {
    const overflow = await offline.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(node => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 8)
      .map(node => `${node.tagName}.${node.className}:${Math.round(node.getBoundingClientRect().width)}`));
    errors.push(`Tutorial overflows mobile viewport: ${overflow.join(', ')}`);
  }
  else browserTests.push('Tutorial fits 390px viewport');
  await context.close();
  if (noNetwork.length) errors.push(`Offline pages attempted external requests: ${noNetwork.join(', ')}`);
  const report = { generatedUTC: new Date().toISOString(), htmlPages: htmlFiles.length, localLinksChecked: links,
    pdfBytes: statSync(path.join(docs, 'manual.pdf')).size, browserTests, errors };
  writeFileSync(path.join(docs, 'validation-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
