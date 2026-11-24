// E2E — the tender portal API: tender requests, published terms and documents,
// public listing, bid documents, one final bid, and the split-child HOD fix.
//
//   node scripts/e2e_tender_portal.mjs
//
// Each run creates two real suppliers (vendors cannot be deleted by design).

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const LAPTOP = '55555555-5555-5555-5555-555555555503';
const PEN = '55555555-5555-5555-5555-555555555505';

let pass = 0, fail = 0;
const check = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}\n        ${typeof d === 'string' ? d : JSON.stringify(d).slice(0, 400)}`); } };
const step = (t) => console.log(`\n== ${t} ==`);
function sql(q) {
  const r = spawnSync('docker', ['exec', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
    '-X', '-A', '-F', '\t', '-t', '-c', q], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `psql failed (${r.status})`);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t'));
}
async function api(path, { method = 'GET', token, body, raw, headers = {} } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const t = await r.text();
  let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = { raw: t }; }
  return { status: r.status, data, text: t, headers: r.headers };
}
const ok2xx = (r) => r.status === 200 || r.status === 201;
const login = async (email, password = 'demo') => (await api('/auth/login', { method: 'POST', body: { email, password } })).data?.token;
const stageOf = (id) => sql(`SELECT status FROM proc.purchase_requisitions WHERE id='${id}'`)[0][0];
const upload = (path, token, name, text) => api(path, { method: 'POST', token, raw: Buffer.from(text), headers: { 'x-file-name': name, 'content-type': 'application/pdf' } });

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const run = Date.now() % 1e7;

// suppliers
async function newSupplier(tag) {
  const email = `${tag.toLowerCase()}${run}@example.test`;
  const sub = await api('/onboarding/applications', { method: 'POST', body: {
    legalName: `${tag} Tech ${run}`, ntn: `${run}-${tag.charCodeAt(0)}${tag.length}`, contactName: tag, contactEmail: email, categories: 'IT_HARDWARE' } });
  const app = (await api('/vendors/applications', { token: procurement })).data.applications.find(a => a.reference === sub.data.reference);
  const ap = await api(`/vendors/applications/${app.id}/approve`, { method: 'POST', token: procurement, body: {} });
  const pw = `${tag}Pw${run}`;
  await api('/auth/set-password', { method: 'POST', body: { token: ap.data.passwordLink.url.split('/').pop(), password: pw } });
  return { tag, id: ap.data.vendor.id, name: `${tag} Tech ${run}`, token: await login(email, pw) };
}
const V1 = await newSupplier('Omar');
const V2 = await newSupplier('Sana');

// ── 1. tender request ────────────────────────────────────────────────────────
step('1. requester raises a tender request, HOD sees it apart');
const cc = (await api('/lookups/cost-centers', { token: requester })).data?.[0]?.id;
const pr = await api('/pr', { method: 'POST', token: requester, body: {
  sourcingPreference: 'tender', scope: 'Tender request e2e', expenseType: 'OPEX', costCenterId: cc,
  requiredByDate: '2026-12-31', title: `Laptops tender request ${run}`,
  lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 30000 }] } });
const prId = pr.data?.id;
check(ok2xx(pr) && sql(`SELECT sourcing_preference FROM proc.purchase_requisitions WHERE id='${prId}'`)[0][0] === 'tender', 'tender request stored as sourcing_preference=tender');
const mine = (await api('/tenders/requests', { token: requester })).data?.requests ?? [];
check(mine.some(r => r.prId === prId && r.mine), 'requester sees it in My tender requests');
const hodList = (await api('/tenders/requests', { token: hod })).data?.requests ?? [];
const forHod = hodList.find(r => r.prId === prId);
check(forHod && forHod.awaitingMe === true, 'HOD sees it on the Tender Requests page, awaiting them', forHod);
const plain = await api('/pr', { method: 'POST', token: requester, body: {
  scope: 'plain', expenseType: 'OPEX', costCenterId: cc, requiredByDate: '2026-12-31', title: `Plain PR ${run}`,
  lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 30000 }] } });
check(!((await api('/tenders/requests', { token: hod })).data.requests.some(r => r.prId === plain.data.id)), 'an ordinary PR does not appear among tender requests');
await api(`/pr/${prId}/advance`, { method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved' }, reason: 'ok' } });
check(stageOf(prId) === 'IN_PROCUREMENT_REVIEW', 'HOD approval routes it as usual');
const ov = (await api('/tenders/overview', { token: procurement })).data;
check(ov.readyToPublish.some(r => r.prId === prId), 'procurement sees it under Ready to publish');
check((await api('/tenders/overview', { token: requester })).status === 403, 'requester cannot open tender management');

// ── 2. publish with terms and documents ──────────────────────────────────────
step('2. publish: budget, deposit, documents');
const bad = await api(`/pr/${prId}/tender`, { method: 'POST', token: procurement, body: {
  deadlineAt: new Date(Date.now() + 3 * 86400e3).toISOString(), budgetMin: 50000, budgetMax: 40000 } });
check(bad.status === 400, 'min budget above max is refused', `${bad.status}`);
const posted = await api(`/pr/${prId}/tender`, { method: 'POST', token: procurement, body: {
  deadlineAt: new Date(Date.now() + 3 * 86400e3).toISOString(), title: `Laptop supply ${run}`,
  notes: 'Dell Latitude or equivalent.', budgetMin: 25000, budgetMax: 32000, securityDeposit: 2000 } });
const rfqId = posted.data?.rfq?.id;
check(ok2xx(posted) && posted.data.rfq.budget_min === 25000 && posted.data.rfq.security_deposit === 2000, 'tender posted with budget 25k-32k and deposit 2k', posted.data?.rfq);
check(!ov.tenders.some(t => t.id === rfqId) && !(await api('/tenders/overview', { token: procurement })).data.readyToPublish.some(r => r.prId === prId), 'it leaves Ready to publish once posted');
const doc = await upload(`/tenders/${rfqId}/documents`, procurement, 'specs.pdf', '%PDF-1.4 tender specs ' + run);
check(ok2xx(doc) && doc.data?.id, 'procurement publishes a tender document', `${doc.status} ${JSON.stringify(doc.data)}`);
const doc2 = await upload(`/tenders/${rfqId}/documents`, procurement, 'old.pdf', '%PDF old');
check(ok2xx(await api(`/tenders/${rfqId}/documents/${doc2.data.id}`, { method: 'DELETE', token: procurement })), 'a document can be removed while the tender is open');

// ── 3. public ────────────────────────────────────────────────────────────────
step('3. public pages (no login)');
const pub = await api('/public/tenders');
const pt = pub.data?.tenders?.find(t => t.id === rfqId);
check(pub.status === 200 && pt, 'tender listed publicly without login');
check(pt?.budgetMin === 25000 && pt?.budgetMax === 32000 && pt?.securityDeposit === 2000, 'budget and deposit are public');
check(pt?.documents?.length === 1 && pt.documents[0].name === 'specs.pdf', 'only the published document is listed');
check(pt?.categories?.includes('IT_HARDWARE') && pt?.lines?.length === 1, 'category and lines are public');
check(!JSON.stringify(pt).includes('bids') && !('prId' in pt), 'no bid or internal data on the public tender');
const dl = await api(`/public/tenders/${rfqId}/documents/${doc.data.id}`);
check(dl.status === 200 && dl.text.includes('tender specs'), 'published document downloads without login');
check((await api(`/public/tenders/${rfqId}/documents/${doc2.data.id}`)).status === 404, 'a removed document is not downloadable');

// ── 4. bids: document, one final bid ─────────────────────────────────────────
step('4. suppliers bid with a document; one bid, final');
const d1 = await api(`/supplier/tenders/${rfqId}`, { token: V1.token });
check(d1.status === 200 && d1.data.canBid === true && d1.data.myBid === null, 'supplier sees the tender and can bid');
const earlyUp = await upload(`/supplier/tenders/${rfqId}/documents`, V1.token, 'quote.pdf', 'x');
check(earlyUp.status === 400, 'cannot upload a bid document before opening the tender', `${earlyUp.status}`);
async function bid(V, price, withDoc) {
  const j = await api(`/supplier/tenders/${rfqId}/join`, { method: 'POST', token: V.token });
  const inv = j.data.invitationId;
  let attachmentId;
  if (withDoc) {
    const u = await upload(`/supplier/tenders/${rfqId}/documents`, V.token, 'quote.pdf', `${V.tag} quote ${price}`);
    check(ok2xx(u) && u.data?.id, `${V.tag}: bid document uploaded (same file name as the other supplier)`, `${u.status} ${JSON.stringify(u.data)}`);
    attachmentId = u.data?.id;
  }
  const form = await api(`/supplier/rfq/${inv}`, { token: V.token });
  const body = { lines: [{ lineNo: form.data.lines[0].lineNo, unitPrice: price }], totalAmount: price,
                 leadTime: '7 days', warranty: '1 yr', paymentTerms: '30 days', ...(attachmentId ? { attachmentId } : {}) };
  return { r: await api(`/supplier/rfq/${inv}/quote`, { method: 'POST', token: V.token, body }), inv, attachmentId, body };
}
const b1 = await bid(V1, 29000, true);
check(ok2xx(b1.r) && b1.attachmentId, 'supplier 1 bids with its document', `${b1.r.status} ${b1.r.data?.message ?? ''}`);
const again = await api(`/supplier/rfq/${b1.inv}/quote`, { method: 'POST', token: V1.token, body: { ...b1.body, lines: [{ ...b1.body.lines[0], unitPrice: 20000 }], totalAmount: 20000 } });
check(again.status === 409 && /final/.test(again.data?.message ?? ''), 'a second bid from the same supplier is refused: bids are final', `${again.status} ${again.data?.message}`);
const j2 = await api(`/supplier/tenders/${rfqId}/join`, { method: 'POST', token: V2.token });
const f2 = await api(`/supplier/rfq/${j2.data.invitationId}`, { token: V2.token });
const steal = await api(`/supplier/rfq/${j2.data.invitationId}/quote`, { method: 'POST', token: V2.token, body: {
  lines: [{ lineNo: f2.data.lines[0].lineNo, unitPrice: 28000 }], totalAmount: 28000, attachmentId: b1.attachmentId } });
check(steal.status === 400, "a supplier cannot attach another supplier's document", `${steal.status} ${steal.data?.message}`);
const b2 = await bid(V2, 27500, true);
check(ok2xx(b2.r), 'supplier 2 bids with its own document');
const after = (await api(`/supplier/tenders/${rfqId}`, { token: V1.token })).data;
check(after.canBid === false && after.myBid?.total === 29000 && after.myBid?.documents?.length === 1, 'supplier sees its own final bid and document', after.myBid);
check(!JSON.stringify(after).includes(V2.name), "supplier never sees the other bidder");

// ── 5. procurement view ──────────────────────────────────────────────────────
step('5. procurement tender view: sealed, then open');
let det = (await api(`/tenders/${rfqId}`, { token: procurement })).data;
check(det.tender.sealed === true && det.bids.length === 2 && det.bids.every(b => b.total === null && b.attachments.length === 0),
  'sealed: both bidders listed, no prices, no documents', det.bids);
const listed = (await api('/tenders/overview', { token: procurement })).data.tenders.find(t => t.id === rfqId);
check(listed?.bids === 2 && listed?.lowestBid === null && listed?.status === 'Open', 'overview: 2 bids, no lowest bid while open', listed);
sql(`UPDATE proc.rfq SET created_at=now()-interval '4 days', issued_at=now()-interval '4 days',
            initial_deadline_at=now()-interval '1 minute', deadline_at=now()-interval '1 minute' WHERE id='${rfqId}'`);
det = (await api(`/tenders/${rfqId}`, { token: procurement })).data;
check(det.tender.sealed === false && det.bids.some(b => b.total === 27500) && det.bids.every(b => b.attachments.length === 1),
  'after the deadline: prices and bid documents open', det.bids);
const late = await upload(`/tenders/${rfqId}/documents`, procurement, 'late.pdf', 'x');
check(late.status === 409, 'no new tender documents after the deadline', `${late.status}`);
const closedPub = (await api('/public/tenders?status=closed')).data.tenders.find(t => t.id === rfqId);
check(closedPub?.status === 'Closed', 'public page lists it as Closed');

// ── 6. split fix ─────────────────────────────────────────────────────────────
step('6. split child PRs keep their department approver');
const sp = await api('/pr', { method: 'POST', token: requester, body: {
  scope: 'split', expenseType: 'OPEX', costCenterId: cc, requiredByDate: '2026-12-31', title: `Split check ${run}`,
  lines: [{ itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 }, { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 }] } });
await api(`/pr/${sp.data.id}/advance`, { method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved', 1: 'approved' }, reason: 'ok' } });
const kids = sql(`SELECT c.id, (SELECT count(*) FROM proc.pr_departments d WHERE d.pr_id=c.id) FROM proc.purchase_requisitions c WHERE c.parent_pr_id='${sp.data.id}'`);
check(kids.length >= 2 && kids.every(k => Number(k[1]) >= 1), 'every split child has a department approver row', kids);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
