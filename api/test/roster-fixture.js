// ═══════════════════════════════════════════════════════════════════════
// Roster test fixture — generated, not stored.
//
// The suite needs the SHAPE of the real Rodeo Operations export, not the
// people in it. roster-shape.json records only that shape: for each of
// the 493 rows, which title, which subcommittee, whether a preferred name
// exists, and whether the zip is ZIP+4 or plain — plus the customer
// numbers, which are opaque ids and the key the whole import pivots on.
//
// Names, emails, phones and zip digits are synthesised here, entirely
// deterministically, so every run produces byte-identical fixtures and a
// failure is always reproducible. No member's contact details are stored
// in this repo.
//
// Regenerate the shape file from a real export with:
//   node api/test/roster-fixture.js --from <export.json>
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const SHAPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'roster-shape.json'), 'utf8'));

const FIRST = ['Avery', 'Jordan', 'Casey', 'Riley', 'Quinn', 'Rowan',
               'Emerson', 'Skyler', 'Harper', 'Sawyer', 'Reese', 'Finley'];
const LAST  = ['Ellis', 'Marsh', 'Vance', 'Kerr', 'Boone', 'Deleon',
               'Fowler', 'Rhodes', 'Nash', 'Ibarra', 'Colby', 'Pryor'];

const HEADERS = ['Title', 'Customer Number', 'First Name', 'Last Name',
                 'Preferred Name', 'Subcommittee 1', 'Primary Phone',
                 'Primary Email', 'Zip'];

function build() {
  const rows = SHAPE.rows.map(([ti, si, hasPref, zipKind, customerNumber], i) => {
    const fn = FIRST[i % FIRST.length];
    // Suffixing the index keeps every last name unique, so a failure
    // naming "Ellis0" points at exactly one row.
    const ln = `${LAST[Math.floor(i / FIRST.length) % LAST.length]}${i}`;
    const zipBase = `7${String(7000 + (i % 900)).padStart(4, '0')}`;
    return {
      'Title': SHAPE.titles[ti],
      'Customer Number': customerNumber,
      'First Name': fn,
      'Last Name': ln,
      // Preserves WHETHER a preferred name exists — that is the behaviour
      // under test (preferred name must win over first name).
      'Preferred Name': hasPref ? `${fn.slice(0, 3)}y` : '',
      'Subcommittee 1': SHAPE.subcommittees[si],
      'Primary Phone': `(713) 555-${String(1000 + i).padStart(4, '0')}`,
      'Primary Email': `${fn.toLowerCase()}.${ln.toLowerCase()}@example.com`,
      // Preserves the ZIP+4 vs 5-digit mix, which is what proves the
      // password is the 5-digit zip and not the whole string.
      'Zip': zipKind === 0 ? '' : zipKind === 2
        ? `${zipBase}-${String(1000 + i).padStart(4, '0')}` : zipBase,
      row_number: i + 2,
    };
  });
  return { headers: HEADERS, rows };
}

module.exports = { build, HEADERS };

// ── Regeneration ───────────────────────────────────────────────────────
if (require.main === module) {
  const idx = process.argv.indexOf('--from');
  if (idx === -1) {
    const f = build();
    console.log(`${f.rows.length} rows, ${SHAPE.titles.length} titles, ${SHAPE.subcommittees.length} subcommittees`);
    console.log(JSON.stringify(f.rows[0], null, 2));
    process.exit(0);
  }
  // Reduce a real export (as JSON rows) to a shape file, discarding every
  // piece of personal data except the opaque customer number.
  const src = JSON.parse(fs.readFileSync(process.argv[idx + 1], 'utf8'));
  const rows = src.rows || src;
  const titles = [...new Set(rows.map(r => r['Title']))].sort();
  const subs = [...new Set(rows.map(r => r['Subcommittee 1']))].sort();
  const shape = {
    titles, subcommittees: subs,
    rows: rows.map(r => [
      titles.indexOf(r['Title']), subs.indexOf(r['Subcommittee 1']),
      r['Preferred Name'] ? 1 : 0,
      r['Zip'] ? (String(r['Zip']).length > 5 ? 2 : 1) : 0,
      String(r['Customer Number']),
    ]),
  };
  fs.writeFileSync(path.join(__dirname, 'roster-shape.json'), JSON.stringify(shape));
  console.log(`wrote roster-shape.json — ${shape.rows.length} rows, no personal data retained`);
}
