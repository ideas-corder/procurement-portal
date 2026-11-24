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

// ── 2. the one-time set-password link ───────────────────────────────────────
console.log('\n== 2. set-password link and real supplier password ==');
const link = ap.data?.passwordLink?.url ?? '';
check(/\/set-password\/[A-Za-z0-9_-]{20,}$/.test(link), 'approval returns a set-password link', link);
check(ap.data?.passwordLink?.emailQueued === true, 'and the email is queued in the outbox');
const ob = sql(`SELECT count(*) FROM core.email_outbox WHERE template='supplier_set_password' AND to_email='ali${run}@example.test'`)[0][0];
check(ob === '1', 'outbox row for the new supplier', ob);
const token = link.split('/').pop();
const tokRow = sql(`SELECT count(*) FROM core.password_set_tokens WHERE token_hash='${token}'`)[0][0];
check(tokRow === '0', 'the raw token is not stored (only its hash)', tokRow);

const EMAIL = `ali${run}@example.test`;
const pre = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: 'anything' } });
check(pre.status === 401 && /no password yet/.test(pre.data?.message ?? ''), 'cannot sign in before setting a password', `${pre.status} ${pre.data?.message}`);
const desc = await api(`/auth/set-password/${token}`);
check(desc.data?.valid === true && desc.data?.email === EMAIL, 'link describes the account', desc.data);
const weak = await api('/auth/set-password', { method: 'POST', body: { token, password: 'short' } });
check(weak.status === 400, 'a weak password is refused', `${weak.status} ${weak.data?.message}`);
const PW = 'Tender2026x';
const set = await api('/auth/set-password', { method: 'POST', body: { token, password: PW } });
check(ok2xx(set), 'password set through the link', `${set.status} ${set.data?.message ?? ''}`);
const reuse = await api('/auth/set-password', { method: 'POST', body: { token, password: 'Another2026y' } });
check(reuse.status === 400 && /already been used/.test(reuse.data?.message ?? ''), 'the link works only once', `${reuse.status} ${reuse.data?.message}`);
const wrong = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: 'Wrong2026z' } });
check(wrong.status === 401, 'wrong password is refused', `${wrong.status}`);
const hashed = sql(`SELECT supplier_password_hash LIKE '$2%' FROM core.users WHERE email='${EMAIL}'`)[0][0];
check(hashed === 't', 'stored as a bcrypt hash');

const reset = await api(`/vendors/applications/${A.app.id}/password-link`, { method: 'POST', token: procurement });
const token2 = (reset.data?.passwordLink?.url ?? '').split('/').pop();
check(ok2xx(reset) && token2 && token2 !== token, 'procurement can issue a fresh link', `${reset.status}`);
const reset2 = await api(`/vendors/applications/${A.app.id}/password-link`, { method: 'POST', token: procurement });
const token3 = (reset2.data?.passwordLink?.url ?? '').split('/').pop();
check((await api(`/auth/set-password/${token2}`)).data?.valid === false, 'issuing a new link retires the previous one');
check(ok2xx(await api('/auth/set-password', { method: 'POST', body: { token: token3, password: PW } })), 'the newest link works');

const demo = await api('/auth/login', { method: 'POST', body: { email: 'vendor1@example.com', password: 'demo' } });
check(demo.status === 201, 'seeded demo supplier still signs in as before', `${demo.status}`);
const staff = await api('/auth/login', { method: 'POST', body: { email: 'finance@pakboxes.pk', password: 'x' } });
check(staff.status === 201, 'staff sign-in unchanged', `${staff.status}`);

// ── 3. the new supplier works ────────────────────────────────────────────────
console.log('\n== 3. the new supplier can work ==');
const vTok = await login(EMAIL, PW);
check(Boolean(vTok), 'new supplier signs in with its own password');
const tenders = await api('/supplier/tenders', { token: vTok });
check(tenders.status === 200, 'new supplier signs in and opens the tender list', `${tenders.status}`);
const inbox = await api('/supplier/inbox', { token: vTok });
check(inbox.status === 200 && (inbox.data?.subtitle ?? '').includes(ap.data.vendor.vendorCode),
  'supplier inbox is scoped to the new vendor', inbox.data?.subtitle);

// ── 4. refusals ──────────────────────────────────────────────────────────────
console.log('\n== 4. refusals ==');
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
