/* MemoSim offline documentation interactions, 2026-11-19. No analytics or network requests. */
(() => {
  const announce = (element, message) => {
    let status = element.querySelector('[role="status"]');
    if (!status) { status = document.createElement('span'); status.setAttribute('role', 'status'); element.append(status); }
    status.textContent = ' ' + message;
  };
  document.querySelectorAll('pre.copy-code').forEach(pre => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Copy code';
    button.className = 'copy-code'; button.addEventListener('click', () => copy(pre, button)); pre.before(button);
  });
  async function copy(pre, button) {
    const text = (pre.querySelector('code') || pre).textContent;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea'); area.value = text; document.body.append(area); area.select();
        const ok = document.execCommand('copy'); area.remove(); if (!ok) throw new Error('Copy unavailable');
      }
      button.textContent = 'Copied';
    } catch { button.textContent = 'Select code and copy'; }
  }
  document.querySelectorAll('button.copy-code[data-copy-target]').forEach(button => {
    button.addEventListener('click', () => { const pre = document.querySelector(button.dataset.copyTarget); if (pre) copy(pre, button); });
  });
  document.querySelectorAll('input[data-progress]').forEach(input => {
    const key = 'memosim-docs:' + input.dataset.progress;
    try { input.checked = localStorage.getItem(key) === 'done'; } catch { /* Browser may deny file storage. */ }
    input.addEventListener('change', () => { try { localStorage.setItem(key, input.checked ? 'done' : ''); } catch {} updateProgress(); });
  });
  function updateProgress() {
    const all = [...document.querySelectorAll('input[data-progress]')];
    document.querySelectorAll('.progress-summary').forEach(node => { node.textContent = `${all.filter(i => i.checked).length} of ${all.length} lessons completed on this browser.`; });
  }
  updateProgress();
  document.querySelectorAll('form[data-answer]').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault(); const input = form.querySelector('[name="answer"]');
    const value = input?.value.trim().toLowerCase();
    announce(form, value === form.dataset.answer.toLowerCase() ? 'Correct.' : 'Try again. Review the lesson or open its solution.');
  }));
  document.querySelectorAll('[data-dictionary-search]').forEach(input => {
    const entries = [...document.querySelectorAll('[data-search]')];
    input.addEventListener('input', () => {
      const words = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean); let visible = 0;
      entries.forEach(entry => { const text = entry.dataset.search.toLowerCase(); entry.hidden = !words.every(word => text.includes(word)); if (!entry.hidden) visible++; });
      const result = document.querySelector('[data-result-count]'); if (result) result.textContent = `${visible} matching entries`;
    });
  });
  const headings = [...document.querySelectorAll('main h2[id]')];
  if (headings.length > 3 && !document.querySelector('.toc')) {
    const toc = document.createElement('nav'); toc.className = 'toc'; toc.setAttribute('aria-label', 'On this page');
    headings.forEach(heading => { const link = document.createElement('a'); link.href = '#' + heading.id; link.textContent = heading.textContent; toc.append(link); });
    document.querySelector('main h1')?.after(toc);
  }
  document.querySelectorAll('[data-print]').forEach(button => button.addEventListener('click', () => window.print()));
  if (document.body.dataset.manual) {
    const actions = document.createElement('div'); actions.className = 'page-actions';
    const print = document.createElement('button'); print.textContent = 'Print this page'; print.addEventListener('click', () => window.print()); actions.append(print);
    document.querySelector('main h1')?.after(actions);
  }
})();
