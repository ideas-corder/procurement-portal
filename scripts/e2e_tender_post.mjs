// E2E — Post an OPEN TENDER, against the live API.
//
//   node scripts/e2e_tender_post.mjs
//
// WHAT THIS PINS (open-tender step 1: posting)
// -------------------------------------------
// An open tender is a proc.rfq row with sourcing_mode = 'open_tender'
// (migration 076). Posting one must:
//   1. refuse a non-procurement caller (403),
//   2. refuse a missing deadline (400) — the deadline is what closes bidding,
//   3. create the RFQ as Open / open_tender, carrying tender_notes,
//   4. snapshot the PR's quotable lines onto rfq_lines (bids FK into them),
//   5. create NO invitations — an open tender has no roster,
//   6. block a second RFQ or tender on the same PR (one live sourcing per PR),
//   7. leave invited RFQs untouched: every pre-076 row is still 'invited'.

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

let pass = 0, fail = 0;
const ok = (l, x = '') => { pass++; console.log(`  PASS  ${l}${x ? `  (${x})` : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}\n        ${d}`); };

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  const j = await r.json();
  return j.token || j.accessToken;
}

function sql(q) {
  const r = spawnSync('docker', [
    'exec', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
    '-X', '-A', '-F', '\t', '-t', '-c', q,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `psql failed (${r.status})`);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t'));
}

async function post(path, token, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: j };
}

const procTok = await login('procurement@pakboxes.pk');
const hodTok = await login('hod.sales@pakboxes.pk');

// ── 1. a sourceable PR (same selection rule as e2e_rfq_issue.mjs) ────────────
console.log('\n== 1. pick a PR in procurement review with no RFQ ==');
const pick = sql(
  `SELECT pr.id::text, pr.pr_number::text
     FROM proc.purchase_requisitions pr
     JOIN proc.pr_lines pl ON pl.pr_id = pr.id AND pl.rejected = false
                              AND pl.category IS NOT NULL
     JOIN core.vendors v
       ON v.state <> ALL(ARRAY['Rejected','Blacklisted','Deactivated'])
      AND NOT v.is_hold
      AND NOT EXISTS (
        SELECT 1 FROM core.vendor_blacklist b
         WHERE b.vendor_id = v.id AND b.resolved_at IS NULL)
     JOIN core.vendor_categories vc ON vc.vendor_id = v.id AND vc.is_active
     JOIN core.categories c ON c.id = vc.category_id AND c.code = pl.category
     CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS comp
    WHERE pr.status = 'IN_PROCUREMENT_REVIEW'
      AND comp.blocked IS DISTINCT FROM true
      AND NOT EXISTS (SELECT 1 FROM proc.rfq r WHERE r.pr_id = pr.id AND r.state <> 'Cancelled')
    GROUP BY pr.id, pr.pr_number
    ORDER BY pr.created_at DESC LIMIT 1`);
if (pick.length === 0) {
  bad('found a sourceable PR at IN_PROCUREMENT_REVIEW',
    'none with a categorised, non-rejected line and no open RFQ — create one first');
  process.exit(1);
}
const [prId, prNumber] = pick[0];
ok(`using ${prNumber}`, prId);

const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();

// ── 2. role gate ─────────────────────────────────────────────────────────────
console.log('\n== 2. only procurement may post ==');
{
  const r = await post(`/pr/${prId}/tender`, hodTok, { deadlineAt: deadline });
  r.status === 403 ? ok('HOD refused', '403') : bad('HOD refused', `got ${r.status} ${JSON.stringify(r.body)}`);
}

// ── 3. deadline required ─────────────────────────────────────────────────────
console.log('\n== 3. deadline is required ==');
{
  const r = await post(`/pr/${prId}/tender`, procTok, { title: 'no deadline' });
  r.status === 400 ? ok('missing deadline refused', '400') : bad('missing deadline refused', `got ${r.status}`);
  const n = sql(`SELECT count(*) FROM proc.rfq WHERE pr_id='${prId}' AND state <> 'Cancelled'`);
  Number(n[0][0]) === 0 ? ok('refusal left no RFQ row behind') : bad('refusal left no RFQ row behind', `${n[0][0]} rows`);
}

// ── 4. post the tender ───────────────────────────────────────────────────────
console.log('\n== 4. POST /pr/:id/tender ==');
const notes = 'Delivery to Karachi plant within 14 days. Prices inclusive of GST.';
const res = await post(`/pr/${prId}/tender`, procTok, {
  deadlineAt: deadline, title: `Tender for ${prNumber}`, notes,
});
if (res.status !== 201 && res.status !== 200) {
  bad('tender posted', `got ${res.status} ${JSON.stringify(res.body)}`);
  process.exit(1);
}
const t = res.body.rfq;
ok('tender posted', `${t.rfq_number}, ${res.body.eligible_vendor_count} eligible vendor(s)`);
t.sourcing_mode === 'open_tender' ? ok('response says open_tender') : bad('response says open_tender', t.sourcing_mode);
!('invitations' in res.body) ? ok('response carries no invitations') : bad('response carries no invitations', 'present');

const row = sql(
  `SELECT state, sourcing_mode, coalesce(tender_notes,''), deadline_at::text
     FROM proc.rfq WHERE id='${t.id}'`)[0];
row[0] === 'Open' ? ok('db: state Open') : bad('db: state Open', row[0]);
row[1] === 'open_tender' ? ok('db: sourcing_mode open_tender') : bad('db: sourcing_mode', row[1]);
row[2] === notes ? ok('db: tender_notes stored') : bad('db: tender_notes stored', row[2]);

const lines = Number(sql(`SELECT count(*) FROM proc.rfq_lines WHERE rfq_id='${t.id}'`)[0][0]);
lines > 0 ? ok('db: rfq_lines snapshotted', `${lines}`) : bad('db: rfq_lines snapshotted', '0');

const inv = Number(sql(`SELECT count(*) FROM proc.rfq_invitations WHERE rfq_id='${t.id}'`)[0][0]);
inv === 0 ? ok('db: no invitations created') : bad('db: no invitations created', `${inv}`);

// ── 5. one live sourcing per PR ──────────────────────────────────────────────
console.log('\n== 5. a second tender / RFQ on the same PR is refused ==');
{
  const r1 = await post(`/pr/${prId}/tender`, procTok, { deadlineAt: deadline });
  r1.status === 400 ? ok('second tender refused', '400') : bad('second tender refused', `got ${r1.status}`);
  const r2 = await post(`/pr/${prId}/rfq`, procTok, { deadlineAt: deadline });
  r2.status === 400 ? ok('invited RFQ on top refused', '400') : bad('invited RFQ on top refused', `got ${r2.status}`);
}

// ── 6. existing RFQs keep their meaning ──────────────────────────────────────
console.log('\n== 6. pre-existing RFQs are still invited ==');
{
  const n = Number(sql(
    `SELECT count(*) FROM proc.rfq
      WHERE sourcing_mode = 'invited' AND tender_notes IS NOT NULL`)[0][0]);
  n === 0 ? ok('no invited RFQ carries tender_notes') : bad('no invited RFQ carries tender_notes', `${n}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
