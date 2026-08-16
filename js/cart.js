// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — the check-out cart.
//
// State lives in sessionStorage so a half-built cart survives an
// accidental refresh or a tablet locking its screen mid-handoff, but
// does not linger across sessions on a shared device.
// ─────────────────────────────────────────────────────────────
const CART_KEY = 'assets_cart';

const Cart = {
  loanee: null,
  items: [],   // [{ asset_id, asset_tag, title, primary_photo_url, category, blocked_reason }]

  load() {
    try {
      const s = JSON.parse(sessionStorage.getItem(CART_KEY) || 'null');
      if (s) { this.loanee = s.loanee; this.items = s.items || []; }
    } catch { /* a corrupt cart is not worth crashing over */ }
    return this;
  },
  save() {
    try { sessionStorage.setItem(CART_KEY, JSON.stringify({ loanee: this.loanee, items: this.items })); } catch {}
  },
  clear() {
    this.loanee = null; this.items = [];
    try { sessionStorage.removeItem(CART_KEY); } catch {}
  },
  setLoanee(l) { this.loanee = l; this.save(); },
  has(id) { return this.items.some(i => i.asset_id === id); },
  add(a) {
    if (this.has(a.id)) return false;
    this.items.push({
      asset_id: a.id, asset_tag: a.asset_tag, title: a.title,
      primary_photo_url: a.primary_photo_url, category: a.category,
      status: a.status, blocked_reason: null,
    });
    this.save();
    return true;
  },
  remove(id) { this.items = this.items.filter(i => i.asset_id !== id); this.save(); },
  ids() { return this.items.map(i => i.asset_id); },

  // Re-check every item against the server. Called whenever the loanee
  // changes, because eligibility is per-person: a cart that was fine for
  // one volunteer may be half-blocked for the next.
  async revalidate() {
    if (!this.items.length) return;
    const params = new URLSearchParams({ asset_ids: this.ids().join(',') });
    if (this.loanee) params.set('loanee_id', this.loanee.id);
    const { data, error } = await api(`/eligibility?${params}`);
    if (error || !data) return;
    const byId = new Map(data.map(d => [d.asset_id, d]));
    for (const item of this.items) {
      const d = byId.get(item.asset_id);
      item.blocked_reason = d ? d.blocked_reason : 'That asset no longer exists.';
      if (d) item.status = d.status;
    }
    this.save();
  },

  blocked() { return this.items.filter(i => i.blocked_reason); },
};
