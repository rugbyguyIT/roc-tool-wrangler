// ═══════════════════════════════════════════════════════════════════════
// Roster import — routes.
//   POST /api/roster/preview   admin   dry run, writes nothing real
//   POST /api/roster/commit    admin   applies a previewed batch
//
// Deliberately NOT under /api/imports/{kind}/ — that route already has a
// wildcard segment, and adding a literal 'roster' beside it makes which
// handler wins depend on registration order. A distinct path is worth
// more than a tidy-looking URL.
//
// Same two-phase shape as the general importer, and for the same reason:
// preview writes only to import_rows, and commit re-reads those rows from
// the database rather than trusting a re-sent client payload. What the
// admin approved is literally what gets written.
//
// What makes this one different is that it is designed to be run again.
// The second run is the important one: it must change the handful of
// people who moved, leave the other 480-odd untouched, and never undo
// something a human did in the app. See api/src/roster.js for the diff
// rules that enforce that.
// ═══════════════════════════════════════════════════════════════════════
const { app } = require('@azure/functions');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../db');
const {
  json, err, requireRole, logAudit, readJson, uuidOrNull,
} = require('../middleware');
const R = require('../roster');

const MAX_CHUNK = 500;

// ═══ PREVIEW ═══════════════════════════════════════════════════════════
app.http('rosterPreview', {
  methods: ['POST'], authLevel: 'anonymous', route: 'roster/preview',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;

    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (!rows.length) return err('No rows were sent');
    if (rows.length > MAX_CHUNK) return err(`Send at most ${MAX_CHUNK} rows per request`);

    // Batch is created on the first chunk and reused for the rest.
    let batchId = uuidOrNull(body.batch_id);
    if (!batchId) {
      const b = await query(
        `INSERT INTO public.import_batches (kind, filename, options, created_by)
         VALUES ('roster', $1, $2, $3) RETURNING id`,
        [body.filename || null, body.options || {}, user.sub]);
      batchId = b.rows[0].id;
    }

    const headers = Array.isArray(body.headers) ? body.headers : Object.keys(rows[0] || {});
    const { map, unknown } = R.buildRosterMap(headers);

    // Bail early and legibly rather than marking 493 rows as errors.
    if (!Object.values(map).includes('member_number')) {
      return err('This file has no Customer Number column, which is the key every re-import matches on. Check you exported the full roster.');
    }

    // One query for every member number in the chunk, rather than 493
    // round trips.
    const numbers = rows.map(r => R.normalizeRow(r, map).member_number).filter(Boolean);
    const existing = await query(
      `SELECT id, member_number, first_name, last_name, title, sub_committee,
              phone_mobile, email, status
       FROM public.loanees WHERE member_number = ANY($1::text[])`, [numbers]);
    const byNumber = new Map(existing.rows.map(r => [r.member_number, r]));

    // Whether groups may still be auto-created. Only ever true once.
    const st = await query(`SELECT roster_groups_seeded_at FROM public.app_settings WHERE id = 1`);
    const groupsAlreadySeeded = !!st.rows[0]?.roster_groups_seeded_at;

    const existingGroups = await query(`SELECT lower(name) AS lname FROM public.groups`);
    const haveGroup = new Set(existingGroups.rows.map(g => g.lname));

    const out = [];
    const subcommittees = new Set();
    const loginBlocked = [];
    let counts = { create: 0, update: 0, unchanged: 0, error: 0 };
    let logins = { staff: 0, leader: 0 };

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const rowNumber = raw.row_number || (i + 2);
      const rec = R.normalizeRow(raw, map);

      const problem = R.validate(rec);
      if (problem) {
        counts.error++;
        out.push({ row_number: rowNumber, raw, normalized: rec, verdict: 'error', message: problem, changes: null });
        continue;
      }

      if (rec.sub_committee) subcommittees.add(rec.sub_committee);

      const blocker = R.loginBlocker(rec);
      if (blocker) loginBlocked.push({ name: rec.full_name, reason: blocker });
      else if (rec.login_role) logins[rec.login_role]++;

      const prior = byNumber.get(rec.member_number);
      if (!prior) {
        counts.create++;
        out.push({ row_number: rowNumber, raw, normalized: rec, verdict: 'create',
                   message: rec.login_role ? `New — will also get a ${rec.login_role === 'staff' ? 'Base' : 'Leadership'} login` : 'New',
                   changes: null });
        continue;
      }

      const changes = R.diffLoanee(prior, rec);
      const fields = Object.keys(changes);
      if (!fields.length) {
        counts.unchanged++;
        out.push({ row_number: rowNumber, raw, normalized: rec, verdict: 'unchanged', message: 'No change', changes: null });
      } else {
        counts.update++;
        out.push({ row_number: rowNumber, raw, normalized: { ...rec, _id: prior.id },
                   verdict: 'update', message: fields.join(', '), changes });
      }
    }

    // Persist the chunk.
    for (const r of out) {
      await query(
        `INSERT INTO public.import_rows (batch_id, row_number, raw, normalized, verdict, message, changes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [batchId, r.row_number, r.raw, r.normalized, r.verdict, r.message, r.changes]);
    }

    // ── Final chunk: who has fallen off the roster? ─────────────────────
    // Only computable once every row has been seen, so the client marks
    // the last chunk. These become real import_rows so the admin approves
    // deactivations exactly like any other change.
    let deactivate = [];
    if (body.final === true) {
      const seen = await query(
        `SELECT DISTINCT normalized->>'member_number' AS mn
         FROM public.import_rows WHERE batch_id = $1 AND verdict <> 'error'`, [batchId]);
      const seenSet = seen.rows.map(r => r.mn).filter(Boolean);
      const gone = await query(
        `SELECT id, member_number, full_name, sub_committee
         FROM public.loanees
         WHERE member_number IS NOT NULL AND member_number <> ''
           AND status = 'active'
           AND NOT (member_number = ANY($1::text[]))
         ORDER BY full_name`, [seenSet]);
      deactivate = gone.rows;
      for (const g of deactivate) {
        await query(
          `INSERT INTO public.import_rows (batch_id, row_number, raw, normalized, verdict, message)
           VALUES ($1,$2,$3,$4,'deactivate',$5)`,
          [batchId, 0, { member_number: g.member_number }, { _id: g.id, member_number: g.member_number, full_name: g.full_name },
           'Not in this file — will be marked inactive']);
      }
    }

    // ── Whole-file totals ──────────────────────────────────────────────
    // Preview is chunked, but the admin is approving the WHOLE file, so
    // the numbers they see must cover it. Per-chunk counts would say "12
    // logins" on a 493-row roster that actually creates 52, which is
    // exactly the kind of number someone approves without reading twice.
    // On the final chunk these are recomputed across the entire batch.
    let totals = counts;
    let allSubcommittees = [...subcommittees];
    let allLogins = logins;
    if (body.final === true) {
      const t = await query(
        `SELECT verdict, count(*)::int AS n FROM public.import_rows
         WHERE batch_id = $1 GROUP BY verdict`, [batchId]);
      totals = { create: 0, update: 0, unchanged: 0, error: 0, deactivate: 0 };
      for (const r of t.rows) totals[r.verdict] = r.n;

      const subs = await query(
        `SELECT DISTINCT normalized->>'sub_committee' AS s FROM public.import_rows
         WHERE batch_id = $1 AND verdict <> 'error'
           AND coalesce(normalized->>'sub_committee','') <> '' ORDER BY 1`, [batchId]);
      allSubcommittees = subs.rows.map(r => r.s);

      const lg = await query(
        `SELECT normalized->>'login_role' AS role, count(*)::int AS n FROM public.import_rows
         WHERE batch_id = $1 AND verdict IN ('create','update','unchanged')
           AND coalesce(normalized->>'login_role','') <> ''
           AND coalesce(normalized->>'email','') <> ''
           AND coalesce(normalized->>'zip5','') <> ''
         GROUP BY 1`, [batchId]);
      allLogins = { staff: 0, leader: 0 };
      for (const r of lg.rows) allLogins[r.role] = r.n;
    }

    const newGroups = allSubcommittees.filter(s => !haveGroup.has(s.toLowerCase()));

    return json({
      batch_id: batchId,
      rows: out.map(r => ({ row_number: r.row_number, verdict: r.verdict, message: r.message,
                            normalized: r.normalized, changes: r.changes })),
      summary: totals,
      final: body.final === true,
      unknown_columns: unknown,
      subcommittees: allSubcommittees.sort(),
      // Groups are only offered on the very first roster import.
      will_create_groups: groupsAlreadySeeded ? [] : newGroups,
      groups_already_seeded: groupsAlreadySeeded,
      unseeded_new_subcommittees: groupsAlreadySeeded ? newGroups : [],
      logins: allLogins,
      login_blocked: loginBlocked,
      deactivate,
    });
  },
});

// ═══ COMMIT ════════════════════════════════════════════════════════════
app.http('rosterCommit', {
  methods: ['POST'], authLevel: 'anonymous', route: 'roster/commit',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const batchId = uuidOrNull(body?.batch_id);
    if (!batchId) return err('batch_id is required');

    const b = await query(`SELECT * FROM public.import_batches WHERE id = $1`, [batchId]);
    if (!b.rows.length) return err('Import batch not found', 404);
    const batch = b.rows[0];
    if (batch.kind !== 'roster') return err('That batch is not a roster import', 400);
    // A double-click cannot double-import.
    if (batch.status === 'committed') return err('That import has already been committed', 409);

    const applyDeactivations = body.apply_deactivations !== false;

    const rows = await query(
      `SELECT * FROM public.import_rows
       WHERE batch_id = $1 AND verdict IN ('create','update','deactivate')
       ORDER BY row_number`, [batchId]);

    let created = 0, updated = 0, deactivated = 0, loginsCreated = 0;
    const createdLogins = [];
    const errors = [];

    await withTransaction(async (client) => {
      // ── Groups, first import only ────────────────────────────────────
      const st = await client.query(
        `SELECT roster_groups_seeded_at FROM public.app_settings WHERE id = 1 FOR UPDATE`);
      const alreadySeeded = !!st.rows[0]?.roster_groups_seeded_at;

      const g = await client.query(`SELECT id, lower(name) AS lname FROM public.groups`);
      const groupByName = new Map(g.rows.map(x => [x.lname, x.id]));

      let seededNow = 0;
      if (!alreadySeeded) {
        const subs = await client.query(
          `SELECT DISTINCT normalized->>'sub_committee' AS s
           FROM public.import_rows
           WHERE batch_id = $1 AND verdict IN ('create','update','unchanged')
             AND coalesce(normalized->>'sub_committee','') <> ''
           ORDER BY 1`, [batchId]);
        for (const { s } of subs.rows) {
          const k = s.toLowerCase();
          if (groupByName.has(k)) continue;
          const r = await client.query(
            `INSERT INTO public.groups (name, description, created_by)
             VALUES ($1, $2, $3)
             ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [s, 'Created from the first roster import', user.sub]);
          groupByName.set(k, r.rows[0].id);
          seededNow++;
        }
        await client.query(
          `UPDATE public.app_settings SET roster_groups_seeded_at = now(), updated_by = $1 WHERE id = 1`,
          [user.sub]);
      }

      // ── Rows ─────────────────────────────────────────────────────────
      for (const row of rows.rows) {
        const n = row.normalized || {};
        try {
          if (row.verdict === 'deactivate') {
            if (!applyDeactivations) continue;
            await client.query(
              `UPDATE public.loanees
               SET status = 'inactive', status_reason = $2, updated_at = now()
               WHERE id = $1`,
              [n._id, `absent from roster import ${new Date().toISOString().slice(0, 10)}`]);
            deactivated++;
            continue;
          }

          let loaneeId = n._id || null;

          if (row.verdict === 'create') {
            const r = await client.query(
              `INSERT INTO public.loanees
                 (first_name, last_name, full_name, email, phone_mobile, title,
                  sub_committee, member_number, status, roster_synced_at, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',now(),$9)
               ON CONFLICT (member_number) WHERE member_number IS NOT NULL AND member_number <> ''
               DO UPDATE SET roster_synced_at = now()
               RETURNING id`,
              [n.first_name, n.last_name, n.full_name, n.email || null, n.phone_mobile || null,
               n.title || null, n.sub_committee || null, n.member_number, user.sub]);
            loaneeId = r.rows[0].id;
            created++;
          } else {
            // Update: only the fields the preview said changed.
            const changes = row.changes || {};
            const sets = []; const vals = [loaneeId];
            for (const [f, v] of Object.entries(changes)) {
              if (f === 'status') { sets.push(`status = 'active'`); sets.push(`status_reason = NULL`); continue; }
              vals.push(v.to); sets.push(`${f} = $${vals.length}`);
            }
            if (changes.first_name || changes.last_name) {
              vals.push(`${changes.first_name?.to ?? n.first_name} ${changes.last_name?.to ?? n.last_name}`.trim());
              sets.push(`full_name = $${vals.length}`);
            }
            sets.push(`roster_synced_at = now()`, `updated_at = now()`);
            await client.query(`UPDATE public.loanees SET ${sets.join(', ')} WHERE id = $1`, vals);
            updated++;
          }

          // ── Group membership from the committee ────────────────────────
          if (n.sub_committee) {
            const gid = groupByName.get(n.sub_committee.toLowerCase());
            if (gid) {
              await client.query(
                `INSERT INTO public.group_members (group_id, loanee_id, added_by)
                 VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gid, loaneeId, user.sub]);
            }
          }

          // ── Login account ─────────────────────────────────────────────
          // Created once and never touched again: a re-import must not
          // reset a password someone has since changed, nor demote an
          // account an admin deliberately promoted.
          if (n.login_role && n.email && n.zip5) {
            const have = await client.query(
              `SELECT id FROM public.profiles WHERE member_number = $1 OR lower(email) = lower($2)`,
              [n.member_number, n.email]);
            if (!have.rows.length) {
              await client.query(
                `INSERT INTO public.profiles
                   (email, first_name, last_name, full_name, phone_mobile, role,
                    password_hash, member_number, status, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9)
                 ON CONFLICT (email) DO NOTHING`,
                [n.email, n.first_name, n.last_name, n.full_name, n.phone_mobile || null,
                 n.login_role, bcrypt.hashSync(n.zip5, 10), n.member_number, user.sub]);
              loginsCreated++;
              createdLogins.push({ name: n.full_name, email: n.email, role: n.login_role });
            }
          }

          await client.query(`UPDATE public.import_rows SET result_id = $2 WHERE id = $1`, [row.id, loaneeId]);
        } catch (e) {
          errors.push({ row_number: row.row_number, message: e.message });
        }
      }

      await client.query(
        `UPDATE public.import_batches SET status = 'committed', committed_at = now() WHERE id = $1`,
        [batchId]);

      if (seededNow) {
        await logAudit(request, {
          profile_id: user.sub, email: user.email, full_name: user.name,
          action: 'roster_groups_seeded', detail: `${seededNow} group(s) created from Subcommittee 1`,
        });
      }
    });

    await logAudit(request, {
      profile_id: user.sub, email: user.email, full_name: user.name,
      action: 'roster_imported',
      detail: `${created} added, ${updated} updated, ${deactivated} deactivated, ${loginsCreated} login(s) created`,
    });

    return json({ created, updated, deactivated, logins_created: loginsCreated, created_logins: createdLogins, errors });
  },
});
