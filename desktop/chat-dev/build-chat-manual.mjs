import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const templates = path.join(here, 'chat-manual');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return path.resolve(args[index + 1]);
};
const evidenceRoot = '/Users/lilo-jali/Documents/MemoSim Training Evidence';
const manifestPath = option('--manifest', path.join(evidenceRoot, 'manifest.json'));
const outputPath = option('--output', path.join(evidenceRoot, 'memosim-manual.html'));
const docs = option('--docs', path.join(here, 'manual'));
const check = !args.includes('--no-check');
const require = createRequire(process.env.MEMOSIM_WEB_PACKAGE || '/Users/lilo-jali/Documents/Default Project/netlogo-chat/package.json');
const { chromium } = require('playwright');
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const publicationSafe = value => {
  if (Array.isArray(value)) return value.map(publicationSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicationSafe(item)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\/Users\/[^/\s"<>]+/g, '[local-home]')
    .replace(/\/var\/folders\/[^\s"<>]+/g, '[temporary-path]');
};
const jsonScript = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const slug = value => String(value).normalize('NFKD').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
const hash = data => createHash('sha256').update(data).digest('hex');
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain;charset=utf-8', '.json': 'application/json', '.csv': 'text/csv', '.nlogox': 'application/xml', '.nlogo': 'text/plain;charset=utf-8', '.pdf': 'application/pdf' };
const filesEmbedded = new Map();
const embedFile = file => {
  const fullPath = path.resolve(file);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) throw new Error(`Required embedded file not found: ${fullPath}`);
  if (!filesEmbedded.has(fullPath)) {
    const data = readFileSync(fullPath);
    filesEmbedded.set(fullPath, { bytes: data.length, sha256: hash(data), dataURL: `data:${mimeTypes[path.extname(fullPath).toLowerCase()] || 'application/octet-stream'};base64,${data.toString('base64')}` });
  }
  return filesEmbedded.get(fullPath).dataURL;
};
const evidenceFile = file => path.resolve(path.dirname(manifestPath), file);
const manifestExists = existsSync(manifestPath);
const manifest = manifestExists ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { schemaVersion: 1, scenarios: [], statusReport: [{ title: 'Scenario evidence', status: 'pending', detail: 'No evidence manifest was available when this edition was generated. No chat scenarios have been included.' }] };
if (manifest.schemaVersion !== 1) throw new Error(`Unsupported evidence manifest schemaVersion: ${manifest.schemaVersion}`);
if (!Array.isArray(manifest.scenarios)) throw new Error('Manifest scenarios must be an array.');
const passed = manifest.scenarios.filter(scenario => scenario.tested === true && scenario.status === 'passed');
const scenarioIds = new Set();
for (const scenario of passed) {
  if (!scenario.id || scenarioIds.has(slug(scenario.id))) throw new Error(`Missing or duplicate scenario id: ${scenario.id}`);
  scenarioIds.add(slug(scenario.id));
  if (!['actual-chat', 'scripted-tool-replay'].includes(scenario.evidenceMode)) throw new Error(`${scenario.id}: evidenceMode must distinguish actual-chat from scripted-tool-replay.`);
  if (!scenario.baseModelPath || !scenario.finalModelPath) throw new Error(`${scenario.id}: passed scenarios require downloadable baseModelPath and finalModelPath.`);
  for (const file of [scenario.baseModelPath, scenario.finalModelPath]) {
    if (!file.endsWith('.nlogox')) throw new Error(`${scenario.id}: embedded native models must retain a .nlogox extension.`);
  }
  if (!Array.isArray(scenario.stages) || !scenario.stages.length) throw new Error(`${scenario.id}: passed scenarios require their actual recorded stages.`);
  const screenshots = [...(scenario.screenshots || []), ...scenario.stages.flatMap(stage => stage.screenshots || [])];
  if (!screenshots.length) throw new Error(`${scenario.id}: passed scenarios require at least one actual cropped screenshot.`);
  for (const shot of screenshots) {
    if (!shot.path || !shot.alt || !shot.caption) throw new Error(`${scenario.id}: screenshot path, alt and caption are required.`);
    if (shot.fullPath && path.resolve(evidenceFile(shot.fullPath)) === path.resolve(evidenceFile(shot.path))) throw new Error(`${scenario.id}: screenshot path must identify the crop, not the full frame.`);
  }
  if (scenario.evidenceMode === 'actual-chat' && !scenario.stages.some(stage => stage.prompt && (stage.transcript?.length || stage.tools?.length))) throw new Error(`${scenario.id}: actual-chat scenarios require a recorded prompt and transcript or tool evidence.`);
}
const sourceFiles = ['index.html', 'tutorial.html', 'dictionary.html', 'legal.html'];
const walk = directory => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
const referenceFiles = walk(path.join(docs, 'dict')).filter(file => file.endsWith('.html')).map(file => path.relative(docs, file).split(path.sep).join('/'));
const sourceRecords = [...sourceFiles, ...referenceFiles].map(name => ({ name, html: readFileSync(path.join(docs, name), 'utf8') }));
const assetFiles = walk(docs).filter(file => /\.(png|jpe?g|gif|svg|webp|ico|txt|json|csv|nlogox?|nls)$/i.test(file));
const localAssets = Object.fromEntries(assetFiles.map(file => [pathToFileURL(file).href, embedFile(file)]));
const browser = await chromium.launch({ headless: true, channel: process.env.MEMOSIM_BROWSER_CHANNEL || 'chrome' });
let finalReport;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  await page.route(/^https?:/, route => route.abort());
  await page.goto('about:blank');
  console.log(`Extracting ${sourceRecords.length} documentation sources with the browser DOM.`);
  const extracted = await page.evaluate(({ records, assets, root }) => {
    const parser = new DOMParser();
    const sources = new Map(records.map(record => [record.name, { ...record, document: parser.parseFromString(record.html, 'text/html') }]));
    const selected = new Map();
    const aliases = new Map();
    const dictionary = sources.get('dictionary.html').document;
    const dictionaryIds = new Set([...dictionary.querySelectorAll('main [id]')].map(node => node.id));
    for (const [name, source] of sources) {
      if (!name.startsWith('dict/') || name.startsWith('dict/guides/') || name.endsWith('upstream-notices.html')) { selected.set(name, source); continue; }
      const entries = [...source.document.querySelectorAll('main .dict_entry[id]')];
      const matching = entries.find(entry => dictionaryIds.has(entry.id));
      if (matching && entries.every(entry => dictionaryIds.has(entry.id))) aliases.set(name, matching.id);
      else if (name === 'dict/dictionary.html') aliases.set(name, 'category-reference');
      else selected.set(name, source);
    }
    const safe = value => value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
    const prefix = name => 'doc-' + safe(name.replace(/\.html$/, ''));
    const targetMap = new Map();
    const headings = [];
    const errors = [];
    for (const [name, source] of selected) {
      const main = source.document.querySelector('main');
      if (!main) { errors.push(`${name}: no main element`); continue; }
      targetMap.set(name, prefix(name));
      main.querySelectorAll('[id]').forEach(node => targetMap.set(name + '#' + node.id, prefix(name) + '-' + node.id));
      if (main.id) targetMap.set(name + '#' + main.id, prefix(name));
      if (name === 'index.html') main.querySelectorAll('section>h2[id]').forEach(node => headings.push({ id: prefix(name) + '-' + node.id, title: node.textContent.trim() }));
    }
    for (const [name, anchor] of aliases) {
      const fallback = prefix('dictionary.html') + '-' + anchor;
      targetMap.set(name, fallback);
      sources.get(name).document.querySelectorAll('main [id]').forEach(node => {
        targetMap.set(name + '#' + node.id, dictionaryIds.has(node.id) ? prefix('dictionary.html') + '-' + node.id : fallback);
      });
      targetMap.set(name + '#content', fallback);
    }
    const parts = {};
    for (const [name, source] of selected) {
      const main = source.document.querySelector('main');
      if (!main) continue;
      const fragment = main.cloneNode(true);
      fragment.id = prefix(name);
      if (!['index.html', 'tutorial.html', 'dictionary.html', 'legal.html'].includes(name)) {
        const footer = source.document.querySelector('footer');
        if (footer) fragment.append(footer.cloneNode(true));
      }
      fragment.querySelectorAll('script,style,link[rel=stylesheet]').forEach(node => node.remove());
      fragment.querySelectorAll('*').forEach(node => {
        [...node.attributes].filter(attribute => attribute.name.startsWith('on')).forEach(attribute => node.removeAttribute(attribute.name));
      });
      fragment.querySelectorAll('[id]').forEach(node => { node.id = prefix(name) + '-' + node.id; });
      fragment.querySelectorAll('[for], [aria-labelledby], [aria-describedby], [aria-controls]').forEach(node => {
        ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls'].forEach(attribute => {
          if (node.hasAttribute(attribute)) node.setAttribute(attribute, node.getAttribute(attribute).split(/\s+/).map(id => prefix(name) + '-' + id).join(' '));
        });
      });
      fragment.querySelectorAll('[data-copy-target]').forEach(node => node.dataset.copyTarget = '#' + prefix(name) + '-' + node.dataset.copyTarget.replace(/^#/, ''));
      fragment.querySelectorAll('img,source,video,audio,iframe,object').forEach(node => {
        const attribute = node.tagName === 'OBJECT' ? 'data' : 'src';
        const value = node.getAttribute(attribute);
        if (!value) return;
        if (value.startsWith('data:')) return;
        const full = new URL(value, new URL(name, root));
        if (assets[full.href]) node.setAttribute(attribute, assets[full.href]);
        else errors.push(`${name}: unembedded asset ${value}`);
        node.removeAttribute('srcset');
        if (node.tagName === 'IMG') { node.loading = 'lazy'; node.decoding = 'async'; }
      });
      fragment.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (!href || /^(data:|mailto:|tel:)/i.test(href)) return;
        if (/^javascript:/i.test(href)) { link.removeAttribute('href'); return; }
        const url = new URL(href, new URL(name, root));
        if (/^https?:/.test(url.protocol)) {
          link.classList.add('online-link');
          link.rel = 'noopener noreferrer';
          if (!/online|external|upstream|pinned source|creativecommons/i.test(link.textContent + (link.nextSibling?.textContent || '').slice(0, 35))) link.append(document.createTextNode(' [online]'));
          return;
        }
        const targetName = decodeURIComponent(url.pathname.slice(new URL(root).pathname.length));
        if (targetName === 'manual.pdf' || targetName === 'print-manual.html') { link.setAttribute('href', '#cover'); link.dataset.printLink = ''; return; }
        const key = targetName + (url.hash ? '#' + decodeURIComponent(url.hash.slice(1)) : '');
        const target = targetMap.get(key) || (!url.hash && targetMap.get(targetName));
        if (target) { link.setAttribute('href', '#' + target); return; }
        const assetURL = new URL(url); assetURL.hash = '';
        if (assets[assetURL.href]) { link.setAttribute('href', assets[assetURL.href]); link.setAttribute('download', targetName.split('/').pop()); return; }
        errors.push(`${name}: unresolved local link ${href}`);
      });
      if (name === 'index.html') {
        const offline = [...fragment.querySelectorAll('p')].find(node => node.textContent.startsWith('Offline use:'));
        if (offline) offline.innerHTML = '<strong>Offline use:</strong> this single-file edition embeds the complete manual, local reference, images and downloads. The desktop simulation engine runs locally. Cloud assistant requests and online reference searches need a connection; a separately configured local language-model service has its own availability requirements.';
      }
      const wrapper = document.createElement('div');
      wrapper.id = fragment.id;
      wrapper.className = 'imported';
      wrapper.dataset.sourceDocument = name;
      wrapper.innerHTML = fragment.innerHTML;
      parts[name] = wrapper.outerHTML;
    }
    return { parts, headings, errors, aliases: aliases.size, selected: [...selected.keys()] };
  }, { records: sourceRecords, assets: localAssets, root: pathToFileURL(docs + path.sep).href });
  if (extracted.errors.length) throw new Error(`Documentation extraction failed:\n${extracted.errors.join('\n')}`);
  const paragraph = value => `<p>${escape(pretty(value))}</p>`;
  const records = value => `<pre class="record">${escape(pretty(value))}</pre>`;
  const screenshot = shot => `<figure><img src="${embedFile(evidenceFile(shot.path))}" alt="${escape(shot.alt)}" loading="lazy"><figcaption>${escape(shot.caption)}<br>Source: ${escape(pretty(shot.source || path.basename(shot.fullPath || shot.path)))}${shot.capturedAt ? ` · Captured ${escape(shot.capturedAt)}` : ''}</figcaption></figure>`;
  const transcript = turns => Array.isArray(turns) && turns.length ? turns.map(turn => {
    const content = Array.isArray(turn.parts) ? turn.parts.map(part => {
      if (part.k === 'text' || part.type === 'text') return `<pre>${escape(part.text || '')}</pre>`;
      if (part.k === 'tool' || part.type === 'tool') return `<details><summary>${escape(part.name || 'Tool call')}${typeof part.ok === 'boolean' ? ` · ${part.ok ? 'succeeded' : 'failed'}` : ''}</summary>${records(part)}</details>`;
      return records(part);
    }).join('') : `<pre>${escape(typeof turn.content === 'string' ? turn.content : pretty(turn.content ?? turn))}</pre>`;
    return `<div class="transcript-turn"><strong>${escape(turn.role || 'Recorded turn')}</strong>${content}</div>`;
  }).join('') : paragraph('No separate transcript was supplied for this stage. See its recorded prompt and tool evidence.');
  const download = (file, label) => `<a download="${escape(path.basename(file))}" href="${embedFile(evidenceFile(file))}">${escape(label)} <span aria-hidden="true">↓</span></a>`;
  const experimentTable = batch => !batch ? '' : `<section class="experiment-summary"><h5>Recorded experiment: terminal results</h5><p>${escape(batch.caption)} ${escape(batch.runs)} runs; ${escape(batch.totalRows)} captured rows${batch.truncated ? '; output was truncated' : ''}.</p><div style="overflow:auto"><table><thead><tr>${batch.columns.map(column => `<th>${escape(column)}</th>`).join('')}</tr></thead><tbody>${batch.terminalRows.map(row => `<tr>${row.map(value => `<td>${escape(typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(6)) : value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
  const readingNote = stage => {
    if (stage.why) return paragraph(stage.why);
    const subject = `${stage.title || ''} ${stage.prompt || ''}`.toLowerCase();
    let note = 'Make one deliberate change, then compare the resulting model with its base. Use the recorded tool responses and independent checks to decide whether the requested change was achieved.';
    if (/experiment|behaviorspace|sweep/.test(subject)) note = 'An experiment turns a single observation into a comparison. Read the parameter values, repetitions, stopping rule and measured outputs together. A small teaching run demonstrates a workflow; it does not establish a reliable real-world effect.';
    else if (/inspect the current|without modifying|read.only/.test(subject)) note = 'Inspect before changing anything. Confirm that the assistant is looking at the intended model and that its view of the code, controls and agent counts agrees with the native workspace.';
    else if (/baseline|create a |from scratch/.test(subject)) note = 'A small base gives you something understandable to test. Check initialization, one step, a bounded run and the quantities that should stay constant before adding more behavior. A visible plot is useful only when its reporters measure the intended quantities.';
    else if (/slider|control|switch|add |extend|preserve/.test(subject)) note = 'A control links a question to a model assumption. Compare the base and changed settings, check endpoint values where appropriate, and verify that existing behavior still works. Keep a base export so the change remains reviewable.';
    return `<p class="footnote">EDITORIAL READING NOTE · not an assistant response</p>${paragraph(note)}`;
  };
  const assistantResponse = stage => {
    const text = (stage.transcript || []).filter(turn => turn.role === 'assistant').map(turn => typeof turn.content === 'string' ? turn.content : Array.isArray(turn.parts) ? turn.parts.filter(part => part.k === 'text' || part.type === 'text').map(part => part.text).join('\n\n') : '').filter(Boolean).join('\n\n');
    return text ? `<div class="assistant-record"><p class="eyebrow">ASSISTANT / RECORDED RESPONSE</p><div class="recorded-prose">${escape(text)}</div></div>` : '<p class="footnote">No separate assistant prose was captured for this turn; the tool actions and checks below are the recorded evidence.</p>';
  };
  const limitations = value => value && (!Array.isArray(value) || value.length) ? `<aside class="field-note evidence-limit"><strong>Recorded limitation</strong>${paragraph(pretty(value))}</aside>` : '';
  const scenarioHTML = passed.map((scenario, scenarioIndex) => {
    const id = 'scenario-' + slug(scenario.id);
    const stages = scenario.stages.map((stage, stageIndex) => {
      const stageId = `${id}-stage-${stageIndex + 1}`;
      const panels = [
        ['prompt', 'Prompt', stage.prompt ? `<div class="prompt-card"><div class="prompt-label"><span>YOUR RECORDED PROMPT</span><button type="button" data-copy-prompt="${stageId}-prompt-text">Copy prompt</button></div><p class="prompt-text" id="${stageId}-prompt-text">${escape(stage.prompt)}</p></div>` : paragraph('No chat prompt was recorded for this stage. It is not presented as an assistant conversation.')],
        ['result', 'Result', (stage.result ? paragraph(stage.result) : paragraph('The recorded result is available in the tool and validation evidence.')) + limitations(stage.limitations) + experimentTable(stage.experimentSummary) + assistantResponse(stage) + (stage.screenshots || []).map(screenshot).join('') + (stage.modelPath && stage.modelDownloadStatus !== 'broken-checkpoint' ? `<div class="model-downloads">${download(stage.modelPath, 'Download this stage')}</div>` : stage.modelDownloadStatus === 'broken-checkpoint' ? paragraph('Broken historical export retained in the local test evidence; runnable download intentionally withheld. Continue to the repair stage or use the final model.') : '')],
        ['why', 'Why this step', readingNote(stage)],
        ['test', 'Validation', stage.validation?.length || (stage.validation && !Array.isArray(stage.validation)) ? records(stage.validation) : paragraph('No separate stage validation was supplied. Scenario-level checks are preserved below.')],
        ['tools', 'Transcript & tools', transcript(stage.transcript || []) + (stage.tools ? `<details><summary>Recorded tool calls and responses</summary>${records(stage.tools)}</details>` : paragraph('No separate tool record was supplied for this stage.'))],
      ];
      return `<section class="scenario-stage" role="tabpanel" id="${stageId}" aria-labelledby="${stageId}-tab"${stageIndex ? ' hidden' : ''}><div class="stage-heading"><h4>${escape(stage.title || `Stage ${stageIndex + 1}`)}</h4><label><input type="checkbox" data-progress="${stageId}"> Studied this step</label></div><div class="evidence-tabs" role="tablist" aria-label="${escape(stage.title || 'Stage')} evidence">${panels.map(([name, label], index) => `<button type="button" role="tab" id="${stageId}-${name}-tab" aria-controls="${stageId}-${name}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label}</button>`).join('')}</div>${panels.map(([name, , content], index) => `<div class="evidence-panel" data-panel="${name}" role="tabpanel" id="${stageId}-${name}" aria-labelledby="${stageId}-${name}-tab"${index ? ' hidden' : ''}>${content}</div>`).join('')}</section>`;
    });
    return `<article class="scenario" id="${id}"><header class="scenario-head"><span class="scenario-number">SCENARIO ${String(scenarioIndex + 1).padStart(2, '0')}${scenario.discipline ? ` / ${escape(scenario.discipline).toUpperCase()}` : ''}</span><h3>${escape(scenario.title)}</h3>${scenario.goal ? `<p><strong>Your investigation:</strong> ${escape(scenario.goal)}</p>` : ''}${scenario.summary ? paragraph(scenario.summary) : ''}${scenario.interpretation ? `<p class="field-note"><strong>How to read the result:</strong> ${escape(scenario.interpretation)}</p>` : ''}<span class="evidence-badge ${scenario.evidenceMode === 'scripted-tool-replay' ? 'replay' : ''}">${scenario.evidenceMode === 'actual-chat' ? 'ACTUAL ASSISTANT CHAT · TEST PASSED' : 'SCRIPTED TOOL REPLAY · TEST PASSED · NOT ACTUAL CHAT'}</span>${limitations(scenario.limitations)}<div class="model-downloads">${download(scenario.baseModelPath, 'Base model · .nlogox')}${download(scenario.finalModelPath, 'Final model · .nlogox')}</div>${(scenario.screenshots || []).map(screenshot).join('')}</header><div class="stage-selector" role="tablist" aria-label="${escape(scenario.title)} stages">${scenario.stages.map((stage, index) => `<button type="button" role="tab" id="${id}-stage-${index + 1}-tab" aria-controls="${id}-stage-${index + 1}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${String(index + 1).padStart(2, '0')} / ${escape(stage.title || 'Recorded step')}</button>`).join('')}</div>${stages.join('')}<div class="scenario-stage scenario-record"><details><summary>Complete scenario validation, transcript and tool record</summary>${records({ validation: scenario.validation || [], transcript: scenario.transcript || [], tools: scenario.tools || [], provenance: scenario.provenance || {} })}</details></div></article>`;
  }).join('\n');
  const extraNames = extracted.selected.filter(name => name.startsWith('dict/') && !name.startsWith('dict/guides/') && !name.endsWith('upstream-notices.html'));
  const guideNames = extracted.selected.filter(name => name.startsWith('dict/guides/'));
  const wrapReference = name => `<details class="reference-extra"><summary>${escape(name.split('/').pop().replace('.html', '').replaceAll('-', ' '))}</summary>${extracted.parts[name]}</details>`;
  const omitted = manifest.scenarios.filter(scenario => !passed.includes(scenario));
  const statusItems = [
    ...(manifest.statusReport || []),
    ...omitted.map(scenario => ({ title: scenario.title || scenario.id || 'Scenario', status: scenario.status || 'not verified', detail: scenario.detail || scenario.reason || scenario.error || 'Excluded from the scenario notebook because tested:true and status:passed were not both recorded.' })),
  ];
  const summary = {
    generator: 'chat-dev/build-chat-manual.mjs', templateVersion: 1, appVersion: manifest.appVersion || '1.1.4', generatedAt: new Date().toISOString(),
    manifestPresent: manifestExists, manifestSHA256: manifestExists ? hash(readFileSync(manifestPath)) : null,
    passedScenarios: passed.length, actualChatScenarios: passed.filter(scenario => scenario.evidenceMode === 'actual-chat').length,
    scriptedReplayScenarios: passed.filter(scenario => scenario.evidenceMode === 'scripted-tool-replay').length, excludedScenarios: omitted.length,
    originalUserGuideChapters: extracted.headings.length, documentationSourcesRead: sourceRecords.length,
    splitReferencePagesMappedToGroupedEntries: extracted.aliases, additionalReferencePages: extraNames.length,
    bundledTechnicalGuides: guideNames.length, documentationSourceHashes: Object.fromEntries(sourceFiles.map(name => [name, hash(readFileSync(path.join(docs, name)))])),
    offline: 'All required text, CSS, JavaScript, images, model downloads and local reference content are embedded. Optional online source links are labeled.',
  };
  const sourceProvenance = '<p class="reference-provenance">Reference adapted from the NetLogo User Manual (7.1.0-alpha1), Uri Wilensky, Northwestern University. Copyright 1999–2025 Uri Wilensky. CC BY-SA 3.0 Unported. Full attribution, preserved upstream notices and license texts are included in Credits &amp; licenses.</p>';
  const replacements = {
    '/*__STYLE__*/': readFileSync(path.join(templates, 'manual.css'), 'utf8'),
    '/*__SCRIPT__*/': readFileSync(path.join(templates, 'manual.js'), 'utf8'),
    '<!--__COUNT__-->': String(passed.length),
    '<!--__SCENARIO_NAV__-->': passed.map(scenario => `<a class="scenario-nav" href="#scenario-${slug(scenario.id)}">${escape(scenario.title)}</a>`).join(''),
    '<!--__CHAPTER_NAV__-->': extracted.headings.map(heading => `<a href="#${escape(heading.id)}">${escape(heading.title)}</a>`).join(''),
    '<!--__SCENARIO_INTRO__-->': passed.length ? `<p class="footnote">${passed.length} passed ${passed.length === 1 ? 'scenario' : 'scenarios'} included · ${summary.actualChatScenarios} actual chat · ${summary.scriptedReplayScenarios} scripted replay. Original prompts and repair turns are preserved where recorded.</p>` : '<div class="empty-evidence"><h3>The notebook awaits its evidence.</h3><p>No scenario has been recorded as both tested and passed in the supplied manifest. This edition includes the complete manual and tutorial, but makes no claim of a successful chat scenario. See the evidence status below for pending or blocked runs.</p></div>',
    '<!--__SCENARIOS__-->': scenarioHTML,
    '<!--__USER_GUIDE__-->': extracted.parts['index.html'],
    '<!--__TUTORIAL__-->': extracted.parts['tutorial.html'],
    '<!--__DICTIONARY__-->': extracted.parts['dictionary.html'] + sourceProvenance,
    '<!--__EXTRA_REFERENCE__-->': extraNames.length ? `<h3>Additional language entries</h3>${extraNames.map(wrapReference).join('')}` : '',
    '<!--__TECHNICAL_GUIDES__-->': guideNames.map(wrapReference).join('') + sourceProvenance,
    '<!--__LEGAL__-->': extracted.parts['legal.html'],
    '<!--__NOTICES__-->': `<details class="reference-extra"><summary>Preserved upstream copyright and third-party notices</summary>${extracted.parts['dict/upstream-notices.html'] || ''}</details>${['GPL-2.0.txt', 'CC-BY-SA-3.0.txt'].map(name => `<details class="reference-extra"><summary>${escape(name.replace('.txt', ''))} · complete license text</summary><pre class="license-text">${escape(readFileSync(path.join(docs, 'licenses', name), 'utf8'))}</pre></details>`).join('')}`,
    '<!--__STATUS__-->': `<p class="section-lead">${passed.length} passed scenarios are included. ${omitted.length} unverified, failed or blocked scenarios are excluded from the notebook. A replay is labeled as a replay, even when its native-model checks pass.</p>${statusItems.length ? `<table class="status-table"><thead><tr><th scope="col">ITEM</th><th scope="col">STATUS</th><th scope="col">RECORDED DETAIL</th></tr></thead><tbody>${statusItems.map(item => `<tr><td>${escape(item.title || item.id || 'Evidence')}</td><td>${escape(item.status || 'recorded')}</td><td>${escape(pretty(item.detail ?? item.reason ?? item))}</td></tr>`).join('')}</tbody></table>` : '<p>No additional blocking status was recorded in the manifest.</p>'}`,
    '<!--__BUILD_RECORD__-->': escape(pretty(summary)),
    '<!--__EVIDENCE_DATA__-->': jsonScript(publicationSafe({ ...manifest, scenarios: passed, excludedScenarios: omitted.map(scenario => ({ id: scenario.id, title: scenario.title, tested: scenario.tested, status: scenario.status, reason: scenario.reason || scenario.error || scenario.detail })), build: summary })),
  };
  let html = readFileSync(path.join(templates, 'shell.html'), 'utf8');
  for (const [token, value] of Object.entries(replacements)) html = html.replace(token, () => value);
  html = publicationSafe(html);
  if (/\/\*__(?:STYLE|SCRIPT)__\*\/|<!--__[A-Z_]+__-->/.test(html)) throw new Error('Unresolved template token remains.');
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html);
  console.log(`Generated ${outputPath} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB), ${passed.length} passed scenarios.`);
  finalReport = { ...summary, outputPath, outputBytes: Buffer.byteLength(html), outputSHA256: hash(html), embeddedFiles: [...filesEmbedded].map(([file, record]) => ({ file: path.relative(docs, file), bytes: record.bytes, sha256: record.sha256 })), checks: [], errors: [] };
  if (check) {
    const network = [];
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
    await context.route(/^https?:/, route => { network.push(route.request().url()); return route.abort(); });
    const offline = await context.newPage();
    offline.on('pageerror', error => errors.push(error.message));
    await offline.goto(pathToFileURL(outputPath).href, { waitUntil: 'load' });
    await offline.locator('img').evaluateAll(images => images.forEach(image => { image.loading = 'eager'; }));
    await offline.waitForFunction(() => [...document.images].every(image => image.complete), null, { timeout: 30000 });
    const structural = await offline.evaluate(() => {
      const ids = new Set(); const duplicateIds = []; const brokenAnchors = []; const dependencies = [];
      document.querySelectorAll('[id]').forEach(node => { if (ids.has(node.id)) duplicateIds.push(node.id); ids.add(node.id); });
      document.querySelectorAll('a[href^="#"]').forEach(link => { if (!document.getElementById(decodeURIComponent(link.hash.slice(1)))) brokenAnchors.push(link.getAttribute('href')); });
      document.querySelectorAll('img[src],script[src],link[rel=stylesheet],source[src],iframe[src],object[data]').forEach(node => {
        const src = node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('data');
        if (src && !src.startsWith('data:')) dependencies.push(src);
      });
      document.querySelectorAll('a[href]').forEach(link => { const href = link.getAttribute('href'); if (!/^(#|data:|https?:|mailto:|tel:)/.test(href)) dependencies.push(href); });
      return { duplicateIds, brokenAnchors, dependencies, brokenImages: [...document.images].filter(image => !image.naturalWidth).map(image => image.alt), scenarioCount: document.querySelectorAll('.scenario').length, chapters: document.querySelectorAll('[data-source-document="index.html"] section>h2[id]').length };
    });
    for (const [key, values] of Object.entries(structural)) if (Array.isArray(values) && values.length) errors.push(`${key}: ${values.slice(0, 12).join(', ')}`);
    if (structural.chapters !== 15) errors.push(`Expected 15 preserved user-guide chapters; found ${structural.chapters}.`);
    if (structural.scenarioCount !== passed.length) errors.push('Rendered scenario count differs from verified manifest count.');
    finalReport.checks.push('Self-contained file:// load with network blocked; all images decoded; local anchors, IDs and asset dependencies audited.', 'All 15 original user-manual chapters preserved.');
    await offline.locator('#search-open').click();
    await offline.locator('#full-search').fill('random-seed');
    await offline.waitForFunction(() => document.querySelectorAll('#search-results li').length > 0);
    finalReport.checks.push('Full-content search finds language-reference passages.');
    await offline.locator('#search-results a').first().click();
    if (await offline.locator('#search-dialog').evaluate(dialog => dialog.open)) errors.push('Search result did not close the dialog.');
    const progressInput = offline.locator('input[data-progress]').first();
    if (await progressInput.count()) {
      await progressInput.check({ force: true });
      await offline.reload();
      if (!await progressInput.isChecked()) errors.push('Progress was not restored after reload.');
      await progressInput.uncheck({ force: true });
      finalReport.checks.push('Reading progress persists across reload and can be reset.');
    }
    const dictionaryInput = offline.locator('[data-dictionary-search]').first();
    if (await dictionaryInput.count()) {
      await dictionaryInput.fill('random-seed');
      if (!await offline.locator('[data-search]:not([hidden])').count()) errors.push('Dictionary filter returned no random-seed entry.');
      await dictionaryInput.fill('');
      finalReport.checks.push('Embedded dictionary filtering works offline.');
    }
    if (passed.length) {
      await offline.locator('.scenario').first().scrollIntoViewIfNeeded();
      const firstScenario = offline.locator('.scenario').first();
      for (const tab of await firstScenario.locator('.stage-selector [role=tab]').all()) await tab.click();
      const currentStage = firstScenario.locator('.scenario-stage[role=tabpanel]:not([hidden])');
      for (const tab of await currentStage.locator('.evidence-tabs [role=tab]').all()) await tab.click();
      await firstScenario.locator('.stage-selector [role=tab]').first().click();
      await firstScenario.locator('.evidence-tabs').first().locator('[role=tab]').first().click();
      const copyButton = firstScenario.locator('[data-copy-prompt]').first();
      if (await copyButton.count()) {
        await offline.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('Test local clipboard fallback')) } }));
        await copyButton.click();
        await offline.locator('#copy-dialog').waitFor({ state: 'visible' });
        if (!await offline.locator('#copy-fallback').inputValue()) errors.push('Clipboard fallback contains no prompt.');
        await offline.locator('#copy-close').click();
      }
      const modelLink = firstScenario.locator('a[download]').first();
      const [modelDownload] = await Promise.all([offline.waitForEvent('download'), modelLink.click()]);
      if (!modelDownload.suggestedFilename().endsWith('.nlogox')) errors.push('Model download did not retain .nlogox filename.');
      finalReport.checks.push('Scenario stage/evidence tabs, copy fallback and native model download tested.');
    }
    const layoutChecks = [];
    for (const width of [1440, 1024, 768, 390, 320]) {
      await offline.setViewportSize({ width, height: 1050 });
      await offline.evaluate(() => window.scrollTo(0, 0));
      const overflow = await offline.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (overflow) errors.push(`Horizontal document overflow at ${width}px.`);
      else finalReport.checks.push(`Responsive document fits ${width}px viewport.`);
      const cover = await offline.evaluate(() => {
        const bounds = document.querySelector('.cover').getBoundingClientRect();
        const title = document.querySelector('.cover h1').getBoundingClientRect();
        const diagram = document.querySelector('.cover-art').getBoundingClientRect();
        const clip = [...document.querySelectorAll('.cover-copy, .cover-top, .cover-bottom')].flatMap(node => [...node.querySelectorAll('*')]).filter(node => {
          const range = document.createRange(); range.selectNodeContents(node);
          const rect = range.getBoundingClientRect();
          return rect.width && (rect.right > bounds.right + 1 || rect.left < bounds.left - 1);
        }).map(node => node.tagName + ':' + node.textContent.slice(0, 50));
        return { clippedText: [...new Set(clip)], titleWidth: Math.round(title.width), illustrationWidth: Math.round(diagram.width) };
      });
      if (cover.clippedText.length) errors.push(`Cover text clips at ${width}px: ${cover.clippedText.join(', ')}`);
      layoutChecks.push({ width, ...cover });
    }
    finalReport.layoutChecks = layoutChecks;
    await offline.locator('#menu-toggle').click();
    if (!await offline.locator('#sidebar').isVisible()) errors.push('Mobile contents did not open.');
    await offline.locator('#menu-toggle').click();
    await offline.setViewportSize({ width: 1440, height: 1050 });
    await offline.screenshot({ path: path.join(templates, 'cover-desktop.png'), fullPage: false });
    await offline.setViewportSize({ width: 390, height: 844 });
    await offline.screenshot({ path: path.join(templates, 'cover-mobile.png'), fullPage: false });
    await offline.emulateMedia({ media: 'print' });
    await offline.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    if (await offline.locator('main details:not([open])').count()) errors.push('Print workflow did not expand reference and tutorial details.');
    const printPanels = await offline.locator('.scenario-stage[role=tabpanel], .evidence-panel').evaluateAll(panels => panels.filter(panel => getComputedStyle(panel).display === 'none').length);
    if (printPanels) errors.push(`${printPanels} scenario panels remain hidden in print.`);
    await offline.screenshot({ path: path.join(templates, 'cover-print.png'), fullPage: false });
    await offline.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    finalReport.checks.push('Mobile contents toggle and print expansion verified.');
    if (network.length) errors.push(`Unexpected network requests: ${network.join(', ')}`);
    finalReport.networkRequests = network;
    finalReport.errors = errors;
    await context.close();
  }
  writeFileSync(path.join(templates, 'build-report.json'), JSON.stringify(finalReport, null, 2) + '\n');
  console.log(JSON.stringify({ outputPath, bytes: finalReport.outputBytes, scenarios: finalReport.passedScenarios, checks: finalReport.checks, errors: finalReport.errors }, null, 2));
  if (finalReport.errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
