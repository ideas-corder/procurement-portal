// E2E — vendors bid on an OPEN TENDER, against the live API.
//
//   node scripts/e2e_tender_bid.mjs
//
// WHAT THIS PINS (open-tender step 2: the vendor side)
//   1. a posted tender shows in GET /supplier/tenders for a vendor in its category,
//   2. joining creates one invitation, and joining again returns the same one,
//   3. an unknown id or an invited RFQ cannot be joined (404),
//   4. two vendors bid; a vendor can revise its bid before the deadline,
//   5. SEALED: a vendor's inbox and tender list never name the other bidder,
//   6. after the deadline no bid can be submitted or revised, by vendor or procurement,
//      and the tender leaves Open Tenders and shows "Tender closed" in My Bids,
//   7. procurement sees both live bids on the PR (ready for CS).
//
// Setup note: the demo vendors (vendor1/vendor2@example.com) are mapped to the
// IT_HARDWARE category in the LOCAL database, so they are eligible to bid.

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const LAPTOP = '55555555-5555-5555-5555-555555555503'; // IT_HARDWARE item
const PEN = '55555555-5555-5555-5555-555555555505';    // OFFICE_SUPPLIES item

let pass = 0, fail = 0;
const ok = (l, x = '') => { pass++; console.log(`  PASS  ${l}${x ? `  (${x})` : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}\n        ${d}`); };
const check = (cond, label, detail = '') => (cond ? ok(label) : bad(label, detail));

function sql(q) {
  const r = spawnSync('docker', [
    'exec', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
    '-X', '-A', '-F', '\t', '-t', '-c', q,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `psql failed (${r.status})`);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t'));
}

async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let data = null;
  try { data = t ? JSON.parse(t) : null; } catch { data = { raw: t }; }
  return { status: r.status, data };
}
const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

// ── setup ────────────────────────────────────────────────────────────────────
console.log('\n== setup ==');
// Remember the mapping as it was, and put it back on exit. Left in place, it
// pulls the demo vendors (who have no email on file) into the automatic RFQ
// roster of other suites, and their dispatch step fails.
const before = sql(
  `SELECT vc.vendor_id, vc.is_active FROM core.vendor_categories vc
     JOIN core.users u ON u.vendor_id = vc.vendor_id
     JOIN core.categories c ON c.id = vc.category_id
    WHERE u.email IN ('vendor1@example.com','vendor2@example.com') AND c.code = 'IT_HARDWARE'`);
process.on('exit', () => {
  sql(`DELETE FROM core.vendor_categories vc USING core.users u, core.categories c
        WHERE u.vendor_id = vc.vendor_id AND c.id = vc.category_id
          AND u.email IN ('vendor1@example.com','vendor2@example.com') AND c.code = 'IT_HARDWARE'
          ${before.length ? `AND vc.vendor_id NOT IN (${before.map(b => `'${b[0]}'`).join(',')})` : ''}`);
  for (const [vid, active] of before) {
    sql(`UPDATE core.vendor_categories vc SET is_active = ${active === 't'}
           FROM core.categories c
          WHERE c.id = vc.category_id AND c.code = 'IT_HARDWARE' AND vc.vendor_id = '${vid}'`);
  }
  console.log('  (demo vendor category mapping restored)');
});
sql(`INSERT INTO core.vendor_categories (vendor_id, category_id, is_active)
     SELECT u.vendor_id, c.id, true
       FROM core.users u, core.categories c
      WHERE u.email IN ('vendor1@example.com','vendor2@example.com') AND c.code = 'IT_HARDWARE'
     ON CONFLICT (vendor_id, category_id) DO UPDATE SET is_active = true`);
const [[V1, V1NAME], [V2, V2NAME]] = sql(
  `SELECT v.id, v.legal_name FROM core.users u JOIN core.vendors v ON v.id = u.vendor_id
    WHERE u.email IN ('vendor1@example.com','vendor2@example.com') ORDER BY u.email`);
ok('demo vendors mapped to IT_HARDWARE', `${V1NAME}, ${V2NAME}`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const vendor1 = await login('vendor1@example.com');
const vendor2 = await login('vendor2@example.com');

const cc = (await api('/lookups/cost-centers', { token: requester })).data?.[0]?.id;
const created = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Tender bid e2e', expenseType: 'OPEX', costCenterId: cc, requiredByDate: '2026-12-31',
    title: 'Tender bid e2e',
    // Two categories so HOD approval splits the PR; the IT_HARDWARE child lands
    // at procurement review. (A laptop-only PR routes to IT review instead.)
    lines: [
      { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
      { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 },
    ],
  },
});
const parentId = created.data?.id;
await api(`/pr/${parentId}/advance`, {
  method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved', 1: 'approved' }, reason: 'e2e' },
});
const child = sql(
  `SELECT pr.id, pr.pr_number FROM proc.purchase_requisitions pr
    WHERE pr.parent_pr_id = '${parentId}' AND pr.status = 'IN_PROCUREMENT_REVIEW'
      AND EXISTS (SELECT 1 FROM proc.pr_lines pl WHERE pl.pr_id = pr.id AND pl.category = 'IT_HARDWARE')
    LIMIT 1`);
if (!child.length) {
  bad('fixture: IT_HARDWARE child PR reached procurement review', `parent ${parentId}`);
  process.exit(1);
}
const [prId, prNumber] = child[0];
ok('fixture PR at procurement review', prNumber);

const posted = await api(`/pr/${prId}/tender`, {
  method: 'POST', token: procurement,
  body: { deadlineAt: new Date(Date.now() + 3 * 86400e3).toISOString(), notes: 'e2e tender' },
});
const rfqId = posted.data?.rfq?.id;
if (!rfqId) { bad('tender posted', JSON.stringify(posted.data)); process.exit(1); }
ok('tender posted', `${posted.data.rfq.rfq_number}, ${posted.data.eligible_vendor_count} eligible`);
check(posted.data.eligible_vendor_count >= 2, 'eligible count includes both demo vendors',
  `${posted.data.eligible_vendor_count}`);

// ── 1. listed for a vendor in the category ───────────────────────────────────
console.log('\n== 1. GET /supplier/tenders ==');
let list = await api('/supplier/tenders', { token: vendor1 });
check(list.status === 200, 'vendor can list tenders', `${list.status}`);
check(list.data?.openTenders?.some(t => t.rfqId === rfqId), 'tender is in Open Tenders');
const procList = await api('/supplier/tenders', { token: procurement });
check(procList.status === 403, 'staff cannot use the supplier tender list', `${procList.status}`);

// ── 2. join is idempotent ────────────────────────────────────────────────────
console.log('\n== 2. POST /supplier/tenders/:rfqId/join ==');
const j1 = await api(`/supplier/tenders/${rfqId}/join`, { method: 'POST', token: vendor1 });
const inv1 = j1.data?.invitationId;
check(!!inv1 && j1.data.alreadyJoined === false, 'vendor1 joined', JSON.stringify(j1.data));
const j1b = await api(`/supplier/tenders/${rfqId}/join`, { method: 'POST', token: vendor1 });
check(j1b.data?.invitationId === inv1 && j1b.data.alreadyJoined === true, 'second join returns the same invitation');
const nInv = Number(sql(`SELECT count(*) FROM proc.rfq_invitations WHERE rfq_id='${rfqId}' AND vendor_id='${V1}'`)[0][0]);
check(nInv === 1, 'exactly one invitation row for vendor1', `${nInv}`);
list = await api('/supplier/tenders', { token: vendor1 });
check(!list.data.openTenders.some(t => t.rfqId === rfqId), 'joined tender moves out of Open Tenders');
check(list.data.myBids.some(b => b.rfqId === rfqId && b.status === 'Not submitted'), 'and into My Bids as Not submitted');

// ── 3. cannot join what is not an open tender ────────────────────────────────
console.log('\n== 3. join refusals ==');
const fake = await api('/supplier/tenders/00000000-0000-0000-0000-000000000000/join', { method: 'POST', token: vendor1 });
check(fake.status === 404, 'unknown id -> 404', `${fake.status}`);
const invited = sql(`SELECT id FROM proc.rfq WHERE sourcing_mode='invited' LIMIT 1`);
if (invited.length) {
  const r = await api(`/supplier/tenders/${invited[0][0]}/join`, { method: 'POST', token: vendor1 });
  check(r.status === 404, 'invited RFQ cannot be joined as a tender -> 404', `${r.status}`);
}
const badId = await api('/supplier/tenders/not-a-uuid/join', { method: 'POST', token: vendor1 });
check(badId.status === 400, 'malformed id -> 400', `${badId.status}`);

// ── 4. bids ──────────────────────────────────────────────────────────────────
console.log('\n== 4. bids ==');
const form = await api(`/supplier/rfq/${inv1}`, { token: vendor1 });
check(form.data?.invitation?.sourcingMode === 'open_tender', 'quote form says open_tender');
check(form.data?.invitation?.tenderNotes === 'e2e tender', 'quote form carries the tender notes');
const lineNo = form.data.lines[0].lineNo;
const qty = form.data.lines[0].qty;
const bid = (price) => ({
  lines: [{ lineNo, unitPrice: price }], totalAmount: price * qty,
  leadTime: '7 days', warranty: '1 yr', paymentTerms: '30 days',
});
const b1 = await api(`/supplier/rfq/${inv1}/quote`, { method: 'POST', token: vendor1, body: bid(44000) });
check([200, 201].includes(b1.status), 'vendor1 bid submitted', `${b1.status} ${JSON.stringify(b1.data).slice(0, 200)}`);

const j2 = await api(`/supplier/tenders/${rfqId}/join`, { method: 'POST', token: vendor2 });
const inv2 = j2.data?.invitationId;
const b2 = await api(`/supplier/rfq/${inv2}/quote`, { method: 'POST', token: vendor2, body: bid(42000) });
check([200, 201].includes(b2.status), 'vendor2 bid submitted', `${b2.status} ${JSON.stringify(b2.data).slice(0, 200)}`);

const b1v2 = await api(`/supplier/rfq/${inv1}/quote`, { method: 'POST', token: vendor1, body: bid(41500) });
check([200, 201].includes(b1v2.status), 'vendor1 revised its bid before the deadline', `${b1v2.status}`);
const live1 = sql(`SELECT version FROM proc.quotations WHERE rfq_id='${rfqId}' AND vendor_id='${V1}' AND state='Submitted'`);
check(live1.length === 1 && live1[0][0] === '2', 'vendor1 has one live bid, version 2', JSON.stringify(live1));

// ── 5. sealed ────────────────────────────────────────────────────────────────
console.log('\n== 5. sealed bids ==');
const inbox1 = await api('/supplier/inbox', { token: vendor1 });
const row = inbox1.data?.invitations?.find(i => i.rfqId === rfqId);
check(!!row, 'tender shows in vendor1 inbox');
check(row && row.roster.length === 1 && row.roster[0].vendorId === V1, 'roster shows only vendor1 itself',
  JSON.stringify(row?.roster));
// Only the tender is sealed: an invited RFQ both vendors share elsewhere may
// legitimately name vendor2, so look at this tender's row, list entry and form.
const myBid = list.data.myBids.find(b => b.rfqId === rfqId);
const blob = JSON.stringify(row) + JSON.stringify(myBid) + JSON.stringify(form.data);
check(!blob.includes(V2NAME) && !blob.includes(V2), 'vendor2 is never named to vendor1 on the tender');
const other = await api(`/supplier/rfq/${inv2}`, { token: vendor1 });
check(other.status === 404, "vendor1 cannot open vendor2's bid -> 404", `${other.status}`);

// ── 6. deadline ──────────────────────────────────────────────────────────────
console.log('\n== 6. after the deadline ==');
// Move the clock instead of waiting: shift the whole tender into the past so
// rfq_check (deadline >= created + 24h) still holds.
sql(`UPDATE proc.rfq
        SET created_at = now() - interval '4 days',
            issued_at  = now() - interval '4 days',
            initial_deadline_at = now() - interval '1 minute',
            deadline_at = now() - interval '1 minute'
      WHERE id = '${rfqId}'`);
const late = await api(`/supplier/rfq/${inv1}/quote`, { method: 'POST', token: vendor1, body: bid(30000) });
check(late.status === 400 && /closed/i.test(late.data?.message ?? ''), 'late bid refused', `${late.status} ${late.data?.message}`);
const lateForm = await api(`/supplier/rfq/${inv1}`, { token: vendor1 });
check(lateForm.data?.canSubmit === false, 'quote form reports canSubmit=false');
list = await api('/supplier/tenders', { token: vendor1 });
check(!list.data.openTenders.some(t => t.rfqId === rfqId), 'closed tender not in Open Tenders');
const mb = list.data.myBids.find(b => b.rfqId === rfqId);
check(mb?.status === 'Tender closed' && mb.canBid === false && mb.myBid?.version === 2,
  'My Bids: Tender closed, my bid v2 kept', JSON.stringify(mb));
const quotes = await api(`/pr/${prId}/quotes`, { token: procurement });
const procLate = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: { vendorId: V1, quoteMode: 'per_line', lines: [{ rfqLineNo: lineNo, unitPrice: 1 }] },
});
check(procLate.status === 400 && /closed/i.test(procLate.data?.message ?? ''), 'procurement cannot record a bid after the deadline either',
  `${procLate.status} ${procLate.data?.message}`);

// ── 7. procurement sees both bids ────────────────────────────────────────────
console.log('\n== 7. bids ready for CS ==');
const liveAll = sql(`SELECT count(*) FROM proc.quotations WHERE rfq_id='${rfqId}' AND state='Submitted'`)[0][0];
check(liveAll === '2', 'two live bids on the tender', liveAll);
check(quotes.status === 200, 'procurement quotes view loads', `${quotes.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
