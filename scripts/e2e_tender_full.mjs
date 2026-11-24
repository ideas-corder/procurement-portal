// E2E — the whole open-tender story, start to finish, against the live stack.
//
//   node scripts/e2e_tender_full.mjs
//
// Nothing is seeded by hand except the clock (a tender's deadline is moved into
// the past instead of waiting days). Everyone else acts through the API:
//
//   1. two NEW companies apply on the public onboarding form,
//   2. procurement approves both -> vendor + category + supplier login + link,
//   3. each supplier sets its own password from the one-time link and signs in,
//   4. a requester raises a PR, the HOD approves it,
//   5. procurement posts an open tender; bids stay sealed,
//   6. both new suppliers see it, bid, and one revises before the deadline,
//   7. the deadline passes, the API timer closes the tender, procurement is notified,
//   8. then one of two routes to D365 (both exist in this codebase):
//
//      ROUTE A — the routing table's flow (migration 075):
//        Ready for CS -> CS -> review -> award -> HOD confirms -> finance review
//        -> finance release -> READY_FOR_D365 -> procurement "D365 push" step
//        -> D365_PUSHED. (This step changes the stage only: it creates no
//        purchase order and calls no D365 client — a pre-existing gap.)
//
//      ROUTE B — the purchase-order flow:
//        CS built at procurement review -> CS lock (FAST_TRACK below the
//        threshold: pack auto-locked) -> PO generated -> PO issued -> PO pushed
//        to D365 (stub) -> a PO number. NOT via Ready for CS: a FAST_TRACK lock
//        at QUOTES_RECEIVED fails on the transition QUOTES_RECEIVED ->
//        PACK_LOCKED (a pre-existing gap, see PROGRESS.md), so this follows the
//        same path as e2e_cs.mjs / e2e_d365.mjs.
//
//   9. the winning supplier sees "Won", the other "Not selected".
//
// Each run creates two real vendors (vendors cannot be deleted by design).

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const LAPTOP = '55555555-5555-5555-5555-555555555503';

let pass = 0, fail = 0;
const check = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}\n        ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 400)}`); } };
const step = (t) => console.log(`\n== ${t} ==`);

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
  const t = await r.text();
  let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = { raw: t }; }
  return { status: r.status, data };
}
const ok2xx = (r) => r.status === 200 || r.status === 201;
const login = async (email, password = 'demo') =>
  (await api('/auth/login', { method: 'POST', body: { email, password } })).data?.token;
const stageOf = (id) => sql(`SELECT status FROM proc.purchase_requisitions WHERE id='${id}'`)[0][0];
const die = (msg) => { console.log(`\nSTOP: ${msg}\n\n${pass} passed, ${fail + 1} failed`); process.exit(1); };

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const hodProcurement = await login('hod.procurement@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const finance = await login('finance@pakboxes.pk');
const run = Date.now() % 1e7;

// ── 1-3. two new suppliers, end to end ───────────────────────────────────────
step('1-3. two new companies register, get approved, set passwords');
async function newSupplier(tag) {
  const email = `${tag.toLowerCase()}${run}@example.test`;
  const name = `${tag} Computers ${run}`;
  const sub = await api('/onboarding/applications', { method: 'POST', body: {
    legalName: name, ntn: `${run}-${tag.charCodeAt(0)}`, contactName: `${tag} Owner`, contactEmail: email, categories: 'IT_HARDWARE' } });
  if (!ok2xx(sub)) die(`application for ${tag} failed: ${JSON.stringify(sub.data)}`);
  const app = (await api('/vendors/applications', { token: procurement })).data.applications.find(a => a.reference === sub.data.reference);
  const ap = await api(`/vendors/applications/${app.id}/approve`, { method: 'POST', token: procurement, body: { note: 'e2e full' } });
  if (!ok2xx(ap)) die(`approve ${tag} failed: ${JSON.stringify(ap.data)}`);
  const token = ap.data.passwordLink.url.split('/').pop();
  const pw = `${tag}Pass${run}`;
  const set = await api('/auth/set-password', { method: 'POST', body: { token, password: pw } });
  if (!ok2xx(set)) die(`set password ${tag} failed: ${JSON.stringify(set.data)}`);
  const t = await login(email, pw);
  if (!t) die(`${tag} could not sign in`);
  return { tag, email, name, id: ap.data.vendor.id, code: ap.data.vendor.vendorCode, token: t };
}
const S1 = await newSupplier('Faisal');
const S2 = await newSupplier('Hina');
check(true, `two suppliers live: ${S1.code} ${S1.name}, ${S2.code} ${S2.name}`);

// ── 4-7. one tender, run to the closed state ─────────────────────────────────
async function tenderToClosed(label, p1, p2, { readyForCs = true } = {}) {
  step(`${label}: PR, HOD, tender, sealed bids, deadline`);
  const cc = (await api('/lookups/cost-centers', { token: requester })).data?.[0]?.id;
  const pr = await api('/pr', { method: 'POST', token: requester, body: {
    scope: `Tender full e2e ${label}`, expenseType: 'OPEX', costCenterId: cc, requiredByDate: '2026-12-31',
    title: `Tender full e2e ${label} ${run}`, lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 30000 }] } });
  const prId = pr.data?.id;
  const hodA = await api(`/pr/${prId}/advance`, { method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved' }, reason: 'approved' } });
  check(ok2xx(hodA) && stageOf(prId) === 'IN_PROCUREMENT_REVIEW', `${label}: HOD approved, at procurement review`, stageOf(prId));

  const posted = await api(`/pr/${prId}/tender`, { method: 'POST', token: procurement, body: {
    deadlineAt: new Date(Date.now() + 3 * 86400e3).toISOString(), title: `Laptop tender ${label}`, notes: 'Dell Latitude or equivalent. Deliver to Karachi.' } });
  const rfqId = posted.data?.rfq?.id;
  const rfqNumber = posted.data?.rfq?.rfq_number;
  if (!rfqId) die(`${label}: tender not posted: ${JSON.stringify(posted.data)}`);
  check(posted.data.eligible_vendor_count >= 2, `${label}: tender ${rfqNumber} posted, both new suppliers eligible`, posted.data.eligible_vendor_count);

  for (const S of [S1, S2]) {
    const list = await api('/supplier/tenders', { token: S.token });
    check(list.data?.openTenders?.some(t => t.rfqId === rfqId), `${label}: ${S.tag} sees the tender`);
  }
  async function bid(S, price) {
    const j = await api(`/supplier/tenders/${rfqId}/join`, { method: 'POST', token: S.token });
    const form = await api(`/supplier/rfq/${j.data.invitationId}`, { token: S.token });
    return api(`/supplier/rfq/${j.data.invitationId}/quote`, { method: 'POST', token: S.token, body: {
      lines: [{ lineNo: form.data.lines[0].lineNo, unitPrice: price }], totalAmount: price,
      leadTime: '7 days', warranty: '1 yr', paymentTerms: '30 days' } });
  }
  check(ok2xx(await bid(S1, p1)), `${label}: ${S1.tag} bids ${p1}`);
  check(ok2xx(await bid(S2, p2 + 1500)), `${label}: ${S2.tag} bids ${p2 + 1500}`);
  check(ok2xx(await bid(S2, p2)), `${label}: ${S2.tag} revises to ${p2} before the deadline`);

  const sealed = await api(`/pr/${prId}/sourcing`, { token: procurement });
  check(sealed.data?.procurement?.rfq?.sealed === true && sealed.data.procurement.quotes.every(q => q.total === null),
    `${label}: procurement sees 2 bids but no prices while sealed`);

  sql(`UPDATE proc.rfq SET created_at=now()-interval '4 days', issued_at=now()-interval '4 days',
              initial_deadline_at=now()-interval '1 minute', deadline_at=now()-interval '1 minute' WHERE id='${rfqId}'`);
  let state = '';
  for (let i = 0; i < 25 && state !== 'Closed'; i++) {
    state = sql(`SELECT state FROM proc.rfq WHERE id='${rfqId}'`)[0][0];
    if (state !== 'Closed') await new Promise(r => setTimeout(r, 3000));
  }
  check(state === 'Closed', `${label}: the API timer closed the tender at the deadline`, state);
  const note = sql(`SELECT count(*) FROM core.notifications n JOIN core.users u ON u.id=n.user_id
                     WHERE u.email='procurement@pakboxes.pk' AND n.entity_id='${rfqId}' AND n.kind='TENDER_CLOSED'`)[0][0];
  check(note === '1', `${label}: procurement notified`);
  const open = await api(`/pr/${prId}/quotes`, { token: procurement });
  check(JSON.stringify(open.data).includes(String(p2)), `${label}: bids open after the deadline`);

  if (readyForCs) {
    const ready = await api(`/pr/${prId}/ready-for-cs`, { method: 'POST', token: procurement, body: { remarks: 'tender closed' } });
    check(ok2xx(ready) && stageOf(prId) === 'QUOTES_RECEIVED', `${label}: Ready for CS -> QUOTES_RECEIVED`, `${ready.status} ${stageOf(prId)}`);
  }
  const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: cs });
  const csId = gen.data?.cs?.id;
  const top = (gen.data?.lines ?? []).find(l => l.rank === 1);
  check(Boolean(csId) && top?.vendor_id === S2.id, `${label}: CS generated, ${S2.tag} (cheapest) ranks 1`, gen.data?.message ?? top);
  return { prId, rfqId, rfqNumber, csId };
}

// ── ROUTE A ──────────────────────────────────────────────────────────────────
const A = await tenderToClosed('Route A', 29000, 27000);
step('Route A: review, award, finance, D365 step');
check(ok2xx(await api(`/cs/${A.csId}/review/submit`, { method: 'POST', token: cs })), 'A: CS submitted for review');
check(ok2xx(await api(`/cs/${A.csId}/review/send-to-requester`, { method: 'POST', token: hodProcurement })), 'A: HOD Procurement sends it on');
const rl = Number(sql(`SELECT min(line_no) FROM proc.rfq_lines WHERE rfq_id='${A.rfqId}'`)[0][0]);
check(ok2xx(await api(`/cs/${A.csId}/award`, { method: 'POST', token: procurement,
  body: { lineNo: rl, vendorId: S2.id, qty: 1, justification: 'Lowest evaluated tender bid' } })), 'A: line awarded to the winner');
check(ok2xx(await api(`/pr/${A.prId}/lines/classification`, { method: 'PATCH', token: procurement,
  body: { lines: [{ lineNo: 1, classification: 'OPEX_CONSUMABLE' }] } })), 'A: line classified');
check(ok2xx(await api(`/cs/${A.csId}/review/confirm`, { method: 'POST', token: hod })), 'A: HOD confirms the CS');
const exitA = await api(`/pr/${A.prId}/advance`, { method: 'POST', token: procurement, body: { reason: 'CS confirmed', csReviewConfirmed: true } });
check(ok2xx(exitA) && stageOf(A.prId) === 'IN_FINANCE_REVIEW', 'A: on to finance review', `${exitA.status} ${exitA.data?.message ?? ''} ${stageOf(A.prId)}`);
const fin = await api(`/pr/${A.prId}/advance`, { method: 'POST', token: finance, body: { reason: 'budget ok' } });
check(ok2xx(fin) && stageOf(A.prId) === 'READY_FOR_D365', 'A: finance releases (below the management threshold) -> READY_FOR_D365', `${fin.status} ${stageOf(A.prId)}`);
const push = await api(`/pr/${A.prId}/advance`, { method: 'POST', token: procurement, body: { reason: 'push to D365' } });
check(ok2xx(push) && push.data?.matchedStep === 'd365_push' && stageOf(A.prId) === 'D365_PUSHED', 'A: procurement runs the D365 push step -> D365_PUSHED',
  `${push.status} ${push.data?.matchedStep} ${stageOf(A.prId)}`);
const poA = sql(`SELECT count(*) FROM proc.purchase_orders WHERE pr_id='${A.prId}'`)[0][0];
console.log(`        note: route A created ${poA} purchase order(s) — the stage step does not generate one (pre-existing gap)`);

// ── ROUTE B ──────────────────────────────────────────────────────────────────
const B = await tenderToClosed('Route B', 31000, 28500, { readyForCs: false });
step('Route B: CS lock, purchase order, D365 push');
const lock = await api(`/cs/${B.csId}/lock`, { method: 'POST', token: cs, body: { winnerVendorId: S2.id, reason: 'Lowest evaluated tender bid' } });
check(ok2xx(lock), 'B: CS locked with the winning bidder', `${lock.status} ${lock.data?.message ?? ''}`);
check(stageOf(B.prId) === 'PACK_LOCKED', 'B: below the threshold the pack auto-locks (FAST_TRACK)', `${lock.data?.routing_key} ${stageOf(B.prId)}`);
const gen = await api(`/pr/${B.prId}/po`, { method: 'POST', token: procurement, body: { mode: 'AUTO' } });
const po = (gen.data?.purchase_orders ?? gen.data?.orders ?? gen.data?.pos ?? [])[0] ?? gen.data?.po ?? null;
const poId = po?.id ?? sql(`SELECT id FROM proc.purchase_orders WHERE pr_id='${B.prId}' ORDER BY created_at DESC LIMIT 1`)[0]?.[0];
check(ok2xx(gen) && Boolean(poId), 'B: purchase order generated', `${gen.status} ${gen.data?.message ?? ''}`);
if (!poId) die('no purchase order to continue with');
const poVendor = sql(`SELECT vendor_id FROM proc.purchase_orders WHERE id='${poId}'`)[0]?.[0];
check(poVendor === S2.id, 'B: the PO is for the winning supplier');
const issue = await api(`/po/${poId}/issue`, { method: 'POST', token: procurement });
check(ok2xx(issue), 'B: PO issued', `${issue.status} ${issue.data?.message ?? ''}`);
const pushB = await api(`/po/${poId}/push`, { method: 'POST', token: procurement });
check(ok2xx(pushB), 'B: PO pushed to D365', `${pushB.status} ${pushB.data?.message ?? ''}`);
const poRow = sql(`SELECT coalesce(d365_po_number, po_number, '-'), state FROM proc.purchase_orders WHERE id='${poId}'`)[0];
check(poRow && poRow[0] !== '-', `B: PO number ${poRow?.[0]} (state ${poRow?.[1]})`, poRow);

// ── 9. the suppliers learn the outcome ───────────────────────────────────────
step('9. outcome in My Bids');
for (const [label, X] of [['Route A', A], ['Route B', B]]) {
  const st = async (S) => (await api('/supplier/tenders', { token: S.token })).data?.myBids?.find(b => b.rfqId === X.rfqId)?.status;
  check(await st(S2) === 'Won', `${label}: ${S2.tag} sees Won`, await st(S2));
  check(await st(S1) === 'Not selected', `${label}: ${S1.tag} sees Not selected`, await st(S1));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
