// E2E — sealed tender: no bid price reaches any staff endpoint before the deadline.
//
//   node scripts/e2e_tender_sealed.mjs
//
// Black-box: two vendors bid with distinctive prices (six digits per
// unit, re-drawn every run). Every staff endpoint that can carry sourcing data is then fetched as
// procurement, CS and admin, and the raw response text is searched for those
// numbers. Before the deadline none may appear; after it they must.
//
// Also pinned: the CS cannot be generated while sealed, the bid document
// cannot be downloaded while sealed, invited RFQs are NOT masked, and the
// vendor still sees its own bid.
//
// Setup: vendor1/vendor2@example.com are mapped to IT_HARDWARE in the LOCAL
// database for the run and the mapping is restored on exit.

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const LAPTOP = '55555555-5555-5555-5555-555555555503';
// Distinctive per-run prices, so a tender left OPEN by an earlier run (whose
// prices are then legitimately visible) cannot match this run's search.
const SEED = 10000 + (Date.now() % 80000);
const P1 = 100000 + SEED, P2 = 100000 + SEED + 7;   // per-unit bids, qty 1
const fmtRe = (n) => String(n).replace(/(\d)(?=(\d{3})+$)/g, '$1[,.]?');
const RE1 = new RegExp(fmtRe(P1)), RE2 = new RegExp(fmtRe(P2));
const PRICE_RE = new RegExp(`${fmtRe(P1)}|${fmtRe(P2)}`);

let pass = 0, fail = 0;
const check = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}\n        ${typeof d === 'string' ? d : JSON.stringify(d)}`); } };

function sql(q) {
  const r = spawnSync('docker', ['exec', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
    '-X', '-A', '-F', '\t', '-t', '-c', q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `psql failed (${r.status})`);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t'));
}
async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: r.status, data, text };
}
const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;
const ok2xx = (r) => r.status === 200 || r.status === 201;

// ── setup ────────────────────────────────────────────────────────────────────
const VENDORS = `('vendor1@example.com','vendor2@example.com')`;
const before = sql(
  `SELECT vc.vendor_id, vc.is_active FROM core.vendor_categories vc
     JOIN core.users u ON u.vendor_id = vc.vendor_id JOIN core.categories c ON c.id = vc.category_id
    WHERE u.email IN ${VENDORS} AND c.code = 'IT_HARDWARE'`);
process.on('exit', () => {
  sql(`DELETE FROM core.vendor_categories vc USING core.users u, core.categories c
        WHERE u.vendor_id = vc.vendor_id AND c.id = vc.category_id
          AND u.email IN ${VENDORS} AND c.code = 'IT_HARDWARE'
          ${before.length ? `AND vc.vendor_id NOT IN (${before.map(b => `'${b[0]}'`).join(',')})` : ''}`);
  for (const [vid, active] of before) {
    sql(`UPDATE core.vendor_categories vc SET is_active = ${active === 't'} FROM core.categories c
          WHERE c.id = vc.category_id AND c.code = 'IT_HARDWARE' AND vc.vendor_id = '${vid}'`);
  }
  console.log('  (demo vendor category mapping restored)');
});
sql(`INSERT INTO core.vendor_categories (vendor_id, category_id, is_active)
     SELECT u.vendor_id, c.id, true FROM core.users u, core.categories c
      WHERE u.email IN ${VENDORS} AND c.code = 'IT_HARDWARE'
     ON CONFLICT (vendor_id, category_id) DO UPDATE SET is_active = true`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
const vendor1 = await login('vendor1@example.com');
const vendor2 = await login('vendor2@example.com');

const cc = (await api('/lookups/cost-centers', { token: requester })).data?.[0]?.id;
const created = await api('/pr', { method: 'POST', token: requester, body: {
  scope: 'Sealed tender e2e', expenseType: 'OPEX', costCenterId: cc, requiredByDate: '2026-12-31',
  title: 'Sealed tender e2e', lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 30000 }] } });
const prId = created.data.id;
await api(`/pr/${prId}/advance`, { method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved' }, reason: 'e2e' } });
const posted = await api(`/pr/${prId}/tender`, { method: 'POST', token: procurement,
  body: { deadlineAt: new Date(Date.now() + 2 * 86400e3).toISOString() } });
const rfqId = posted.data?.rfq?.id;
if (!rfqId) { check(false, 'tender posted', posted.data); process.exit(1); }

async function bid(token, price) {
  const j = await api(`/supplier/tenders/${rfqId}/join`, { method: 'POST', token });
  const inv = j.data?.invitationId;
  const form = await api(`/supplier/rfq/${inv}`, { token });
  const r = await api(`/supplier/rfq/${inv}/quote`, { method: 'POST', token, body: {
    lines: [{ lineNo: form.data.lines[0].lineNo, unitPrice: price }], totalAmount: price,
    leadTime: '7 days', warranty: '1 yr', paymentTerms: '30 days' } });
  return { r, inv };
}
console.log('\n== setup ==');
const b1 = await bid(vendor1, P1);
const b2 = await bid(vendor2, P2);
check(ok2xx(b1.r) && ok2xx(b2.r), `two vendors bid ${P1} and ${P2}`);

// Attach a document to vendor1's bid the way procurement's Receive Quotation
// would leave one: register a file and link it to the live quotation.
const q1 = sql(`SELECT id FROM proc.quotations WHERE rfq_id='${rfqId}' AND state='Submitted' ORDER BY submitted_at LIMIT 1`)[0][0];
const anyAtt = sql(`SELECT a.id FROM core.attachment_registry a WHERE a.status <> 'VOID' LIMIT 1`);
let attId = null;
if (anyAtt.length) {
  attId = anyAtt[0][0];
  sql(`INSERT INTO proc.quotation_attachments (quotation_id, attachment_id, kind)
       VALUES ('${q1}', '${attId}', 'VENDOR_QUOTE') ON CONFLICT DO NOTHING`);
}

// ── every staff endpoint ─────────────────────────────────────────────────────
const ENDPOINTS = [
  `/pr/${prId}`, `/pr/${prId}/sourcing`, `/pr/${prId}/quotes`, `/pr/${prId}/history`,
  `/pr/${prId}/attachments`, `/pr/${prId}/cs`, `/rfq`, `/rfq/${rfqId}`,
];
async function scan(token) {
  const leaks = [];
  for (const p of ENDPOINTS) {
    const r = await api(p, { token });
    if (PRICE_RE.test(r.text)) leaks.push(`${p} (${r.status})`);
  }
  return leaks;
}

console.log('\n== 1. before the deadline: sealed ==');
for (const [who, tok] of [['procurement', procurement], ['cs', cs], ['admin', admin]]) {
  const leaks = await scan(tok);
  check(leaks.length === 0, `${who}: no bid price in any endpoint`, leaks.join(', '));
}
const src = await api(`/pr/${prId}/sourcing`, { token: procurement });
check(src.data?.procurement?.rfq?.sealed === true, 'sourcing says sealed');
check((src.data?.procurement?.quotes ?? []).length === 2, 'procurement can still see that 2 bids exist',
  (src.data?.procurement?.quotes ?? []).length);
check((src.data?.procurement?.quotes ?? []).every(q => q.total === null && q.sealed === true), 'each bid shows no total');
const rfqList = await api('/rfq', { token: procurement });
const row = (rfqList.data?.rows ?? rfqList.data?.items ?? rfqList.data ?? []);
const mine = Array.isArray(row) ? row.find(x => x.id === rfqId) : null;
if (mine) check(mine.lowest_bid === null && mine.sealed === true, 'rfq list: no lowest bid while sealed', mine);
const csGen = await api(`/pr/${prId}/cs`, { method: 'POST', token: cs });
check(csGen.status === 400 && /sealed/.test(csGen.data?.message ?? ''), 'CS cannot be generated while sealed', `${csGen.status} ${csGen.data?.message}`);
if (attId) {
  const dl = await api(`/attachments/${attId}/download`, { token: procurement });
  check(dl.status === 403 && /sealed tender/.test(dl.data?.message ?? ''), 'bid document cannot be downloaded while sealed', `${dl.status}`);
}
const vForm = await api(`/supplier/rfq/${b1.inv}`, { token: vendor1 });
check(PRICE_RE.test(JSON.stringify(vForm.data)), 'vendor1 still sees its own bid');
const vOther = JSON.stringify((await api(`/supplier/tenders`, { token: vendor1 })).data);
check(!RE2.test(vOther), "vendor1 never sees vendor2's price");

// ── 2. after the deadline: open ──────────────────────────────────────────────
console.log('\n== 2. after the deadline: open ==');
sql(`UPDATE proc.rfq SET created_at=now()-interval '4 days', issued_at=now()-interval '4 days',
            initial_deadline_at=now()-interval '1 minute', deadline_at=now()-interval '1 minute'
      WHERE id='${rfqId}'`);
const src2 = await api(`/pr/${prId}/sourcing`, { token: procurement });
check(src2.data?.procurement?.rfq?.sealed === false, 'sourcing no longer sealed');
check(PRICE_RE.test(src2.text), 'bid prices now visible on sourcing');
const quotes2 = await api(`/pr/${prId}/quotes`, { token: procurement });
check(RE1.test(quotes2.text) && RE2.test(quotes2.text), 'both prices visible on the quotes view');
if (attId) {
  const dl2 = await api(`/attachments/${attId}/download`, { token: procurement });
  check(dl2.status !== 403, 'bid document downloadable after the deadline', `${dl2.status}`);
}

// ── 3. invited RFQs are not masked ───────────────────────────────────────────
console.log('\n== 3. invited RFQs unaffected ==');
const inv = sql(`SELECT rf.pr_id FROM proc.rfq rf
                  WHERE rf.sourcing_mode='invited' AND rf.state='Open'
                    AND EXISTS (SELECT 1 FROM proc.quotations q WHERE q.rfq_id=rf.id AND q.state='Submitted')
                  LIMIT 1`);
if (inv.length) {
  const s3 = await api(`/pr/${inv[0][0]}/sourcing`, { token: procurement });
  check(s3.data?.procurement?.rfq?.sealed === false && (s3.data?.procurement?.quotes ?? []).some(q => q.total !== null),
    'an invited RFQ still shows its quote totals');
}

if (attId) sql(`DELETE FROM proc.quotation_attachments WHERE quotation_id='${q1}' AND attachment_id='${attId}'`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
