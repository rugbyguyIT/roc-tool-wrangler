// ═════════════════════════════════════════════════════════════════════
// HLSR Asset Tracker — the single mutation path.
//
// Adapted from 8 Second Rides' rides-core.js. EVERY change to an asset's
// status goes through this file, and every one of them does the same
// three things inside ONE Postgres transaction:
//
//   1. a guarded UPDATE:  ... WHERE id = $1 AND status = ANY($from)
//      If it returns zero rows, someone else changed the asset between
//      the read and the write → HTTP 409, not a silent overwrite.
//   2. an append-only asset_events row naming the actor and the reason.
//   3. (rev 2) notification_outbox rows. buildNotifications() returns []
//      in rev 1; the call site exists so turning notifications on is one
//      function body rather than a refactor.
//
// If you find yourself writing `UPDATE public.assets SET status` anywhere
// else in this codebase, stop — it belongs here.
// ═════════════════════════════════════════════════════════════════════
const { withTransaction, query } = require('./db');

// ── The transition table ────────────────────────────────
// `from` is not documentation, it is the guard. There is no separate
// "is it in maintenance?" check anywhere in the app: check_out simply
// cannot start from 'maintenance' or 'retired'.
const TRANSITIONS = {
  // Single-asset lifecycle, driven by POST /api/assets/{id}/action
  maintenance_start: { from: ['available'],               to: 'maintenance', roles: ['staff', 'admin'], reasonRequired: true },
  maintenance_end:   { from: ['maintenance'],             to: 'available',   roles: ['staff', 'admin'] },
  // Retire is deliberately UNREACHABLE from 'checked_out'. You cannot
  // write off something a volunteer is still holding — check it in
  // (in_condition 'missing' if it's gone) and then retire it. That keeps
  // "every retired asset was physically accounted for" a true statement
  // instead of a hope. Resist requests for a force-retire button.
  retire:            { from: ['available', 'maintenance'], to: 'retired',    roles: ['admin'],          reasonRequired: true },
  unretire:          { from: ['retired'],                 to: 'available',   roles: ['admin'] },

  // Custody. Driven by loans.js via performCheckout / performCheckin —
  // not exposed as a raw action, because custody needs a loan row too.
  check_out:         { from: ['available'],               to: 'checked_out', roles: ['staff', 'admin'] },
  check_in:          { from: ['checked_out'],             to: 'available',   roles: ['staff', 'admin'] },
  check_in_service:  { from: ['checked_out'],             to: 'maintenance', roles: ['staff', 'admin'], reasonRequired: true },
};

// Which asset_events.event each action writes.
const ACTION_EVENT = {
  maintenance_start: 'maintenance_start',
  maintenance_end:   'maintenance_end',
  retire:            'retired',
  unretire:          'unretired',
  check_out:         'checked_out',
  check_in:          'checked_in',
  check_in_service:  'checked_in',
};

// Actions a client is allowed to name directly on /assets/{id}/action.
const DIRECT_ACTIONS = ['maintenance_start', 'maintenance_end', 'retire', 'unretire'];

const STATUS_LABEL = {
  available: 'available', checked_out: 'checked out',
  maintenance: 'in maintenance', retired: 'retired',
};

// ── Small helpers ─────────────────────────────────
function assetLabel(a) {
  return a ? `${a.asset_tag} — ${a.title}` : 'That asset';
}

async function writeEvent(client, {
  asset_id, loan_id = null, loan_item_id = null, loanee_id = null,
  event, actor, reason = null, payload = null,
}) {
  const r = await client.query(
    `INSERT INTO public.asset_events
       (asset_id, loan_id, loan_item_id, loanee_id, event, actor_id, actor_role, reason, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [asset_id, loan_id, loan_item_id, loanee_id, event,
     actor.sub, actor.role, reason, payload ? JSON.stringify(payload) : null]
  );
  return r.rows[0].id;
}

// Rev 1 ships no sender. Kept as a real call site so adding email/push
// later means filling this in, not restructuring performCheckout.
async function buildNotifications(/* client, event, ctx */) {
  return [];
}

async function enqueue(client, eventId, notifs) {
  for (const n of notifs) {
    await client.query(
      `INSERT INTO public.notification_outbox
         (asset_event_id, recipient_kind, recipient_id, channel, title, body)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (asset_event_id, recipient_kind, recipient_id, channel) DO NOTHING`,
      [eventId, n.recipientKind, n.recipientId, n.channel, n.title, n.body]
    );
  }
  return notifs.length;
}

// The guarded status write. Returns the row, or throws a 409 naming the
// state it was actually in — which is the error message staff will read
// at the counter, so it says "is checked out", not "invalid transition".
async function guardedStatusUpdate(client, assetId, t, action, asset) {
  const upd = await client.query(
    `UPDATE public.assets SET status = $1, updated_at = now()
     WHERE id = $2 AND status = ANY($3) RETURNING id, status`,
    [t.to, assetId, t.from]
  );
  if (!upd.rows.length) {
    throw {
      status: 409,
      message: `${assetLabel(asset)} is ${STATUS_LABEL[asset.status] || asset.status} — you can't ${action.replace(/_/g, ' ')} it from there.`,
    };
  }
  return upd.rows[0];
}

// ═══ 1. Single-asset lifecycle ══════════════════════════
async function performAction(assetId, action, actor, opts = {}) {
  const t = TRANSITIONS[action];
  if (!t || !DIRECT_ACTIONS.includes(action)) throw { status: 400, message: `Unknown action '${action}'` };
  if (!t.roles.includes(actor.role)) throw { status: 403, message: 'Forbidden' };
  if (t.reasonRequired && !opts.reason) throw { status: 400, message: 'A reason is required for that.' };

  return withTransaction(async (client) => {
    const r = await client.query(
      `SELECT id, asset_tag, title, status, location_id FROM public.assets WHERE id = $1 FOR UPDATE`,
      [assetId]
    );
    const asset = r.rows[0];
    if (!asset) throw { status: 404, message: 'Asset not found' };

    const from = asset.status;
    await guardedStatusUpdate(client, assetId, t, action, asset);

    const eventId = await writeEvent(client, {
      asset_id: assetId, event: ACTION_EVENT[action], actor,
      reason: opts.reason || null,
      payload: { from_status: from, to_status: t.to, note: opts.note || null },
    });
    const enqueued = await enqueue(client, eventId, await buildNotifications());

    return { asset_id: assetId, from_status: from, status: t.to, event_id: eventId, enqueued };
  });
}

// ═══ 2. Eligibility (read-only) ═════════════════════════
// Powers GET /api/eligibility and the asset picker, so staff see an item
// greyed out with a reason BEFORE they try to hand it over. The
// eligibility rule itself lives in SQL (public.asset_eligible) so the
// picker, the checkout guard and the reports can never drift apart.
async function checkEligibility(loaneeId, assetIds) {
  if (!assetIds || !assetIds.length) return [];
  const r = await query(
    `SELECT a.id AS asset_id, a.asset_tag, a.title, a.status,
            CASE WHEN $2::uuid IS NULL THEN TRUE
                 ELSE public.asset_eligible(a.id, $2) END AS eligible,
            EXISTS (SELECT 1 FROM public.loan_items li
                    WHERE li.asset_id = a.id AND li.checked_in_at IS NULL) AS currently_out
     FROM public.assets a WHERE a.id = ANY($1::uuid[])`,
    [assetIds, loaneeId || null]
  );
  // One flat shape the cart can render directly: can it go out, and if
  // not, the exact sentence to show next to that row.
  return r.rows.map(a => {
    let blocked_reason = null;
    if (a.status !== 'available') blocked_reason = `${a.asset_tag} — ${a.title} is ${STATUS_LABEL[a.status] || a.status}.`;
    else if (!a.eligible) blocked_reason = `This person isn't in a group allowed to receive ${a.asset_tag} — ${a.title}.`;
    return { ...a, ok: !blocked_reason, blocked_reason };
  });
}

// ═══ How much one ordinary member may hold ═══════════════════
// Ordinary members hold a limited number of items at a time; anyone whose
// roster title says otherwise — Chairman, Division Chairman, Captain —
// is unlimited, because the people running a division genuinely do need
// six radios and a loader at once.
//
// Who counts as ordinary, how many, and whether the count is per category
// or across everything are all settings (migration 009), because that is
// an operational judgement that will differ between a build week and show
// week and must not need a deploy to change.
//
// The count of what someone already holds is read inside the check-out
// transaction, against rows locked there. A limit the browser owns is a
// suggestion: two tablets at the same counter would each see "nothing out"
// and both hand something over.
//
// The RULE, though — the settings row — is read on the pool, deliberately,
// and everything below is arranged so that no statement naming a 009
// column ever enters the transaction. Postgres aborts an entire
// transaction on any error, including a missing column, so the first
// version of this — `try { SELECT member_title } catch {}` inside
// performCheckout — looked handled and actually poisoned the transaction:
// every query after it failed with "current transaction is aborted" and
// the whole checkout died, which is far worse than the missing column it
// was guarding against. api/test/limits.js holds that case permanently.
//
// So: does the database have migration 009's columns yet? A true answer is
// cached for good; a false one is re-checked at most twice a minute, so
// running the migration on a live app takes effect within a minute instead
// of waiting for a cold start.
const MEMBER_COLS = ['member_limit_enabled', 'member_title', 'member_item_limit', 'member_limit_per_category'];
let _hasMemberCols = false;
let _memberColsCheckedAt = 0;
async function hasMemberColumns() {
  if (_hasMemberCols) return true;
  if (Date.now() - _memberColsCheckedAt < 30000) return false;
  _memberColsCheckedAt = Date.now();
  const r = await query(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'app_settings'
       AND column_name = ANY($1::text[])`, [MEMBER_COLS]);
  _hasMemberCols = r.rows[0].n === MEMBER_COLS.length;
  return _hasMemberCols;
}

// Read the rule. Deliberately NOT given the caller's transaction client:
// this is a singleton config row, so reading it on the pool costs nothing
// in correctness and buys the one thing that matters — no statement that
// names a 009 column ever enters the check-out transaction. The probe
// above can still be wrong (it caches a true answer for the life of the
// process, and a column could go away under it), and if it is, the error
// lands here, on a connection nothing else depends on, instead of
// poisoning a transaction that was halfway through handing over a
// forklift. That is why the catch below is safe and the earlier one was
// not: same try/catch, different connection.
async function memberLimitSettings() {
  // On a database where 009 has not been run, the rule simply stays off
  // and checkout keeps working.
  if (!(await hasMemberColumns())) return null;
  try {
    const r = await query(
      `SELECT ${MEMBER_COLS.join(', ')} FROM public.app_settings WHERE id = 1`);
    return r.rows[0] || null;
  } catch (e) {
    // 42703 = undefined_column. The cached answer was stale; drop it so
    // the next call re-probes, and treat the rule as off for this one.
    if (e && e.code === '42703') {
      _hasMemberCols = false; _memberColsCheckedAt = Date.now();
      return null;
    }
    throw e;
  }
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

async function enforceMemberLimit(client, loanee, assetIds) {
  const s = await memberLimitSettings();
  if (!s || !s.member_limit_enabled) return;

  // Title match is case- and space-insensitive. Rosters are typed by hand,
  // and "committee member " with a trailing space must not silently exempt
  // someone from a rule everyone else is held to.
  const norm = v => String(v || '').trim().toLowerCase();
  if (norm(loanee.title) !== norm(s.member_title)) return;   // not an ordinary member

  const limit = Math.max(1, Number(s.member_item_limit) || 1);

  const held = await client.query(
    `SELECT a.asset_tag, a.title AS asset_title,
            COALESCE(c.name, '(uncategorized)') AS category,
            li.checked_out_at, li.due_at
     FROM public.loan_items li
     JOIN public.loans  l ON l.id = li.loan_id
     JOIN public.assets a ON a.id = li.asset_id
     LEFT JOIN public.asset_categories c ON c.id = a.category_id
     WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL
     ORDER BY li.checked_out_at`, [loanee.id]);

  const wanted = await client.query(
    `SELECT a.id, a.asset_tag, a.title AS asset_title,
            COALESCE(c.name, '(uncategorized)') AS category
     FROM public.assets a
     LEFT JOIN public.asset_categories c ON c.id = a.category_id
     WHERE a.id = ANY($1::uuid[])`, [assetIds]);

  // The list is the same either way — whoever is at the counter needs to
  // see everything the person is holding, not just the row that tripped it.
  const holding = held.rows.map(h => ({
    asset_tag: h.asset_tag, asset_title: h.asset_title, category: h.category,
    checked_out_at: h.checked_out_at, due_at: h.due_at,
  }));
  const refuse = (message) => {
    throw { status: 409, message,
      member_limit: { limit, per_category: !!s.member_limit_per_category,
                      title: s.member_title, holding } };
  };

  if (s.member_limit_per_category) {
    // One of each kind: count within a category, existing plus incoming.
    const counts = new Map();
    for (const h of held.rows) counts.set(h.category, (counts.get(h.category) || 0) + 1);
    for (const w of wanted.rows) {
      const n = (counts.get(w.category) || 0) + 1;
      counts.set(w.category, n);
      if (n > limit) {
        refuse(`${loanee.full_name} already has ${plural(n - 1, w.category.toLowerCase())} out `
          + `and may hold ${plural(limit, w.category.toLowerCase())} at a time. `
          + `Check something in first.`);
      }
    }
    return;
  }

  // The stricter reading: a total across everything they hold.
  const total = held.rows.length + assetIds.length;
  if (total > limit) {
    refuse(`${loanee.full_name} already has ${plural(held.rows.length, 'item')} out and may hold `
      + `${plural(limit, 'item')} at a time. Check something in first, or ask an admin whether `
      + `they should be on a different title.`);
  }
}

// Read-only version for the counter, so the rule is visible on screen
// before anyone clicks rather than only as a refusal afterwards.
async function memberLimitStatus(loaneeId) {
  const lr = await query(`SELECT id, full_name, title FROM public.loanees WHERE id = $1`, [loaneeId]);
  const loanee = lr.rows[0];
  if (!loanee) return null;

  const s = await memberLimitSettings();
  if (!s || !s.member_limit_enabled) return null;

  const norm = v => String(v || '').trim().toLowerCase();
  if (norm(loanee.title) !== norm(s.member_title)) return null;

  const held = await query(
    `SELECT a.asset_tag, a.title AS asset_title,
            COALESCE(c.name, '(uncategorized)') AS category,
            li.checked_out_at, li.due_at
     FROM public.loan_items li
     JOIN public.loans  l ON l.id = li.loan_id
     JOIN public.assets a ON a.id = li.asset_id
     LEFT JOIN public.asset_categories c ON c.id = a.category_id
     WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL
     ORDER BY li.checked_out_at`, [loaneeId]);

  const limit = Math.max(1, Number(s.member_item_limit) || 1);
  const perCategory = !!s.member_limit_per_category;
  const byCategory = {};
  for (const h of held.rows) byCategory[h.category] = (byCategory[h.category] || 0) + 1;

  return {
    applies: true,
    title: s.member_title,
    limit,
    per_category: perCategory,
    holding: held.rows,
    // Per-category has no single "how many more" number, so the client
    // reads by_category rather than being handed a misleading one.
    remaining: perCategory ? null : Math.max(0, limit - held.rows.length),
    by_category: byCategory,
    at_limit: perCategory
      ? Object.values(byCategory).some(n => n >= limit)
      : held.rows.length >= limit,
  };
}

// ═══ 3. Check-out — cart-style, ALL-OR-NOTHING ══════════════════
// One loanee, N assets, one transaction. If ANY item fails, nothing goes
// out and the caller gets back exactly which rows blocked it.
//
// Why all-or-nothing rather than partial success: at a busy check-out
// window, "4 of your 6 went out, scroll up to see which 2 didn't" is how
// a forklift ends up unaccounted for. A hard stop with a named reason is
// slower to clear and much harder to miss. (Worth re-testing with real
// counter staff — if they hate it, the change is confined to this
// function.)
async function performCheckout(loaneeId, items, actor, opts = {}) {
  if (!TRANSITIONS.check_out.roles.includes(actor.role)) throw { status: 403, message: 'Forbidden' };
  if (!items || !items.length) throw { status: 400, message: 'Add at least one asset to the cart.' };

  const assetIds = items.map(i => i.asset_id);
  if (new Set(assetIds).size !== assetIds.length) {
    throw { status: 400, message: 'The same asset appears twice in this cart.' };
  }

  return withTransaction(async (client) => {
    // ── The loanee ──
    const lr = await client.query(
      `SELECT id, full_name, status, title FROM public.loanees WHERE id = $1`, [loaneeId]
    );
    const loanee = lr.rows[0];
    if (!loanee) throw { status: 404, message: 'Committee member not found' };
    if (loanee.status !== 'active') {
      throw { status: 400, message: `${loanee.full_name} is marked inactive and can't be issued equipment.` };
    }

    // ── How much one ordinary member may hold ──
    // Enforced HERE, inside the same transaction that locks the assets,
    // rather than in the browser. A limit the front end owns is a
    // suggestion: two tablets at the same counter would each see "nothing
    // out" and both hand something over. Checked against rows read under
    // the transaction, so the second one loses.
    await enforceMemberLimit(client, loanee, assetIds);

    // ── Every asset, locked, checked for status AND group eligibility ──
    // FOR UPDATE serializes two simultaneous carts containing the same
    // asset; the partial unique index below is the backstop if they
    // somehow slip past.
    const ar = await client.query(
      `SELECT a.id, a.asset_tag, a.title, a.status,
              public.asset_eligible(a.id, $2) AS eligible
       FROM public.assets a
       WHERE a.id = ANY($1::uuid[])
       FOR UPDATE OF a`,
      [assetIds, loaneeId]
    );
    const byId = new Map(ar.rows.map(a => [a.id, a]));

    const blocked = [];
    for (const id of assetIds) {
      const a = byId.get(id);
      if (!a) { blocked.push({ asset_id: id, reason: 'That asset no longer exists.' }); continue; }
      if (a.status !== 'available') {
        blocked.push({
          asset_id: id, asset_tag: a.asset_tag, title: a.title,
          reason: `${assetLabel(a)} is ${STATUS_LABEL[a.status] || a.status}.`,
        });
        continue;
      }
      if (!a.eligible) {
        blocked.push({
          asset_id: id, asset_tag: a.asset_tag, title: a.title,
          reason: `${loanee.full_name} isn't in a group allowed to receive ${assetLabel(a)}.`,
        });
      }
    }
    if (blocked.length) {
      throw {
        status: 409,
        message: blocked.length === 1
          ? blocked[0].reason
          : `${blocked.length} items can't go out — nothing was checked out.`,
        blocked,
      };
    }

    // ── The loan header ──
    const loanRes = await client.query(
      `INSERT INTO public.loans (loanee_id, checked_out_by, due_at, notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [loaneeId, actor.sub, opts.due_at || null, opts.notes || null]
    );
    const loan = loanRes.rows[0];

    // ── One line + one guarded status flip + one event per asset ──
    const created = [];
    for (const item of items) {
      const a = byId.get(item.asset_id);
      let line;
      try {
        const li = await client.query(
          `INSERT INTO public.loan_items
             (loan_id, asset_id, due_at, out_condition, out_notes)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [loan.id, item.asset_id,
           item.due_at !== undefined ? item.due_at : (opts.due_at || null),
           item.out_condition || null, item.out_notes || null]
        );
        line = li.rows[0];
      } catch (e) {
        // 23505 on loan_items_one_open_per_asset: another transaction
        // checked this exact asset out between our lock and our insert.
        // This is the database enforcing the invariant, so the message
        // can be blunt.
        if (e.code === '23505') {
          throw { status: 409, message: `${assetLabel(a)} was just checked out by someone else.`,
                  blocked: [{ asset_id: item.asset_id, asset_tag: a.asset_tag, reason: 'Just checked out by someone else.' }] };
        }
        throw e;
      }

      await guardedStatusUpdate(client, item.asset_id, TRANSITIONS.check_out, 'check_out', a);

      const eventId = await writeEvent(client, {
        asset_id: item.asset_id, loan_id: loan.id, loan_item_id: line.id, loanee_id: loaneeId,
        event: 'checked_out', actor, reason: opts.notes || null,
        payload: {
          from_status: 'available', to_status: 'checked_out',
          due_at: line.due_at, condition: line.out_condition,
          loanee_name: loanee.full_name,
        },
      });
      await enqueue(client, eventId, await buildNotifications());
      created.push({ ...line, asset_tag: a.asset_tag, asset_title: a.title });
    }

    return { loan, items: created, loanee: { id: loanee.id, full_name: loanee.full_name } };
  });
}

// ═══ 4. Check-in — all at once or item by item ══════════════════
// `perItem` lets one call mix outcomes: three radios back on the shelf
// and one routed straight to maintenance, in a single transaction.
async function performCheckin(loanItemIds, actor, opts = {}) {
  if (!TRANSITIONS.check_in.roles.includes(actor.role)) throw { status: 403, message: 'Forbidden' };
  if (!loanItemIds || !loanItemIds.length) throw { status: 400, message: 'Nothing selected to check in.' };

  const perItem = new Map((opts.per_item || []).map(p => [p.loan_item_id, p]));

  return withTransaction(async (client) => {
    const lr = await client.query(
      `SELECT li.*, a.asset_tag, a.title, a.status AS asset_status, l.loanee_id, ln.full_name AS loanee_name
       FROM public.loan_items li
       JOIN public.assets  a  ON a.id  = li.asset_id
       JOIN public.loans   l  ON l.id  = li.loan_id
       JOIN public.loanees ln ON ln.id = l.loanee_id
       WHERE li.id = ANY($1::uuid[])
       FOR UPDATE OF li`,
      [loanItemIds]
    );
    if (!lr.rows.length) throw { status: 404, message: 'Those items were not found.' };

    const already = lr.rows.filter(r => r.checked_in_at);
    if (already.length === lr.rows.length) {
      throw { status: 409, message: `${assetLabel(already[0])} was already checked in.` };
    }

    const done = [];
    const loanIds = new Set();
    for (const row of lr.rows) {
      if (row.checked_in_at) continue; // silently skip ones a colleague just did
      const p = perItem.get(row.id) || {};
      const condition = p.in_condition || opts.in_condition || null;
      const notes = p.in_notes || opts.in_notes || null;
      // Anything coming back damaged, needing service, or missing must
      // not land back on the shelf as available.
      const needsService = ['damaged', 'needs_service', 'missing'].includes(condition);
      const toStatus = (p.to_status || opts.to_status || (needsService ? 'maintenance' : 'available'));
      const action = toStatus === 'maintenance' ? 'check_in_service' : 'check_in';
      const t = TRANSITIONS[action];

      if (t.reasonRequired && !condition && !notes) {
        throw { status: 400, message: `Say what's wrong with ${assetLabel(row)} before sending it to maintenance.` };
      }

      const upd = await client.query(
        `UPDATE public.loan_items
         SET checked_in_at = now(), checked_in_by = $2, in_condition = $3,
             in_notes = $4, returned_status = $5
         WHERE id = $1 AND checked_in_at IS NULL
         RETURNING *`,
        [row.id, actor.sub, condition, notes, toStatus]
      );
      if (!upd.rows.length) continue; // lost a race; the other side won

      await guardedStatusUpdate(client, row.asset_id, t, action, row);

      const eventId = await writeEvent(client, {
        asset_id: row.asset_id, loan_id: row.loan_id, loan_item_id: row.id, loanee_id: row.loanee_id,
        event: 'checked_in', actor, reason: notes,
        payload: {
          from_status: 'checked_out', to_status: toStatus,
          condition, due_at: row.due_at,
          late: !!(row.due_at && new Date(row.due_at) < new Date()),
          loanee_name: row.loanee_name,
        },
      });
      await enqueue(client, eventId, await buildNotifications());

      loanIds.add(row.loan_id);
      done.push({ ...upd.rows[0], asset_tag: row.asset_tag, asset_title: row.title, to_status: toStatus });
    }

    // Close any loan header whose last open line just went in. Item-by-item
    // check-in therefore needs no separate "is this loan finished?" call.
    const closed = await client.query(
      `UPDATE public.loans SET closed_at = now()
       WHERE id = ANY($1::uuid[]) AND closed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.loan_items li
                         WHERE li.loan_id = loans.id AND li.checked_in_at IS NULL)
       RETURNING id`,
      [[...loanIds]]
    );

    return { checked_in: done, loans_closed: closed.rows.map(r => r.id) };
  });
}

// ═══ 5. Extend a due date ══════════════════════════════════
async function performExtend(loanId, dueAt, actor, opts = {}) {
  if (!['staff', 'admin'].includes(actor.role)) throw { status: 403, message: 'Forbidden' };

  return withTransaction(async (client) => {
    const ids = opts.loan_item_ids && opts.loan_item_ids.length ? opts.loan_item_ids : null;
    const upd = await client.query(
      `UPDATE public.loan_items li
       SET due_at = $2
       WHERE li.loan_id = $1 AND li.checked_in_at IS NULL
         AND ($3::uuid[] IS NULL OR li.id = ANY($3::uuid[]))
       RETURNING li.id, li.asset_id, li.due_at`,
      [loanId, dueAt || null, ids]
    );
    if (!upd.rows.length) throw { status: 404, message: 'Nothing open on that loan to extend.' };

    // Only move the header's due date when the whole loan moved, so a
    // single-item extension doesn't quietly relax the rest.
    if (!ids) await client.query(`UPDATE public.loans SET due_at = $2 WHERE id = $1`, [loanId, dueAt || null]);

    const lr = await client.query(`SELECT loanee_id FROM public.loans WHERE id = $1`, [loanId]);
    for (const row of upd.rows) {
      await writeEvent(client, {
        asset_id: row.asset_id, loan_id: loanId, loan_item_id: row.id,
        loanee_id: lr.rows[0]?.loanee_id || null,
        event: 'due_extended', actor, reason: opts.reason || null,
        payload: { due_at: row.due_at },
      });
    }
    return { updated: upd.rows };
  });
}

module.exports = {
  TRANSITIONS, DIRECT_ACTIONS, STATUS_LABEL,
  performAction, performCheckout, performCheckin, performExtend, checkEligibility,
  memberLimitStatus,
  writeEvent,
};
