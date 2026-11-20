// Regenerate the offline dictionary from the official NetLogo/docs checkout.
// node chat-dev/build-dictionary.mjs [path/to/docs/7.1.0-alpha1]
// Requires Playwright and Chromium at build time only. Set PLAYWRIGHT_MODULE to
// an absolute module path if Playwright isn't in a workspace node_modules.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = '7.1.0-alpha1';
const revision = '8e165bbbe204b417e899413d097265592f98a951';
const copyright = 'Copyright 1999-2025 by Uri Wilensky.';
const license = 'Creative Commons Attribution-ShareAlike 3.0 Unported';
const licenseUrl = 'https://creativecommons.org/licenses/by-sa/3.0/';
const root = resolve(process.argv[2] || process.env.MEMOSIM_UPSTREAM_DOCS ||
  `/var/folders/qf/6__8q28n29987tjw4y11rv800000gn/T/kilo/memosim-upstream-docs/${engine}`);
const manual = fileURLToPath(new URL('./manual/', import.meta.url));
const dict = 'dictionary.html';
const notices = 'dict/upstream-notices.html';
const quickHelp = 'dict/quickhelp.csv';
const guideRoot = 'dict/guides';
const guideFiles = ['programming.html', 'extensions.html', '3d.html', 'hubnet-authoring.html', 'shapes.html'];
const website = `https://docs.netlogo.org/${engine}/`;
const terms = JSON.parse(await readFile(join(manual, 'memosim-terms.json'), 'utf8'));
const read = file => readFile(join(root, file), 'utf8');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const date = git('show', '-s', '--format=%cI', 'HEAD');
if (basename(root) !== engine || git('rev-parse', 'HEAD') !== revision ||
    git('status', '--porcelain', '--untracked-files=all', '--', '.') ||
    !/^https:\/\/github\.com\/NetLogo\/docs(?:\.git)?$/.test(git('remote', 'get-url', 'origin'))) {
  throw new Error(`Expected the clean official NetLogo/docs ${revision} checkout at ${root}`);
}

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch (cause) {
  throw new Error('Install Playwright with Chromium or set PLAYWRIGHT_MODULE to an existing Playwright module.', { cause });
}

const files = (await readdir(join(root, 'dict'), { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.html'))
  .map(entry => `dict/${entry.name}`).sort();
const loaded = new Map();
const browser = await playwright.chromium.launch();
try {
  const page = await browser.newPage({ offline: true });
  const sourceFiles = [dict, 'copyright.html', ...guideFiles, ...files];
  // Parse inert server-rendered HTML. Never navigate to upstream pages or run their JS.
  for (let offset = 0; offset < sourceFiles.length; offset += 16) {
    const batch = await Promise.all(sourceFiles.slice(offset, offset + 16).map(async file => [file, await read(file)]));
    const fragments = await page.evaluate(({ batch, website, guideFiles }) => batch.map(([file, html]) => {
      const template = document.createElement('template');
      template.innerHTML = html;
      const selectors = file.startsWith('dict/') ? 'article.prose' : 'main.prose';
      const article = template.content.querySelector(selectors);
      if (!article) throw new Error(`Missing server-rendered article: ${file}`);

      article.querySelectorAll('header,footer,nav,script,style,noscript').forEach(node => node.remove());
      const comments = document.createTreeWalker(article, NodeFilter.SHOW_COMMENT);
      const remove = [];
      while (comments.nextNode()) remove.push(comments.currentNode);
      remove.forEach(node => node.remove());
      const attrs = new Set(['id', 'class', 'role', 'title', 'aria-label', 'aria-hidden', 'href', 'src',
        'alt', 'width', 'height', 'lang', 'dir', 'start', 'value']);
      const tags = new Set('a b blockquote br code dd div dl dt em h1 h2 h3 h4 h5 h6 hr i img kbd li ol p pre samp small span strong sub sup table tbody td th thead tr ul var'.split(' '));
      for (const node of article.querySelectorAll('*')) {
        if (!tags.has(node.localName)) throw new Error(`${file}: unexpected article element ${node.localName}`);
        for (const key of node.getAttributeNames()) if (!attrs.has(key)) node.removeAttribute(key);
      }

      const title = article.querySelector('h1')?.textContent.trim();
      const compact = text => text.trim().replace(/\s+/g, ' ');
      const names = [...article.querySelectorAll('h3 > a[aria-label^="Reference to "]')]
        .map(node => node.getAttribute('aria-label').slice('Reference to '.length))
        .filter(name => !/^[-+*/^<>=!]+$/.test(name) || /^[+*\-/^<>!=]+$/.test(name));
      const heading = article.querySelector('h3,h2,h4');
      if (!names.length && heading) names.push(compact(heading.textContent));
      const primary = article.querySelector('.dict_entry[id]')?.id;
      if (file === 'dictionary.html') {
        const heading = article.querySelector('h1');
        const section = document.createElement('h2');
        section.id = 'category-reference';
        section.textContent = 'Complete NetLogo reference by category';
        heading.replaceWith(section);
      } else {
        const heading = article.querySelector('h1');
        if (heading) {
          const section = document.createElement('h2');
          for (const attribute of heading.getAttributeNames()) section.setAttribute(attribute, heading.getAttribute(attribute));
          section.innerHTML = heading.innerHTML;
          heading.replaceWith(section);
        }
      }
      const rawLinks = [...article.querySelectorAll('a[href]')].map(link => [link.getAttribute('href'),
        compact(link.textContent), link.classList.contains('netlogo-wiki-link')]);
      const namedGroups = [...article.querySelectorAll('.dict_entry[id]')].map(node => node.id);
      if (file === 'dictionary.html' && namedGroups.length < 350) throw new Error('Incomplete upstream dictionary');
      const ids = new Set();
      for (const node of article.querySelectorAll('[id]')) {
        // Upstream sometimes gives the enclosing entry and its heading the same ID.
        if (ids.has(node.id)) node.removeAttribute('id');
        else ids.add(node.id);
      }
      const repaired = [];
      for (const link of article.querySelectorAll('.section-heading[id] > a[href^="#"]')) {
        const original = link.getAttribute('href').slice(1);
        const headingId = link.parentElement.id;
        // The renderer sometimes emits different punctuation in the heading ID and its self-link.
        if (!ids.has(original) && original.replace(/-/g, '') === headingId.replace(/-/g, '')) {
          const alias = document.createElement('span');
          alias.id = original;
          link.parentElement.prepend(alias);
          ids.add(original);
          repaired.push(original);
        }
      }
      for (const pre of article.querySelectorAll('pre:has(code)')) {
        pre.classList.add('copy-code');
        pre.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
      }
      // Mark URL slots in the serialized HTML so Node can resolve cross-page targets centrally.
      const slots = [];
      article.querySelectorAll('a[href],img[src]').forEach(node => {
        const attribute = node.localName === 'img' ? 'src' : 'href';
        const raw = node.getAttribute(attribute);
        slots.push([attribute, raw]);
        node.setAttribute(attribute, `MEMOSIM_OFFLINE_URL_${slots.length - 1}`);
        const dest = new URL(raw, new URL(file, website));
        const route = dest.pathname.slice(new URL(website).pathname.length).replace(/\/$/, '').replace(/\.html$/, '');
        const importedGuide = guideFiles.some(name => name.replace(/\.html$/, '') === route);
        if (attribute === 'href' && dest.hostname === 'docs.netlogo.org' &&
            !importedGuide &&
            !/^(?:dictionary(?:\.html)?|copyright(?:\.html)?|dict\/.*)$/.test(route)) {
          node.append(' (upstream, online)');
        }
      });
      return [file, { primary, names, text: compact(article.textContent), ids: [...ids], namedGroups, repaired,
        title, rawLinks, slots, html: article.innerHTML,
        codeBlocks: article.querySelectorAll('pre').length }];
    }), { batch, website, guideFiles });
    for (const [file, fragment] of fragments) loaded.set(file, fragment);
  }
} finally {
  await browser.close();
}

const credits = loaded.get('copyright.html');
if (!credits.text.includes(copyright) || !credits.text.includes(license) || !credits.rawLinks.some(([url]) => url === licenseUrl)) {
  throw new Error('Upstream manual copyright or CC BY-SA version did not match the expected notice');
}
const combined = loaded.get(dict);
const guideOutputs = new Map(guideFiles.map(file => [file, `${guideRoot}/${file}`]));
const media = new Map();
const unresolved = new Set();
const upstream = new Set();
const external = new Set();
const fixes = new Set();
let localLinks = 0;
const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const decode = text => { try { return decodeURIComponent(text); } catch { return text; } };
const hashOf = fragment => fragment ? `#${encodeURIComponent(fragment)}` : '';
const outputFor = file => file === 'copyright.html' ? notices : guideOutputs.get(file) ?? file;
const relativeTo = (file, target) => posix.relative(posix.dirname(outputFor(file)), target);
const canonical = url => decode(url.pathname.slice(new URL(website).pathname.length))
  .replace(/\/$/, '').replace(/\.html$/, '') || 'index';
const asHtml = route => route.endsWith('.html') ? route : `${route}.html`;
const asSourceUrl = file => new URL(file.replace(/\.html$/, ''), website);
// The pinned combined dictionary contains the 2D groups; the split directory also contains 3D groups.
const variants = new Map(files.map(file => {
  const { primary } = loaded.get(file);
  return [file, Boolean(primary && !combined.namedGroups.includes(primary))];
}));

// The original index may list special forms or variables that don't have their own heading.
const categoryAliases = new Map();
for (const [href, text, wiki] of combined.rawLinks) {
  const url = new URL(href, asSourceUrl(dict));
  if (wiki && url.origin === new URL(website).origin && canonical(url) === 'dictionary' && url.hash && text &&
      combined.ids.includes(decode(url.hash.slice(1)))) {
    const group = decode(url.hash.slice(1));
    if (!categoryAliases.has(group)) categoryAliases.set(group, new Set());
    categoryAliases.get(group).add(text);
  }
}
const aliases = new Map([['dx', 'dict/dxy.html'], ['dy', 'dict/dxy.html'], ['tilt-up', 'dict/tilt-cmds.html']]);
const anchorAliases = new Map([
  ['__includes', ['includes', '__includes-filename']],
  ['pcor', ['built-in-variables']],
  ['builtinvariables', ['built-in-variables']],
  ['3d-worlds', ['_3d-worlds']]
]);
const runtimeAliases = new Map([
  ['autoplot-off', ['2d', 'dict/auto-plot-status']], ['autoplot-on', ['2d', 'dict/auto-plot-status']],
  ['autoplot-x-off', ['2d', 'dict/auto-plot-status']], ['autoplot-x-on', ['2d', 'dict/auto-plot-status']],
  ['autoplot-y-off', ['2d', 'dict/auto-plot-status']], ['autoplot-y-on', ['2d', 'dict/auto-plot-status']],
  ['face-nowrap', ['2d', 'dict/face']], ['facexy-nowrap', ['2d', 'dict/facexy']],
  ['facexyz', ['3d', 'dict/face-3d']], ['histogram-from', ['2d', 'dict/histogram']],
  ['hubnet-set-client-interface', ['2d', 'dict/hubnet-enter-message']], ['if-else', ['2d', 'dict/ifelse']],
  ['load-shapes-3d', ['3d', 'dict/load-shapes-3d']], ['movie-cancel', ['2d', 'dict/movie']],
  ['movie-close', ['2d', 'dictionary']], ['movie-grab-interface', ['2d', 'dictionary']],
  ['movie-grab-view', ['2d', 'dictionary']], ['movie-set-frame-rate', ['2d', 'dictionary']],
  ['movie-start', ['2d', 'dictionary']], ['orbit-down', ['3d', 'dict/orbit-cmds']],
  ['orbit-left', ['3d', 'dict/orbit-cmds']], ['orbit-right', ['3d', 'dict/orbit-cmds']],
  ['orbit-up', ['3d', 'dict/orbit-cmds']], ['pendown', ['2d', 'dict/pen-switch-status']],
  ['penup', ['2d', 'dict/pen-switch-status']], ['roll-left', ['3d', 'dict/roll-left']],
  ['roll-right', ['3d', 'dict/roll-right']], ['setxyz', ['3d', 'dict/setxyz']],
  ['tilt-down', ['3d', 'dict/tilt-cmds']], ['tilt-up', ['3d', 'dict/tilt-cmds']],
  ['zoom', ['3d', 'dict/zoom']], ['autoplot-x?', ['2d', 'dict/autoplot']],
  ['autoplot-y?', ['2d', 'dict/autoplot']], ['distance-nowrap', ['2d', 'dict/distance']],
  ['distancexy-nowrap', ['2d', 'dict/distancexy']], ['distancexyz', ['3d', 'dict/distance-3d']],
  ['distancexyz-nowrap', ['3d', 'dict/distance-3d']], ['dz', ['3d', 'dict/dz']],
  ['in-cone-nowrap', ['2d', 'dict/in-cone']], ['in-radius-nowrap', ['2d', 'dict/in-radius']],
  ['is-command-task?', ['2d', 'dictionary']], ['is-reporter-task?', ['2d', 'dictionary']],
  ['link-pitch', ['3d', 'dictionary']], ['max-pzcor', ['3d', 'dict/min-max-pzcor']],
  ['min-pzcor', ['3d', 'dict/min-max-pzcor']], ['movie-status', ['2d', 'dictionary']],
  ['neighbors6', ['3d', 'dict/neighbors-3d']],
  ['patch-at-heading-pitch-and-distance', ['3d', 'dict/patch-at-heading-pitch-and-distance']],
  ['random-or-random-float', ['2d', 'dictionary']], ['random-pzcor', ['3d', 'dict/random-pzcor']],
  ['random-zcor', ['3d', 'dict/random-zcor']], ['run-result', ['2d', 'dict/runresult']],
  ['task', ['2d', 'dictionary']], ['towards-nowrap', ['2d', 'dict/towards']],
  ['towards-pitch', ['3d', 'dict/towards-pitch']], ['towards-pitch-nowrap', ['3d', 'dict/towards-pitch']],
  ['towards-pitch-xyz', ['3d', 'dict/towards-pitch-xyz']],
  ['towards-pitch-xyz-nowrap', ['3d', 'dict/towards-pitch-xyz']],
  ['towardsxy-nowrap', ['2d', 'dict/towardsxy']], ['world-depth', ['3d', 'dict/world-depth']],
  ['resize-world', ['3d', 'dict/resize-world']]
]);

function resolveUrl(file, kind, raw) {
  const url = new URL(raw, asSourceUrl(file));
  const sameDocs = url.origin === new URL(website).origin && url.pathname.startsWith(new URL(website).pathname);
  const fragment = decode(url.hash.slice(1));
  const route = sameDocs ? canonical(url) : '';
  if (kind === 'src') {
    if (!sameDocs || !/^_content\/images\/[a-z0-9_./-]+\.webp$/i.test(route) || route.split('/').includes('..')) {
      throw new Error(`Unsafe or unexpected dictionary image: ${raw} in ${file}`);
    }
    const target = `assets/dict/${guideFiles.includes(file) ? 'guides/' : ''}${route.slice('_content/images/'.length)}`;
    media.set(target, route);
    return relativeTo(file, target);
  }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error(`Unsupported link protocol in ${file}: ${raw}`);
  if (!sameDocs) {
    external.add(url.href);
    return url.href;
  }

  if (route === 'dictionary' && ['builtinvariables', 'built-in-variables'].includes(fragment)) {
    const local = `${relativeTo(file, dict)}#built-in-variables`;
    localLinks++;
    fixes.add(`dictionary.html#${fragment} -> ${local}`);
    return local;
  }

  const guide = guideFiles.find(name => name.replace(/\.html$/, '') === route);
  const target = guide ? guideOutputs.get(guide) : asHtml(route);
  const sourceTarget = guide ?? target;
  const entry = loaded.get(sourceTarget);
  if (!entry) {
    upstream.add(url.href);
    return url.href;
  }
  let localTarget = target;
  let anchor = fragment;
  if (fragment && !entry.ids.includes(fragment)) {
    const equivalent = entry.ids.find(id => id.toLowerCase() === fragment.toLowerCase());
    const split = aliases.get(fragment) ?? files.find(name => name === `dict/${fragment}.html`);
    const mappedAnchor = anchorAliases.get(fragment)?.find(id => entry.ids.includes(id));
    if (equivalent) anchor = equivalent;
    else if (mappedAnchor) anchor = mappedAnchor;
    else if (guide === 'programming.html' && fragment === 'variadic') {
      // The published guide links to an anchor that does not exist; retain its local page.
      fixes.add(`${sourceTarget}#${fragment} -> ${relativeTo(file, target)}`);
      localLinks++;
      return relativeTo(file, target) + url.search;
    }
    else if (split && target === dict) {
      localTarget = split;
      anchor = loaded.get(split).primary;
    } else {
      // The upstream page has no matching ID; retain its local page destination without a dead fragment.
      anchor = '';
    }
    fixes.add(`${sourceTarget}#${fragment} -> ${localTarget}${hashOf(anchor)}`);
  }
  localLinks++;
  return (localTarget === file && anchor ? '' : relativeTo(file, outputFor(localTarget))) + url.search + hashOf(anchor);
}

function render(file) {
  const { html, slots } = loaded.get(file);
  return html.replace(/href="MEMOSIM_OFFLINE_URL_(\d+)"|src="MEMOSIM_OFFLINE_URL_(\d+)"/g, (_, href, src) => {
    const [attribute, raw] = slots[Number(href ?? src)];
    return `${attribute}="${escape(resolveUrl(file, attribute, raw))}"`;
  });
}

function shell(file, title, body) {
  const location = outputFor(file);
  const prefix = location.startsWith(`${guideRoot}/`) ? '../../' : location.startsWith('dict/') ? '../' : '';
  const sourceFile = guideFiles.includes(file) ? file : file;
  const source = `https://github.com/NetLogo/docs/blob/${revision}/${engine}/${sourceFile}`;
  const nav = [['index.html', 'User manual'], ['tutorial.html', 'Tutorial'], [dict, 'Dictionary'],
    ['legal.html', 'Licenses &amp; credits'], ['manual.pdf', 'PDF manual']];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  <link rel="icon" href="${prefix}assets/memosim-icon.png" type="image/png">
  <link rel="stylesheet" href="${prefix}docs.css">
  <script src="${prefix}docs.js" defer></script>
</head>
<body data-manual="dictionary">
  <a class="skip-link" href="#content">Skip to dictionary content</a>
  <header><a class="brand" href="${prefix}index.html">MemoSim <small>Offline documentation</small></a></header>
  <nav aria-label="Main">${nav.map(([href, text]) => `<a href="${prefix}${href}"${href === dict && file === dict ? ' aria-current="page"' : ''}>${text}</a>`).join(' ')}</nav>
  <main id="content">
${body}
  </main>
  <footer>
    <p>NetLogo User Manual (${engine}), by Uri Wilensky, Center for Connected Learning and Computer-Based Modeling, Northwestern University. ${copyright} Adapted for MemoSim by changing the page layout, navigation and links. The adapted reference material is licensed under <a rel="license" href="${licenseUrl}">${license}</a>.</p>
    <p><a href="${prefix}${notices}">Upstream copyright and third-party notices</a> · <a href="${source}">Pinned source: NetLogo/docs ${revision.slice(0, 7)}</a> (${date.slice(0, 10)}) · <a href="${asSourceUrl(file).href}">Original upstream page (online)</a></p>
  </footer>
</body>
</html>
`;
}

const normalize = value => value.trim().toLowerCase();
const rows = [];
for (const file of files) {
  const page = loaded.get(file);
  if (!page.primary) continue; // The split export also contains a heading-only dictionary stub.
  const names = new Set(page.names);
  if (!variants.get(file)) for (const alias of categoryAliases.get(page.primary) ?? []) names.add(alias);
  const mode = variants.get(file) ? '3d' : '2d';
  const qualifier = mode === '3d' ? 'NetLogo 3D reference' : 'NetLogo language reference';
  for (const name of names) rows.push({ name, file, qualifier, page, mode });
}
// Constants are listed as values in the upstream groups, not individual article headings.
for (const [group, names] of [
  ['mathconstants', ['e', 'pi']],
  ['boolconstants', ['false', 'true']],
  ['colorconstants', ['black', 'gray', 'white', 'red', 'orange', 'brown', 'yellow', 'green', 'lime', 'turquoise', 'cyan', 'sky', 'blue', 'violet', 'magenta', 'pink']]
]) {
  const file = `dict/${group}.html`;
  for (const name of names) rows.push({ name, file, qualifier: 'NetLogo language reference', page: loaded.get(file), mode: '2d' });
}
for (const [name, [mode, route]] of runtimeAliases) {
  let file = route === 'dictionary' ? dict : `${route}.html`;
  if (!loaded.has(file)) file = `${dict}#primitives-and-commands`;
  const exists = rows.some(row => normalize(row.name) === name &&
    (row.mode ?? (variants.get(row.file) ? '3d' : '2d')) === mode);
  if (!exists) rows.push({ name, file, qualifier: `NetLogo ${mode} runtime token`, page: file === dict || file.startsWith(`${dict}#`)
    ? combined : loaded.get(file), mode });
}
const represented = new Set(rows.map(row => normalize(row.name)));
for (const [group, aliases] of categoryAliases) {
  if (!combined.ids.includes(group)) continue;
  for (const alias of aliases) if (!represented.has(normalize(alias))) {
    rows.push({ name: alias, file: `${dict}${hashOf(group)}`, qualifier: 'NetLogo language reference', page: combined, mode: '2d' });
    represented.add(normalize(alias));
  }
}
rows.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.file.localeCompare(b.file, 'en'));

const termsHtml = terms.map(({ name, section, keywords, definition }) =>
  `<li data-search="${escape(`${name} ${keywords} ${definition}`)}"><strong>${escape(name)}</strong><p>${escape(definition)}</p><small><a href="index.html#${escape(section)}">User manual</a></small></li>`).join('\n');
const rowsHtml = rows.map(({ name, file, qualifier, page }) => {
  // Include article prose and examples, not just the filename; avoid duplicating the entire index for category-only names.
  const text = page === combined ? '' : page.text;
  return `<li data-search="${escape(`${name} ${qualifier} ${text}`)}"><a href="${escape(file)}"><code>${escape(name)}</code></a><small>${qualifier}</small></li>`;
}).join('\n');
const mappings = new Map();
for (const { name, file, mode: entryMode } of rows) {
  const key = normalize(name);
  if (!key || /[,\s]/.test(key)) continue;
  const mode = entryMode ?? (variants.get(file) ? '3d' : '2d');
  const route = file.replace(/\.html(?=#|$)/, '');
  if (!mappings.has(`${key},${mode}`)) mappings.set(`${key},${mode}`, route);
}
const csv = [...mappings].map(([key, route]) => {
  const [name, mode] = key.split(',');
  return `${name},${mode},${route},offline`;
}).join('\n') + '\n';
const dictionary = shell(dict, 'MemoSim Dictionary', `    <h1>MemoSim Dictionary</h1>
    <p class="lead">Search the offline NetLogo ${engine} language reference and the MemoSim workflow glossary. MemoSim uses the NetLogo language and engine with unchanged primitive names, syntax and semantics.</p>
    <p class="callout">MemoSim workflow terms describe the application and its modeling tools; they are not executable primitives. The reference works offline; links marked <em>online</em> open material outside the bundle.</p>
    <nav class="toc" aria-label="Dictionary sections"><a href="#language-index">Language index</a> <a href="#memosim-workflow">MemoSim workflow terms</a> <a href="#category-reference">Complete reference by category</a></nav>
    <div class="search-box"><label for="dictionary-search">Search names, descriptions and code</label>
      <input id="dictionary-search" type="search" data-dictionary-search placeholder="Try ask, random seed, or Live dashboard" autocomplete="off" aria-describedby="dictionary-result-count">
      <p id="dictionary-result-count" data-result-count role="status">${rows.length + terms.length} entries</p>
      <noscript><p>Enable JavaScript to filter as you type. The lists and reference remain available without it.</p></noscript>
    </div>
    <section aria-labelledby="language-index"><h2 id="language-index">NetLogo language index</h2>
      <p>${rows.length} index entries, including aliases, operators, variables, keywords, and 3D entries. The 3D reference applies to the 3D engine, not the standard 2D dashboard.</p>
      <ul class="dictionary-list">${rowsHtml}</ul>
    </section>
    <section aria-labelledby="memosim-workflow"><h2 id="memosim-workflow">MemoSim workflow terms</h2>
      <ul class="dictionary-list">${termsHtml}</ul>
    </section>
    <section aria-label="Complete NetLogo language reference">${render(dict)}</section>`);

const articles = new Map(files.map(file => {
  const entry = loaded.get(file);
  const title = entry.primary
    ? entry.names.slice(0, 4).join(' / ') + (entry.names.length > 4 ? ' and related entries' : '') || basename(file, '.html')
    : 'Dictionary reference';
  const mode = variants.get(file) ? 'NetLogo 3D language reference' : 'NetLogo language reference';
  return [file, shell(file, `${title} | MemoSim Dictionary`, `    <p><a href="../dictionary.html#dictionary-search">Back to dictionary search</a> · ${mode} (${engine})</p>
    <h1>${escape(title)}</h1>
    <article aria-label="${escape(mode)}">${render(file)}${entry.primary ? '' : `<p><a href="../${dict}#category-reference">Read the complete dictionary by category</a>.</p>`}</article>`)];
}));
articles.set(notices, shell('copyright.html', 'Upstream Notices | MemoSim Dictionary',
  `    <article aria-label="Upstream copyright and third-party notices">${render('copyright.html')}</article>`));
const guides = guideFiles.map(file => [guideOutputs.get(file), shell(file, `${loaded.get(file).title} | MemoSim Dictionary`,
  `    <p><a href="../../dictionary.html">Back to MemoSim Dictionary</a> · Technical guide for NetLogo ${engine}</p>
    <p class="callout">This is upstream technical guidance for the NetLogo language and engine, used by MemoSim without changes to language semantics. Desktop interface descriptions may differ from MemoSim workflows. Original content is retained and links adapted for offline navigation.</p>
    <article aria-label="${escape(loaded.get(file).title)}">${render(file)}</article>`)]);

await mkdir(join(manual, 'dict'), { recursive: true });
await mkdir(join(manual, 'assets/dict'), { recursive: true });
const sourceRoot = await realpath(root);
for (const [target, src] of media) {
  const source = await realpath(join(root, src));
  if (!source.startsWith(`${sourceRoot}/`)) throw new Error(`Media escapes the pinned source: ${src}`);
  const image = await readFile(source);
  if (image.toString('ascii', 0, 4) !== 'RIFF' || image.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error(`Expected static WEBP data: ${src}`);
  }
  const output = join(manual, target);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, image);
}
await Promise.all([...articles, ...guides, [dict, dictionary], [quickHelp, csv]].map(async ([file, content]) => {
  const output = join(manual, file);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, content);
}));

console.log(JSON.stringify({ engine, revision, commitDate: date, primitivePages: files.length,
  substantiveSplitPages: files.filter(file => loaded.get(file).primary).length,
  languageIndexEntries: rows.length, distinctLanguageNames: new Set(rows.map(row => normalize(row.name))).size,
  groupedReferenceEntries: combined.namedGroups.length, workflowTerms: terms.length, quickHelpMappings: mappings.size,
  threeDimensionalPages: [...variants.values()].filter(Boolean).length,
  repairedSelfLinks: [...loaded.values()].reduce((count, page) => count + page.repaired.length, 0), media: [...media.keys()].sort(),
  codeBlocks: files.reduce((count, file) => count + loaded.get(file).codeBlocks, 0),
  localLinks, repairedTargets: [...fixes].sort(), unresolvedIncomingFragments: [],
  importedTechnicalGuides: guides.map(([file]) => file),
  onlineUpstreamTargets: [...upstream].sort(), additionalExternalTargets: external.size }, null, 2));
