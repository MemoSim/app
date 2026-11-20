(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const storageKey = 'memosim-manual-1.0.4-progress-v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { /* Storage can be disabled for local files. */ }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const toast = message => {
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 2600);
  };
  const progress = $$('input[data-progress]');
  const updateProgress = () => {
    const done = progress.filter(input => input.checked).length;
    $('#progress-count').textContent = `${done} / ${progress.length} complete`;
    $('#reading-progress').max = progress.length || 1;
    $('#reading-progress').value = done;
  };
  progress.forEach(input => {
    input.checked = saved[input.dataset.progress] === true;
    input.addEventListener('change', () => {
      saved[input.dataset.progress] = input.checked;
      try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch { toast('Progress is available for this visit; browser storage is unavailable.'); }
      updateProgress();
    });
  });
  updateProgress();
  $('#reset-progress').addEventListener('click', () => {
    saved = {};
    progress.forEach(input => { input.checked = false; });
    try { localStorage.removeItem(storageKey); } catch { /* Session state still resets. */ }
    updateProgress();
    toast('Lesson progress reset.');
  });
  const copy = async text => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard.');
    } catch {
      const dialog = $('#copy-dialog');
      $('#copy-fallback').value = text;
      if (!dialog.open) dialog.showModal();
      $('#copy-fallback').focus();
      $('#copy-fallback').select();
    }
  };
  $('#copy-close').addEventListener('click', () => $('#copy-dialog').close());
  $$('[data-copy-prompt]').forEach(button => button.addEventListener('click', () => copy(document.getElementById(button.dataset.copyPrompt).textContent)));
  $$('.imported pre.copy-code, .imported pre:has(> code)').forEach(pre => {
    const prior = pre.previousElementSibling;
    if (prior?.matches('button[data-copy-target]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-generated';
    button.textContent = 'Copy code';
    button.addEventListener('click', () => copy((pre.querySelector('code') || pre).textContent));
    pre.before(button);
  });
  $$('button[data-copy-target]').forEach(button => button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.copyTarget.replace(/^#/, ''));
    if (target) copy(target.textContent);
  }));
  const selectTab = (button, buttons, scope, panelSelector) => {
    buttons.forEach(item => {
      const active = item === button;
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    });
    scope.querySelectorAll(panelSelector).forEach(panel => { panel.hidden = panel.id !== button.getAttribute('aria-controls'); });
  };
  const wireTabs = (tablist, scope, panelSelector) => {
    const buttons = [...tablist.querySelectorAll('[role=tab]')];
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => selectTab(button, buttons, scope, panelSelector));
      button.addEventListener('keydown', event => {
        let next;
        if (event.key === 'ArrowRight') next = buttons[(index + 1) % buttons.length];
        if (event.key === 'ArrowLeft') next = buttons[(index - 1 + buttons.length) % buttons.length];
        if (event.key === 'Home') next = buttons[0];
        if (event.key === 'End') next = buttons[buttons.length - 1];
        if (next) { event.preventDefault(); next.click(); next.focus(); }
      });
    });
  };
  $$('.stage-selector').forEach(list => wireTabs(list, list.closest('.scenario'), '.scenario-stage[role=tabpanel]'));
  $$('.evidence-tabs').forEach(list => wireTabs(list, list.closest('.scenario-stage'), '.evidence-panel'));
  const reveal = target => {
    let node = target;
    while (node && node !== document.body) {
      if (node instanceof HTMLDetailsElement) node.open = true;
      if (node.matches?.('[role=tabpanel]')) {
        const tab = document.querySelector(`[role=tab][aria-controls="${CSS.escape(node.id)}"]`);
        if (tab) tab.click();
      }
      node = node.parentElement;
    }
  };
  const revealHash = () => {
    let id;
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (target) { reveal(target); requestAnimationFrame(() => target.scrollIntoView({ block: 'start' })); }
  };
  window.addEventListener('hashchange', revealHash);
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    let id;
    try { id = decodeURIComponent(link.hash.slice(1)); } catch { return; }
    const target = document.getElementById(id);
    if (target) {
      reveal(target);
      if (location.hash === link.hash) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
    }
    $('#sidebar').classList.remove('open');
    $('#menu-toggle').setAttribute('aria-expanded', 'false');
  });
  $('#menu-toggle').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#menu-toggle').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('#sidebar').classList.remove('open'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
  });
  const navLinks = $$('.sidebar nav>a[href]');
  const observer = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!visible) return;
    navLinks.forEach(link => {
      if (link.hash === '#' + visible.target.id) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-85px 0px -65% 0px', threshold: 0 });
  $$('main>.editorial-section, #cover, .scenario').forEach(section => observer.observe(section));
  const searchDialog = $('#search-dialog');
  let searchIndex;
  const buildSearchIndex = () => {
    if (searchIndex) return;
    const nodes = $$('.scenario-stage, .dict_entry, .imported section, .imported article, .imported>p, .imported>h1, .license-text, #chat-first, #evidence-status');
    searchIndex = nodes.filter(node => !node.querySelector('.dict_entry') && !node.querySelector('section') && node.textContent.trim().length > 35).map((node, index) => {
      if (!node.id) node.id = `search-section-${index}`;
      const heading = node.querySelector('h1,h2,h3,h4')?.textContent.trim() || node.closest('section')?.querySelector('h2')?.textContent.trim() || 'Manual passage';
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      return { id: node.id, title: heading, text, lower: text.toLocaleLowerCase() };
    });
  };
  const openSearch = () => {
    buildSearchIndex();
    if (!searchDialog.open) searchDialog.showModal();
    $('#full-search').focus();
  };
  $('#search-open').addEventListener('click', openSearch);
  $('#search-close').addEventListener('click', () => searchDialog.close());
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.matches('input,textarea,[contenteditable=true]') && !document.querySelector('dialog[open]')) {
      event.preventDefault(); openSearch();
    }
  });
  let searchTimer;
  $('#full-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const query = $('#full-search').value.trim().toLocaleLowerCase();
      const results = $('#search-results');
      results.replaceChildren();
      if (query.length < 2) { $('#search-count').textContent = 'Type at least two characters.'; return; }
      const words = query.split(/\s+/);
      const hits = searchIndex.filter(item => words.every(word => item.lower.includes(word))).sort((a, b) => Number(b.title.toLocaleLowerCase().includes(query)) - Number(a.title.toLocaleLowerCase().includes(query)));
      $('#search-count').textContent = `${hits.length} passages found${hits.length > 60 ? '; showing the first 60' : ''}.`;
      hits.slice(0, 60).forEach(item => {
        const li = document.createElement('li');
        const link = document.createElement('a');
        link.href = '#' + item.id;
        link.textContent = item.title;
        link.addEventListener('click', () => { reveal(document.getElementById(item.id)); searchDialog.close(); });
        const excerpt = document.createElement('p');
        const position = Math.max(0, item.lower.indexOf(words[0]) - 60);
        excerpt.textContent = (position ? '…' : '') + item.text.slice(position, position + 210) + '…';
        li.append(link, excerpt); results.append(li);
      });
    }, 110);
  });
  $$('[data-dictionary-search]').forEach(input => input.addEventListener('input', () => {
    const root = input.closest('.imported');
    const words = input.value.trim().toLocaleLowerCase().split(/\s+/);
    let count = 0;
    root.querySelectorAll('[data-search]').forEach(item => {
      const match = words.every(word => item.dataset.search.toLocaleLowerCase().includes(word));
      item.hidden = !match;
      if (match) count++;
    });
    const output = root.querySelector('[data-result-count]');
    if (output) output.textContent = `${count} entries`;
  }));
  $$('form[data-answer]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    let output = form.querySelector('.quiz-feedback');
    if (!output) { output = document.createElement('p'); output.className = 'quiz-feedback'; output.setAttribute('role', 'status'); form.append(output); }
    const answer = new FormData(form).get('answer');
    output.textContent = String(answer || '').trim().toLocaleLowerCase() === form.dataset.answer.toLocaleLowerCase() ? 'Correct. Continue to the next step.' : 'Try again. Review the explanation above.';
  }));
  const printStates = new Map();
  window.addEventListener('beforeprint', () => {
    $$('main details').forEach(detail => { printStates.set(detail, detail.open); detail.open = true; });
  });
  window.addEventListener('afterprint', () => { printStates.forEach((open, detail) => { detail.open = open; }); printStates.clear(); });
  $('#print-manual').addEventListener('click', () => window.print());
  $$('[data-print-link]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); window.print(); }));
  if (location.hash) revealHash();
})();
