// ══════════════════════════════════════════════════════════════════════
// HLSR Asset Tracker — CSV / XLSX import
//   POST /api/imports/{kind}/preview   admin   dry run, writes nothing real
//   POST /api/imports/{kind}/commit    admin   applies a previewed batch
//   GET  /api/imports                  admin   batch history
//   GET  /api/imports/{id}/rows        admin   per-row detail (error CSV)
//
// kind ∈ loanees | assets | group-members
//
// SPLIT OF RESPONSIBILITIES: the browser parses the spreadsheet (SheetJS,
// vendored at js/vendor/xlsx.full.min.js) and sends compact JSON. The
// SERVER owns every rule — required fields, formats, FK resolution,
// duplicate detection. Client-side validation would be trivially
// bypassable, so nothing the client claims about a row is trusted; the
// verdict is always re-derived here from the raw cells.
//
// Preview writes to import_rows only. Commit re-reads those rows from the
// database rather than accepting a re-sent client payload, which is what
// makes "what you approved is what gets written" actually true.
// ══════════════════════════════════════════════════════════════════════
const { app } = require('@azure/functions');
const { query, withTransaction } = require('../db');
const {
  json, err, requireRole, logAudit, readJson, qs, uuidOrNull,
} = require('../middleware');
const core = require('../assets-core');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_CHUNK = 500;   // rows per preview request — keeps each call well
                         // inside Static Web Apps' body-size and duration caps
const KINDS = { loanees: 'loanees', assets: 'assets', 'group-members': 'group_members' };

// ── Header aliases ──────────────────────────────────────────
// Headers are normalized (trim → lowercase → collapse separators to one
// space) and matched here. Anything unrecognized is ignored and reported.
const ALIASES = {
  loanees: {
    first_name:    ['first name', 'first', 'fname', 'given name'],
    last_name:     ['last name', 'last', 'lname', 'surname', 'family name'],
    email:         ['email', 'email address', 'e mail'],
    phone_mobile:  ['cell', 'cell phone', 'mobile', 'mobile phone', 'phone', 'phone number', 'cell number'],
    position:      ['position', 'title', 'job title', 'role'],
    sub_committee: ['sub committee', 'subcommittee', 'committee', 'sub comm'],
    groups:        ['groups', 'group', 'group names'],
    notes:         ['notes', 'comments', 'note'],
  },
  assets: {
    asset_tag:   ['asset tag', 'tag', 'asset id', 'asset no', 'asset number', 'barcode'],
    title:       ['title', 'name', 'asset name', 'item', 'asset title'],
    category:    ['category', 'type', 'asset category'],
    location:    ['location', 'home location', 'site'],
    serial:      ['serial', 'serial number', 's n', 'sn'],
    description: ['description', 'desc'],
    notes:       ['notes', 'comments', 'note'],
    status:      ['status', 'state', 'status label'],
    groups:      ['groups', 'restricted to', 'restriction', 'group'],
    value:       ['value', 'valuation', 'cost', 'purchase price'],
    color:       ['color', 'colour', 'paint'],
    // 'make' and 'brand' are what a spreadsheet of golf carts actually
    // calls this column; 'mfg' is what the person typing it says.
    manufacturer: ['manufacturer', 'mfg', 'mfr', 'make', 'brand', 'vendor'],
  },
};
ALIASES.group_members = ALIASES.loanees;

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[_\-\s]+/g, ' ').replace(/[.#]/g, '').trim();
}
function buildMap(kind, headers) {
  const table = ALIASES[kind];
  const map = {}; const unknown = [];
  for (const h of headers) {
    const n = normHeader(h);
    const field = Object.keys(table).find(f => table[f].includes(n) || normHeader(f) === n);
    if (field) map[h] = field; else unknown.push(h);
  }
  return { map, unknown };
}
function normPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d.length === 10 ? d : d; // keep non-standard lengths; validation flags them
}
function phoneValid(d) { return !d || d.length === 10; }
function last4(d) { return (d || '').slice(-4); }
function splitList(v) {
  return String(v || '').split(/[;,|]/).map(s => s.trim()).filter(Boolean);
}
function cell(row, map, field) {
  for (const [header, f] of Object.entries(map)) {
    if (f === field) {
      const v = row[header];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return '';
}

// ═══ PREVIEW ════════════════════════════════════════════════════════
app.http('importPreview', {
  methods: ['POST'], authLevel: 'anonymous', route: 'imports/{kind}/preview',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const kind = KINDS[request.params.kind];
    if (!kind) return err('Unknown import type');
    const { body, bad } = await readJson(request); if (bad) return bad;

    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return err('No rows to import');
    if (rows.length > MAX_CHUNK) return err(`Send at most ${MAX_CHUNK} rows per request`);

    // First chunk creates the batch; later chunks pass batch_id back.
    let batchId = uuidOrNull(body.batch_id);
    if (!batchId) {
      const b = await query(
        `INSERT INTO public.import_batches (kind, filename, target_group_id, options, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [kind, body.filename || null, uuidOrNull(body.target_group_id),
         JSON.stringify(body.options || {}), user.sub]);
      batchId = b.rows[0].id;
    } else {
      const b = await query(`SELECT status FROM public.import_batches WHERE id = $1`, [batchId]);
      if (!b.rows.length) return err('Import batch not found', 404);
      if (b.rows[0].status !== 'preview') return err('That import has already been committed', 409);
    }

    const headers = body.headers || Object.keys(rows[0]).filter(k => k !== 'row_number');
    const { map, unknown } = body.mapping
      ? { map: body.mapping, unknown: [] }
      : buildMap(kind, headers);

    // Reference data resolved once for the whole chunk.
    const groups = await query(`SELECT id, lower(name) AS lname, name FROM public.groups`);
    const groupByName = new Map(groups.rows.map(g => [g.lname, g]));
    const cats = await query(`SELECT id, lower(name) AS lname FROM public.asset_categories`);
    const catByName = new Map(cats.rows.map(c => [c.lname, c.id]));
    const locs = await query(`SELECT id, lower(name) AS lname FROM public.asset_locations`);
    const locByName = new Map(locs.rows.map(l => [l.lname, l.id]));

    // In-file duplicates are caught BEFORE the database check, so a sheet
    // listing the same person twice produces one record, not two.
    const seen = new Set();
    const results = [];
    const newCategories = new Set();
    const newLocations = new Set();

    for (const raw of rows) {
      const rowNumber = raw.row_number || results.length + 1;
      const out = { row_number: rowNumber, raw, verdict: 'create', message: null, normalized: {} };

      if (kind === 'assets') {
        const tag = cell(raw, map, 'asset_tag');
        const title = cell(raw, map, 'title');
        if (!tag) { out.verdict = 'error'; out.message = 'Asset tag is required'; results.push(out); continue; }
        if (tag.length > 64) { out.verdict = 'error'; out.message = 'Asset tag is longer than 64 characters'; results.push(out); continue; }
        if (!title) { out.verdict = 'error'; out.message = 'Title is required'; results.push(out); continue; }

        const st = cell(raw, map, 'status').toLowerCase().replace(/[\s-]/g, '_');
        if (st && !['available', 'checked_out', 'maintenance', 'retired'].includes(st)) {
          out.verdict = 'error'; out.message = `Unknown status "${st}"`; results.push(out); continue;
        }
        // Never import an asset straight into 'checked_out' — there'd be
        // no loan behind it, so the board would show a phantom item with
        // nobody holding it. Bring it in available and check it out for real.
        const importStatus = st === 'checked_out' ? 'available' : (st || 'available');

        const catName = cell(raw, map, 'category');
        const locName = cell(raw, map, 'location');
        if (catName && !catByName.has(catName.toLowerCase())) newCategories.add(catName);
        if (locName && !locByName.has(locName.toLowerCase())) newLocations.add(locName);

        // Unknown GROUP names are always an error. Auto-creating a
        // restriction group from a typo would silently lock an asset to a
        // group with no members — i.e. to nobody.
        const groupNames = splitList(cell(raw, map, 'groups'));
        const missingGroups = groupNames.filter(g => !groupByName.has(g.toLowerCase()));
        if (missingGroups.length) {
          out.verdict = 'error';
          out.message = `No such group: ${missingGroups.join(', ')} — create it under Groups first`;
          results.push(out); continue;
        }

        const key = `tag:${tag.toLowerCase()}`;
        out.normalized = {
          asset_tag: tag, title,
          description: cell(raw, map, 'description') || null,
          serial: cell(raw, map, 'serial') || null,
          notes: cell(raw, map, 'notes') || null,
          color: cell(raw, map, 'color') || null,
          manufacturer: cell(raw, map, 'manufacturer') || null,
          status: importStatus,
          category_name: catName || null, location_name: locName || null,
          group_names: groupNames,
          value_cents: (() => {
            const v = cell(raw, map, 'value').replace(/[^0-9.]/g, '');
            return v ? Math.round(parseFloat(v) * 100) : null;
          })(),
        };
        if (st === 'checked_out') out.message = 'Status "checked out" imported as available (no loan record exists)';

        if (seen.has(key)) { out.verdict = 'skip_duplicate'; out.message = 'Duplicate asset tag earlier in this file'; }
        else {
          seen.add(key);
          const dup = await query(`SELECT id FROM public.assets WHERE lower(asset_tag) = lower($1)`, [tag]);
          if (dup.rows.length) {
            out.verdict = body.options?.apply_updates ? 'update' : 'skip_duplicate';
            out.message = out.verdict === 'update' ? 'Existing asset will be updated' : 'Asset tag already exists';
            out.normalized.existing_id = dup.rows[0].id;
          }
        }
        results.push(out);
        continue;
      }

      // ── loanees and group-members share the same person columns ──
      const first = cell(raw, map, 'first_name');
      const last = cell(raw, map, 'last_name');
      if (!first || !last) {
        out.verdict = 'error'; out.message = 'First and last name are required'; results.push(out); continue;
      }
      const email = cell(raw, map, 'email').toLowerCase();
      if (email && !EMAIL_RE.test(email)) {
        out.verdict = 'error'; out.message = `"${email}" is not a valid email address`; results.push(out); continue;
      }
      const phone = normPhone(cell(raw, map, 'phone_mobile'));
      if (!phoneValid(phone)) {
        out.verdict = 'error'; out.message = `Phone number "${cell(raw, map, 'phone_mobile')}" is not 10 digits`;
        results.push(out); continue;
      }

      const groupNames = splitList(cell(raw, map, 'groups'));
      const missingGroups = groupNames.filter(g => !groupByName.has(g.toLowerCase()));
      if (missingGroups.length) {
        out.verdict = 'error';
        out.message = `No such group: ${missingGroups.join(', ')} — create it under Groups first`;
        results.push(out); continue;
      }

      out.normalized = {
        first_name: first, last_name: last, full_name: `${first} ${last}`,
        email: email || null, phone_mobile: phone,
        position: cell(raw, map, 'position') || null,
        sub_committee: cell(raw, map, 'sub_committee') || null,
        notes: cell(raw, map, 'notes') || null,
        group_names: groupNames,
      };

      // Match key: email when present, else name + last four of the phone.
      const key = email ? `e:${email}` : `n:${first.toLowerCase()}|${last.toLowerCase()}|${last4(phone)}`;
      if (seen.has(key)) {
        out.verdict = 'skip_duplicate'; out.message = 'Duplicate person earlier in this file';
        results.push(out); continue;
      }
      seen.add(key);

      const dup = email
        ? await query(`SELECT id FROM public.loanees WHERE lower(email) = $1`, [email])
        : await query(
            `SELECT id FROM public.loanees
             WHERE lower(first_name) = lower($1) AND lower(last_name) = lower($2)
               AND right(regexp_replace(coalesce(phone_mobile,''), '\\D', '', 'g'), 4) = $3`,
            [first, last, last4(phone)]);

      if (dup.rows.length) {
        out.normalized.existing_id = dup.rows[0].id;
        if (kind === 'group_members') {
          out.verdict = 'update'; out.message = 'Will be added to the group';
        } else if (body.options?.apply_updates) {
          out.verdict = 'update'; out.message = 'Existing committee member will be updated';
        } else {
          out.verdict = 'skip_duplicate'; out.message = 'This person already exists';
        }
      } else if (kind === 'group_members' && !body.options?.create_missing_loanees) {
        out.verdict = 'error';
        out.message = 'No matching committee member — tick "also create missing committee members" or import them first';
      }
      results.push(out);
    }

    // Persist the verdicts. This is the ONLY thing preview writes.
    for (const r of results) {
      await query(
        `INSERT INTO public.import_rows (batch_id, row_number, raw, normalized, verdict, message)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [batchId, r.row_number, JSON.stringify(r.raw), JSON.stringify(r.normalized), r.verdict, r.message]);
    }
    const tally = await query(
      `SELECT verdict, count(*)::int AS n FROM public.import_rows WHERE batch_id = $1 GROUP BY verdict`, [batchId]);
    const summary = Object.fromEntries(tally.rows.map(t => [t.verdict, t.n]));
    await query(
      `UPDATE public.import_batches
       SET row_count = $2, ok_count = $3, dup_count = $4, error_count = $5 WHERE id = $1`,
      [batchId,
       Object.values(summary).reduce((a, b) => a + b, 0),
       (summary.create || 0) + (summary.update || 0),
       summary.skip_duplicate || 0, summary.error || 0]);

    return json({
      batch_id: batchId,
      summary,
      mapping: map,
      unknown_columns: unknown,
      will_create_categories: [...newCategories],
      will_create_locations: [...newLocations],
      rows: results,
    });
  },
});

// ═══ COMMIT ═════════════════════════════════════════════════════════
app.http('importCommit', {
  methods: ['POST'], authLevel: 'anonymous', route: 'imports/{kind}/commit',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const kind = KINDS[request.params.kind];
    if (!kind) return err('Unknown import type');
    const { body, bad } = await readJson(request); if (bad) return bad;
    const batchId = uuidOrNull(body?.batch_id);
    if (!batchId) return err('batch_id is required');

    const b = await query(`SELECT * FROM public.import_batches WHERE id = $1`, [batchId]);
    if (!b.rows.length) return err('Import batch not found', 404);
    const batch = b.rows[0];
    // Idempotency: a double-click can't double-import.
    if (batch.status === 'committed') return err('That import has already been committed', 409);
    if (batch.kind !== kind) return err('That batch is a different import type', 400);

    const applyUpdates = body.apply_updates === true;
    const wanted = applyUpdates ? ['create', 'update'] : ['create'];
    const rows = await query(
      `SELECT * FROM public.import_rows
       WHERE batch_id = $1 AND verdict = ANY($2::text[]) ORDER BY row_number`, [batchId, wanted]);

    let created = 0; let updated = 0; const errors = [];

    await withTransaction(async (client) => {
      const groups = await client.query(`SELECT id, lower(name) AS lname FROM public.groups`);
      const groupByName = new Map(groups.rows.map(g => [g.lname, g.id]));
      const cats = await client.query(`SELECT id, lower(name) AS lname FROM public.asset_categories`);
      const catByName = new Map(cats.rows.map(c => [c.lname, c.id]));
      const locs = await client.query(`SELECT id, lower(name) AS lname FROM public.asset_locations`);
      const locByName = new Map(locs.rows.map(l => [l.lname, l.id]));

      // Free-form lookup lists get auto-created (they're discovered during
      // the migration off the old system). The preview announced exactly
      // which ones, so this is a confirmed choice, not a silent one.
      async function ensureCategory(name) {
        if (!name) return null;
        const k = name.toLowerCase();
        if (catByName.has(k)) return catByName.get(k);
        const r = await client.query(
          `INSERT INTO public.asset_categories (name) VALUES ($1)
           ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
        catByName.set(k, r.rows[0].id);
        return r.rows[0].id;
      }
      async function ensureLocation(name) {
        if (!name) return null;
        const k = name.toLowerCase();
        if (locByName.has(k)) return locByName.get(k);
        const r = await client.query(
          `INSERT INTO public.asset_locations (name) VALUES ($1)
           ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
        locByName.set(k, r.rows[0].id);
        return r.rows[0].id;
      }

      for (const row of rows.rows) {
        const n = row.normalized || {};
        try {
          if (kind === 'assets') {
            const categoryId = await ensureCategory(n.category_name);
            const locationId = await ensureLocation(n.location_name);
            let assetId = n.existing_id;

            if (row.verdict === 'update' && assetId) {
              await client.query(
                // COALESCE on colour and manufacturer: a re-import from a
                // narrower export must not blank out details somebody typed
                // in by hand. An import can fill a gap; it cannot erase.
                `UPDATE public.assets SET title=$2, description=$3, serial=$4, notes=$5,
                        category_id=$6, location_id=$7, value_cents=$8,
                        color=COALESCE($9, color), manufacturer=COALESCE($10, manufacturer),
                        updated_at=now()
                 WHERE id = $1`,
                [assetId, n.title, n.description, n.serial, n.notes, categoryId, locationId,
                 n.value_cents, n.color, n.manufacturer]);
              updated++;
            } else {
              const r = await client.query(
                `INSERT INTO public.assets
                   (asset_tag, title, description, serial, notes, status, category_id, location_id,
                    value_cents, color, manufacturer, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
                [n.asset_tag, n.title, n.description, n.serial, n.notes, n.status || 'available',
                 categoryId, locationId, n.value_cents, n.color, n.manufacturer, user.sub]);
              assetId = r.rows[0].id;
              created++;
              await core.writeEvent(client, {
                asset_id: assetId, event: 'imported', actor: user,
                payload: { batch_id: batchId, row_number: row.row_number, asset_tag: n.asset_tag },
              });
            }
            for (const g of (n.group_names || [])) {
              const gid = groupByName.get(g.toLowerCase());
              if (gid) {
                await client.query(
                  `INSERT INTO public.asset_groups (asset_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                  [assetId, gid]);
              }
            }
            await client.query(`UPDATE public.import_rows SET result_id = $2 WHERE id = $1`, [row.id, assetId]);
            continue;
          }

          // ── loanees / group-members ──
          let loaneeId = n.existing_id;
          if (loaneeId && row.verdict === 'update' && kind === 'loanees') {
            await client.query(
              `UPDATE public.loanees SET first_name=$2, last_name=$3, full_name=$4,
                      email=COALESCE($5, email), phone_mobile=COALESCE($6, phone_mobile),
                      position=COALESCE($7, position), sub_committee=COALESCE($8, sub_committee),
                      notes=COALESCE($9, notes), updated_at=now()
               WHERE id = $1`,
              [loaneeId, n.first_name, n.last_name, n.full_name, n.email, n.phone_mobile,
               n.position, n.sub_committee, n.notes]);
            updated++;
          } else if (!loaneeId) {
            const r = await client.query(
              `INSERT INTO public.loanees
                 (first_name, last_name, full_name, email, phone_mobile, position, sub_committee, notes, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
              [n.first_name, n.last_name, n.full_name, n.email, n.phone_mobile,
               n.position, n.sub_committee, n.notes, user.sub]);
            loaneeId = r.rows[0].id;
            created++;
          }

          for (const g of (n.group_names || [])) {
            const gid = groupByName.get(g.toLowerCase());
            if (gid) {
              await client.query(
                `INSERT INTO public.group_members (group_id, loanee_id, added_by)
                 VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gid, loaneeId, user.sub]);
            }
          }
          // A group-members import drops everyone into the batch's target group.
          if (kind === 'group_members' && batch.target_group_id) {
            await client.query(
              `INSERT INTO public.group_members (group_id, loanee_id, added_by)
               VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [batch.target_group_id, loaneeId, user.sub]);
          }
          await client.query(`UPDATE public.import_rows SET result_id = $2 WHERE id = $1`, [row.id, loaneeId]);
        } catch (e) {
          errors.push({ row_number: row.row_number, error: e.message });
          await client.query(
            `UPDATE public.import_rows SET verdict = 'error', message = $2 WHERE id = $1`,
            [row.id, e.message.slice(0, 500)]);
        }
      }

      await client.query(
        `UPDATE public.import_batches SET status = 'committed', committed_at = now() WHERE id = $1`, [batchId]);
    });

    await logAudit(request, {
      profile_id: user.sub, email: user.email, action: 'import_committed',
      detail: `${kind}: ${created} created, ${updated} updated, ${errors.length} failed (batch ${batchId})` });
    return json({ created, updated, skipped: 0, errors });
  },
});

app.http('importsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'imports',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const limit = Math.min(parseInt(qs(request).get('limit') || '50', 10) || 50, 200);
    const r = await query(
      `SELECT b.*, p.full_name AS created_by_name, g.name AS target_group
       FROM public.import_batches b
       LEFT JOIN public.profiles p ON p.id = b.created_by
       LEFT JOIN public.groups   g ON g.id = b.target_group_id
       ORDER BY b.created_at DESC LIMIT $1`, [limit]);
    return json(r.rows);
  },
});

// Feeds the "download the errors as CSV" affordance — the single most
// useful thing when a 2,000-row roster has 40 bad rows in it.
app.http('importRows', {
  methods: ['GET'], authLevel: 'anonymous', route: 'imports/{id}/rows',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const verdict = qs(request).get('verdict');
    const r = await query(
      `SELECT row_number, raw, normalized, verdict, message, result_id
       FROM public.import_rows
       WHERE batch_id = $1 AND ($2::text IS NULL OR verdict = $2)
       ORDER BY row_number LIMIT 5000`,
      [request.params.id, ['create', 'update', 'skip_duplicate', 'error'].includes(verdict) ? verdict : null]);
    return json(r.rows);
  },
});

module.exports = {};
