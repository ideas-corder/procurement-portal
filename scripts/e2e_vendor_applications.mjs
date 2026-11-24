// E2E — vendor applications: approve creates a working supplier, reject does not.
//
//   node scripts/e2e_vendor_applications.mjs
//
// Walk: a company applies through the public onboarding form -> procurement
// approves -> a vendor (Approved, new V-code), its line category and a supplier
// login exist -> that supplier can sign in and sees the open tenders in its
// category. Plus: reject needs a reason and creates nothing; a decided
// application cannot be decided again; only procurement / CS may decide; an
// email that already has a login is refused before anything is written.
//
// Each run creates one new vendor (vendors cannot be deleted by design).

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

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
  const t = await r.text();
  let data = null; try { data = t ? JSON.parse(t) : null; } catch { data = { raw: t }; }
  return { status: r.status, data };
}
const login = async (email, password = 'demo') =>
  (await api('/auth/login', { method: 'POST', body: { email, password } })).data?.token;
const ok2xx = (r) => r.status === 200 || r.status === 201;

const procurement = await login('procurement@pakboxes.pk');
const requester = await login('requester@pakboxes.pk');
const run = Date.now() % 1e7;

async function apply(tag, extra = {}) {
  const r = await api('/onboarding/applications', { method: 'POST', body: {
    legalName: `${tag} Traders ${run}`, ntn: `${run}-${tag.length}${tag.charCodeAt(0)}`,
    contactName: `${tag} Khan`, contactEmail: `${tag.toLowerCase()}${run}@example.test`,
    categories: 'IT_HARDWARE', ...extra } });
  const list = await api('/vendors/applications', { token: procurement });
  return { submit: r, app: list.data?.applications?.find(a => a.reference === r.data?.reference) };
}

// ── 1. approve ───────────────────────────────────────────────────────────────
console.log('\n== 1. approve ==');
const A = await apply('Ali');
check(A.submit.status === 201 && A.app?.state === 'Submitted', 'application submitted and queued', A.submit.data);
const asReq = await api(`/vendors/applications/${A.app.id}/approve`, { method: 'POST', token: requester, body: {} });
check(asReq.status === 403, 'a requester cannot approve', `${asReq.status}`);
const ap = await api(`/vendors/applications/${A.app.id}/approve`, { method: 'POST', token: procurement, body: { note: 'documents checked' } });
check(ok2xx(ap), 'procurement approves', `${ap.status} ${ap.data?.message ?? ''}`);
const vId = ap.data?.vendor?.id;
check(/^V-\d{5,}$/.test(ap.data?.vendor?.vendorCode ?? ''), 'vendor got a fresh V-code', ap.data?.vendor?.vendorCode);

const vrow = sql(`SELECT state, ntn, contact_email FROM core.vendors WHERE id='${vId}'`)[0];
check(vrow?.[0] === 'Approved' && vrow?.[2] === `ali${run}@example.test`, 'vendor row: Approved, contact email set', vrow);
const cats = sql(`SELECT c.code FROM core.vendor_categories vc JOIN core.categories c ON c.id=vc.category_id
                   WHERE vc.vendor_id='${vId}' AND vc.is_active`).map(r => r[0]);
check(cats.length === 1 && cats[0] === 'IT_HARDWARE', 'vendor mapped to its category', cats);
const u = sql(`SELECT role, vendor_id, active FROM core.users WHERE email='ali${run}@example.test'`)[0];
check(u?.[0] === 'vendor' && u?.[1] === vId && u?.[2] === 't', 'supplier login created and linked', u);
const appRow = sql(`SELECT state, vendor_id, login_user_id IS NOT NULL, decision_note FROM core.vendor_applications WHERE id='${A.app.id}'`)[0];
check(appRow?.[0] === 'Approved' && appRow?.[1] === vId && appRow?.[2] === 't' && appRow?.[3] === 'documents checked',
  'application Approved and linked to vendor + login', appRow);
const aud = sql(`SELECT count(*) FROM audit.audit_log WHERE entity='core.vendor_applications' AND entity_id='${A.app.id}' AND action='approve'`)[0][0];
check(aud === '1', 'approval is in the audit log', aud);
const catAud = sql(`SELECT count(*) FROM audit.audit_log WHERE entity='core.vendors' AND entity_id='${vId}' AND action='category_change'`)[0][0];
check(Number(catAud) >= 1, 'category mapping went through the audited path', catAud);

const master = await api('/vendors', { token: procurement });
check(JSON.stringify(master.data).includes(ap.data.vendor.vendorCode), 'new vendor is in Vendor Master');

const again = await api(`/vendors/applications/${A.app.id}/approve`, { method: 'POST', token: procurement, body: {} });
check(again.status === 409, 'a decided application cannot be approved again', `${again.status}`);

// ── 2. the new supplier works ────────────────────────────────────────────────
console.log('\n== 2. the new supplier can work ==');
const vTok = await login(`ali${run}@example.test`);
const tenders = await api('/supplier/tenders', { token: vTok });
check(tenders.status === 200, 'new supplier signs in and opens the tender list', `${tenders.status}`);
const inbox = await api('/supplier/inbox', { token: vTok });
check(inbox.status === 200 && (inbox.data?.subtitle ?? '').includes(ap.data.vendor.vendorCode),
  'supplier inbox is scoped to the new vendor', inbox.data?.subtitle);

// ── 3. refusals ──────────────────────────────────────────────────────────────
console.log('\n== 3. refusals ==');
const B = await apply('Bilal', { contactEmail: 'procurement@pakboxes.pk' });
const dupEmail = await api(`/vendors/applications/${B.app.id}/approve`, { method: 'POST', token: procurement, body: {} });
check(dupEmail.status === 409 && /already exists/.test(dupEmail.data?.message ?? ''), 'email that already has a login is refused', `${dupEmail.status} ${dupEmail.data?.message}`);
const bVendors = sql(`SELECT count(*) FROM core.vendors WHERE legal_name='Bilal Traders ${run}'`)[0][0];
check(bVendors === '0', 'and nothing was created', bVendors);

const noReason = await api(`/vendors/applications/${B.app.id}/reject`, { method: 'POST', token: procurement, body: {} });
check(noReason.status === 400, 'reject without a reason is refused', `${noReason.status}`);
const rj = await api(`/vendors/applications/${B.app.id}/reject`, { method: 'POST', token: procurement, body: { reason: 'Duplicate of an existing supplier' } });
check(ok2xx(rj), 'reject with a reason', `${rj.status} ${rj.data?.message ?? ''}`);
const bRow = sql(`SELECT state, decision_note, vendor_id IS NULL FROM core.vendor_applications WHERE id='${B.app.id}'`)[0];
check(bRow?.[0] === 'Rejected' && bRow?.[2] === 't', 'application Rejected, no vendor linked', bRow);
const apAfterReject = await api(`/vendors/applications/${B.app.id}/approve`, { method: 'POST', token: procurement, body: { contactEmail: `x${run}@example.test` } });
check(apAfterReject.status === 409, 'a rejected application cannot be approved', `${apAfterReject.status}`);

const C = await apply('Chand', { ntn: A.app.ntn });
if (C.app) {
  const dupNtn = await api(`/vendors/applications/${C.app.id}/approve`, { method: 'POST', token: procurement, body: {} });
  check(dupNtn.status === 409 && /already belongs to vendor/.test(dupNtn.data?.message ?? ''), 'an NTN that is already a vendor is refused', `${dupNtn.status} ${dupNtn.data?.message}`);
  await api(`/vendors/applications/${C.app.id}/reject`, { method: 'POST', token: procurement, body: { reason: 'duplicate NTN (e2e)' } });
}
const bad = await api('/vendors/applications/not-a-uuid/approve', { method: 'POST', token: procurement, body: {} });
check(bad.status === 400, 'malformed id -> 400', `${bad.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
