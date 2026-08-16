// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — search-and-select combobox
//
// Rev 1 has no camera scanning: assets and people are found by typing.
// But the picker is built so that scanning is free rather than a rewrite:
//
//   · The server returns `exact` separately from `matches` — an exact hit
//     on an asset tag, a serial, or an email address.
//   · If the user presses Enter and there is an exact hit, the picker
//     selects it immediately and clears the field, ready for the next one.
//
// A USB or Bluetooth barcode scanner IS a keyboard: it types the tag and
// sends Enter. So handheld scanners work on day one, with no scanner
// code anywhere in the app. Adding camera QR later means one new module
// that calls onPick(id) — the exact callback the keyboard path already
// uses. No redesign, no second code path.
// ─────────────────────────────────────────────────────────────

function attachPicker(input, opts) {
  const o = Object.assign({ kind: 'asset', minChars: 2, debounce: 180 }, opts || {});
  let timer = null;
  let items = [];
  let active = -1;
  let lastExact = null;

  // The dropdown is positioned relative to a wrapper we insert around the
  // input, so it works inside modals and scrolling panels without any
  // absolute-position maths against the page.
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const menu = document.createElement('div');
  menu.className = 'card';
  menu.style.cssText = 'position:absolute;z-index:60;left:0;right:0;top:calc(100% + 6px);padding:6px;'
    + 'max-height:320px;overflow-y:auto;display:none;box-shadow:var(--card-shadow)';
  wrap.appendChild(menu);
  input.setAttribute('autocomplete', 'off');

  function close() { menu.style.display = 'none'; active = -1; }

  function render() {
    if (!items.length) {
      menu.innerHTML = `<div class="small muted" style="padding:12px 10px">No matches.</div>`;
      menu.style.display = 'block';
      return;
    }
    menu.innerHTML = items.map((it, i) => rowHtml(it, i)).join('');
    [...menu.querySelectorAll('[data-i]')].forEach(el => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(parseInt(el.dataset.i, 10)); });
    });
    menu.style.display = 'block';
  }

  function rowHtml(it, i) {
    const on = i === active ? 'background:var(--orangeglow);' : '';
    const disabled = o.kind === 'asset' && it.ok === false;
    const dim = disabled ? 'opacity:.55;' : '';
    if (o.kind === 'asset') {
      return `<div data-i="${i}" style="${on}${dim}display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer">
        ${assetThumb(it.primary_photo_url, 34)}
        <div style="min-width:0;flex:1">
          <div style="font-weight:600;font-size:14px">${esc(it.title)}</div>
          <div class="small muted mono">${esc(it.asset_tag)}${it.serial ? ' · ' + esc(it.serial) : ''}</div>
          ${disabled ? `<div class="small" style="color:var(--red)">${esc(it.blocked_reason)}</div>` : ''}
        </div>
        ${statusBadge(it.status)}
      </div>`;
    }
    return `<div data-i="${i}" style="${on}display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;cursor:pointer">
      <div style="min-width:0;flex:1">
        <div style="font-weight:600;font-size:14px">${esc(it.full_name)}</div>
        <div class="small muted">${[it.sub_committee, it.position, it.email && it.email, it.phone_mobile && fmtPhone(it.phone_mobile)].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
      ${it.items_out ? `<span class="badge badge-active">${it.items_out} out</span>` : ''}
    </div>`;
  }

  function choose(i) {
    const it = items[i];
    if (!it) return;
    // Ineligible/unavailable assets stay visible with their reason rather
    // than being hidden — "why isn't it in the list?" is a worse question
    // than "why can't I add this?".
    if (o.kind === 'asset' && it.ok === false) {
      toastMsg('Can\'t add that one', it.blocked_reason, 'error');
      return;
    }
    close();
    input.value = '';
    items = [];
    o.onPick(it);
  }

  async function search(q, viaEnter) {
    const base = o.kind === 'asset' ? '/assets/lookup' : '/loanees/lookup';
    const params = new URLSearchParams({ q });
    if (o.kind === 'asset' && o.forLoanee && o.forLoanee()) params.set('for_loanee', o.forLoanee());
    const { data, error } = await api(`${base}?${params}`);
    if (error) { toastMsg('Search failed', error, 'error'); return; }
    items = data.matches || [];
    lastExact = data.exact || null;

    // The scanner path: an exact tag/serial/email hit plus Enter means
    // "this one", with no confirmation step.
    if (viaEnter && lastExact) {
      const idx = items.findIndex(x => x.id === lastExact.id);
      choose(idx >= 0 ? idx : 0);
      return;
    }
    active = items.length ? 0 : -1;
    render();
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < o.minChars) { close(); return; }
    timer = setTimeout(() => search(q, false), o.debounce);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) return;
      // If the dropdown is already open on a highlighted row, Enter takes
      // it. Otherwise re-query and let the exact-match path decide —
      // which is what happens when a scanner fires text + Enter faster
      // than the debounce.
      if (menu.style.display === 'block' && active >= 0) choose(active);
      else search(q, true);
      return;
    }
    if (menu.style.display !== 'block') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Escape') { close(); }
  });

  input.addEventListener('blur', () => setTimeout(close, 120));

  return {
    clear() { input.value = ''; items = []; close(); },
    focus() { input.focus(); },
  };
}
