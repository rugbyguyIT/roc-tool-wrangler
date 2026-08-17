// ═══════════════════════════════════════════════════════════════════════
// Roster import — the Rodeo Operations export, loaded and RE-loaded.
//
// This is deliberately a separate module from the general importer. The
// general importer answers "add these rows"; this one answers "make the
// app match this spreadsheet", which is a different question with
// different failure modes — the dangerous outcome here is not a rejected
// row, it is silently overwriting something a human curated.
//
// THE KEY IS THE CUSTOMER NUMBER. Names change (marriage, a preferred
// name finally filled in), emails change, committees change. Matching on
// name would create a duplicate person the first time any of that
// happened. Every match, every diff, every re-import pivots on
// member_number and nothing else.
//
// WHAT A RE-IMPORT MAY TOUCH: first name, last name, title, committee,
// phone, email — and reactivating someone who came back. That is the
// whole list. It may not touch notes, group membership, passwords, or
// anything else a person edited by hand in the app, because the
// spreadsheet is not the authority on those.
// ═══════════════════════════════════════════════════════════════════════

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ── Column mapping ─────────────────────────────────────────────────────
// The roster export's headers are stable, but aliases are listed anyway so
// a re-exported file with slightly different casing or spacing still maps.
const ROSTER_ALIASES = {
  member_number:  ['customer number', 'customer no', 'customer #', 'member number', 'member no'],
  title:          ['title'],
  first_name:     ['first name', 'first'],
  preferred_name: ['preferred name', 'preferred', 'nickname', 'goes by'],
  last_name:      ['last name', 'last', 'surname'],
  sub_committee:  ['subcommittee 1', 'sub committee 1', 'subcommittee1', 'subcommittee', 'sub committee'],
  phone_mobile:   ['primary phone', 'phone', 'primary phone number'],
  email:          ['primary email', 'email', 'primary email address'],
  zip:            ['zip', 'zip code', 'postal code', 'zipcode'],
};

// Titles that make someone leadership. Everything else is a regular
// member; Base membership (below) is what makes someone desk staff.
const LEADERSHIP_TITLES = ['chairman', 'division chairman'];

// The subcommittee whose members work the tool crib.
const BASE_SUBCOMMITTEE = 'base';

// Fields a re-import is allowed to change on an existing loanee. Anything
// not in this list is left exactly as the app has it.
const SYNCED_FIELDS = ['first_name', 'last_name', 'title', 'sub_committee', 'phone_mobile', 'email'];

function normHeader(h) {
  return String(h || '').trim().toLowerCase()
    .replace(/[_\-\s]+/g, ' ').replace(/[.#]/g, '').trim();
}

function buildRosterMap(headers) {
  const map = {}; const unknown = [];
  for (const h of headers) {
    const n = normHeader(h);
    const field = Object.keys(ROSTER_ALIASES).find(f =>
      ROSTER_ALIASES[f].includes(n) || normHeader(f) === n);
    if (field) map[h] = field; else unknown.push(h);
  }
  return { map, unknown };
}

// Every field a column can be mapped to, for the UI's dropdown. Order is
// the order they appear in the mapping editor.
const MAPPABLE_FIELDS = [
  { key: 'member_number',  label: 'Member Number (Customer Number)', required: true },
  { key: 'first_name',     label: 'First Name',                      required: true },
  { key: 'preferred_name', label: 'Preferred Name (wins over First)', required: false },
  { key: 'last_name',      label: 'Last Name',                       required: true },
  { key: 'title',          label: 'Title',                           required: false },
  { key: 'sub_committee',  label: 'Committee',                       required: false },
  { key: 'phone_mobile',   label: 'Phone',                           required: false },
  { key: 'email',          label: 'Email',                           required: false },
  { key: 'zip',            label: 'Zip (used as the initial password)', required: false },
];

// Resolve the mapping actually used for an import.
//
// Precedence: what the admin just chose > what was saved last time > what
// auto-detection found. Saved and explicit entries are ignored when they
// name a header this file does not have, so a stale saved mapping degrades
// to auto-detection for the columns that moved rather than blanking them.
// An empty-string field means "deliberately ignore this column", which is
// why it deletes rather than skipping.
function resolveMap(headers, saved, explicit) {
  const { map: detected } = buildRosterMap(headers);
  const map = { ...detected };
  for (const source of [saved, explicit]) {
    for (const [h, f] of Object.entries(source || {})) {
      if (!headers.includes(h)) continue;
      if (f) map[h] = f; else delete map[h];
    }
  }
  return { map, detected, unknown: headers.filter(h => !map[h]) };
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

// Phone: keep 10 digits, drop a leading country code. Stored as digits so
// two spellings of the same number compare equal on re-import — otherwise
// "(281) 433-3662" vs "281-433-3662" would look like a change every time.
function normPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return d;
}

// The roster carries ZIP+4 ("77494-4268") for most people and a bare
// 5-digit zip for a couple. The password is the 5-digit zip in both cases,
// because that is what someone answers when you ask for their zip code.
function zip5(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 5 ? d.slice(0, 5) : '';
}

// Preferred name wins when present. This is the whole reason the roster
// carries both: "Charles" is on the membership record, but everyone at the
// grounds knows him as "Lee", and the person at the tool crib searching for
// him will type Lee.
function displayFirstName(first, preferred) {
  return (preferred || '').trim() || (first || '').trim();
}

function roleFor({ sub_committee, title }) {
  const t = (title || '').trim().toLowerCase();
  if (LEADERSHIP_TITLES.includes(t)) return 'leader';
  if ((sub_committee || '').trim().toLowerCase() === BASE_SUBCOMMITTEE) return 'staff';
  return null;   // no login
}

// ── Row → normalized record ────────────────────────────────────────────
function normalizeRow(row, map) {
  const first     = cell(row, map, 'first_name');
  const preferred = cell(row, map, 'preferred_name');
  const last      = cell(row, map, 'last_name');
  const rec = {
    member_number: cell(row, map, 'member_number'),
    first_name:    displayFirstName(first, preferred),
    last_name:     last,
    title:         cell(row, map, 'title'),
    sub_committee: cell(row, map, 'sub_committee'),
    phone_mobile:  normPhone(cell(row, map, 'phone_mobile')),
    email:         cell(row, map, 'email').toLowerCase(),
    zip5:          zip5(cell(row, map, 'zip')),
  };
  rec.full_name = `${rec.first_name} ${rec.last_name}`.trim();
  rec.login_role = roleFor(rec);
  return rec;
}

// ── Validation ─────────────────────────────────────────────────────────
// Deliberately permissive: this roster is the system of record for real
// people, and refusing to load someone because their email is malformed
// would leave a volunteer unable to check out a wrench. Only the things
// that make a row meaningless are errors.
function validate(rec) {
  if (!rec.member_number) return 'Customer Number is required — it is the key every re-import matches on';
  if (!rec.last_name)     return 'Last Name is required';
  if (!rec.first_name)    return 'A First Name or Preferred Name is required';
  if (rec.email && !EMAIL_RE.test(rec.email)) return `"${rec.email}" is not a valid email address`;
  if (rec.phone_mobile && rec.phone_mobile.length !== 10) {
    return `Primary Phone "${rec.phone_mobile}" is not 10 digits`;
  }
  // A login is only possible with somewhere to send it and something to
  // type. Flag it, but do not fail the row — they still become a loanee.
  return null;
}

// Why a row that maps to a login might not get one. Returned as a warning
// on the row, never as an error.
function loginBlocker(rec) {
  if (!rec.login_role) return null;
  if (!rec.email)  return 'no email on the roster, so no login can be created';
  if (!rec.zip5)   return 'no usable zip on the roster, so no password can be set';
  return null;
}

// ── The diff ───────────────────────────────────────────────────────────
// Compares an incoming roster record against what the database already
// holds and returns only genuinely-changed fields. Blank incoming values
// never clear a populated field: a missing cell in an export means "this
// column wasn't included", not "delete what you know".
function diffLoanee(existing, rec) {
  const changes = {};
  for (const f of SYNCED_FIELDS) {
    const next = (rec[f] ?? '').toString();
    const prev = (existing[f] ?? '').toString();
    if (!next) continue;                 // never blank out on absence
    if (next !== prev) changes[f] = { from: prev, to: next };
  }
  // Someone who dropped off a previous roster and is back on this one.
  if (existing.status !== 'active') {
    changes.status = { from: existing.status, to: 'active' };
  }
  return changes;
}

module.exports = {
  ROSTER_ALIASES, LEADERSHIP_TITLES, BASE_SUBCOMMITTEE, SYNCED_FIELDS,
  MAPPABLE_FIELDS, resolveMap,
  normHeader, buildRosterMap, cell, normPhone, zip5,
  displayFirstName, roleFor, normalizeRow, validate, loginBlocker, diffLoanee,
};
