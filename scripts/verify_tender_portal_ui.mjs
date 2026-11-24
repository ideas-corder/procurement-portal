// Browser check for the separate tender screens, every role, end to end.
//
//   node scripts/verify_tender_portal_ui.mjs [screenshot-dir]
//
// requester raises a tender request -> HOD approves it on Tender Requests ->
// procurement publishes it from Tender Management (budget, deposit, document)
// -> it appears on the public board -> a new supplier bids from its dashboard
// with a document and confirms the final bid -> procurement sees the sealed bid.
//
// Each run creates one real supplier (vendors cannot be deleted by design).
// Needs the `playwright` package (like the other verify_*_ui scripts). If the
// installed browser build differs from the package's, point PW_CHROMIUM at a
// chrome.exe.
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const SHOTS = process.argv[2] || tmpdir();
const EXE = process.env.PW_CHROMIUM || undefined;

let pass = 0, fail = 0;
const check = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}  ${String(d).slice(0, 300)}`); } };
async function call(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { status: r.status, data: d };
}
const session = async (email, password = 'demo') => (await call('/auth/login', { method: 'POST', body: { email, password } })).data;

const run = Date.now() % 1e7;
const TITLE = `Laptops for the audit team ${run}`;

// A fresh supplier in IT hardware, through the real onboarding + approval path.
const proc = await session('procurement@pakboxes.pk');
const vEmail = `ui${run}@example.test`;
const sub = await call('/onboarding/applications', { method: 'POST', body: {
  legalName: `UI Supplies ${run}`, ntn: `${run}-77`, contactName: 'UI', contactEmail: vEmail, categories: 'IT_HARDWARE' } });
const app = (await call('/vendors/applications', { token: proc.token })).data.applications.find(a => a.reference === sub.data.reference);
const ap = await call(`/vendors/applications/${app.id}/approve`, { method: 'POST', token: proc.token, body: {} });
const vPw = `UiPass${run}`;
await call('/auth/set-password', { method: 'POST', body: { token: ap.data.passwordLink.url.split('/').pop(), password: vPw } });

const pdf = join(tmpdir(), `tender-spec-${run}.pdf`);
writeFileSync(pdf, `%PDF-1.4 tender specification ${run}`);
const quote = join(tmpdir(), `my-quote-${run}.pdf`);
writeFileSync(quote, `%PDF-1.4 supplier quotation ${run}`);

const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
const errors = [];
async function as(email, password = 'demo') {
  const s = await session(email, password);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  if (s) await ctx.addInitScript((x) => localStorage.setItem('pk_session', JSON.stringify(x)), s);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { if (!/Abort fetching component/.test(e.message)) errors.push(`${email}: ${e.message}`); });
  return p;
}
const navHas = async (p, label) => (await p.locator('.sidebar a, .sidebar .nav-item').allTextContents()).some(t => t.includes(label));

// ── 1. requester ─────────────────────────────────────────────────────────────
console.log('\n== requester: new tender request ==');
const rq = await as('requester@pakboxes.pk');
await rq.goto(`${WEB}/tenders/request`, { waitUntil: 'networkidle' });
await rq.waitForSelector('[data-tender-request-form]', { timeout: 30000 });
check(await navHas(rq, 'New Tender Request') && await navHas(rq, 'Tender Requests'), 'requester sidebar has the Tenders section');
await rq.fill('[data-tr-title]', TITLE);
await rq.selectOption('[data-tr-dept]', { label: 'Sales' });
await rq.fill('[data-tr-why]', 'Old laptops are out of warranty.');
await rq.fill('[data-tr-desc="0"]', 'Dell Latitude 5550 laptop');
await rq.selectOption('[data-tr-cat="0"]', 'IT_HARDWARE');
await rq.fill('[data-tr-qty="0"]', '1');
await rq.fill('[data-tr-price="0"]', '30000');
check((await rq.textContent('[data-tr-total]')).includes('30,000'), 'estimated total updates');
await rq.screenshot({ path: `${SHOTS}/p1-request-form.png` });
await rq.click('[data-tr-submit]');
await rq.waitForURL(/\/tenders\/requests/, { timeout: 30000 });
await rq.waitForSelector('[data-tr-all]', { timeout: 30000 });
check((await rq.textContent('[data-tr-all]')).includes(TITLE), 'request listed under My tender requests');
await rq.screenshot({ path: `${SHOTS}/p2-my-requests.png` });

// ── 2. HOD ───────────────────────────────────────────────────────────────────
console.log('\n== HOD: approve on Tender Requests ==');
const hod = await as('hod.sales@pakboxes.pk');
await hod.goto(`${WEB}/tenders/requests`, { waitUntil: 'networkidle' });
await hod.waitForSelector('[data-tr-waiting]', { timeout: 30000 });
check(await navHas(hod, 'Tender Requests'), 'HOD sidebar has Tender Requests');
const card = hod.locator('[data-tr]', { hasText: TITLE });
check(await card.count() === 1, 'request waiting for the HOD');
await hod.screenshot({ path: `${SHOTS}/p3-hod-waiting.png` });
await card.locator('[data-tr-approve]').click();
await hod.waitForSelector('[data-tr-msg]', { timeout: 30000 });
check(/approved/.test(await hod.textContent('[data-tr-msg]')), 'HOD approved it');

// ── 3. procurement ───────────────────────────────────────────────────────────
console.log('\n== procurement: publish from Tender Management ==');
const pp = await as('procurement@pakboxes.pk');
await pp.goto(`${WEB}/tenders?view=ready`, { waitUntil: 'networkidle' });
await pp.waitForSelector('[data-ready-list]', { timeout: 30000 });
check(await navHas(pp, 'Tender Management'), 'procurement sidebar has Tender Management');
const ready = pp.locator('[data-ready]', { hasText: TITLE });
check(await ready.count() === 1, 'request is under Ready to publish');
await pp.screenshot({ path: `${SHOTS}/p4-ready.png` });
await ready.locator('[data-publish]').click();
await pp.waitForSelector('[data-tender-dialog]');
await pp.fill('[data-tender-notes]', 'Dell Latitude 5550 or equivalent. Delivery to Lahore within 14 days.');
await pp.fill('[data-tender-budget-min]', '25000');
await pp.fill('[data-tender-budget-max]', '32000');
await pp.fill('[data-tender-deposit]', '2000');
await pp.setInputFiles('[data-tender-files]', pdf);
await pp.screenshot({ path: `${SHOTS}/p5-publish-dialog.png` });
await pp.click('[data-tender-post]');
await pp.waitForSelector('[data-tm-msg]', { timeout: 30000 });
const tmMsg = await pp.textContent('[data-tm-msg]');
check(/posted/.test(tmMsg) && /1 document/.test(tmMsg), 'tender posted with its document', tmMsg);
await pp.waitForSelector('[data-tm-list="open"]', { timeout: 30000 });
const tcard = pp.locator('[data-tender-card]', { hasText: TITLE });
check(await tcard.count() === 1, 'tender listed under Open for bids');
await pp.screenshot({ path: `${SHOTS}/p6-open-list.png` });
await tcard.click();
await pp.waitForURL(/\/tenders\/[0-9a-f-]{36}/);
const rfqId = pp.url().split('/').pop();
await pp.waitForSelector('[data-tender-info]');
check((await pp.textContent('[data-tender-info]')).includes(`tender-spec-${run}.pdf`), 'document listed on the tender');

// ── 4. public ────────────────────────────────────────────────────────────────
console.log('\n== public board ==');
const pubCtx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const pub = await pubCtx.newPage();
pub.on('pageerror', (e) => errors.push(`public: ${e.message}`));
await pub.goto(`${WEB}/open-tenders`, { waitUntil: 'networkidle' });
await pub.waitForSelector('[data-public-tenders]', { timeout: 30000 });
await pub.fill('[data-filter-q]', String(run));
const pcard = pub.locator('[data-tender-card]', { hasText: TITLE });
check(await pcard.count() === 1, 'tender on the public board, found by search');
await pub.screenshot({ path: `${SHOTS}/p7-public-board.png` });
await pcard.click();
await pub.waitForSelector('[data-public-bid-panel]');
const pubTxt = await pub.textContent('body');
check(pubTxt.includes('25,000') && pubTxt.includes('2,000') && pubTxt.includes(`tender-spec-${run}.pdf`), 'public detail shows budget, deposit and document');
check(await pub.locator('[data-signin-to-bid]').count() === 1, 'visitor is offered Sign in to bid');
await pub.screenshot({ path: `${SHOTS}/p8-public-detail.png` });

// ── 5. supplier ──────────────────────────────────────────────────────────────
console.log('\n== supplier: bid from the dashboard ==');
const vp = await as(vEmail, vPw);
await vp.goto(`${WEB}/supplier/tenders`, { waitUntil: 'networkidle' });
await vp.waitForSelector('[data-vendor-browse]', { timeout: 30000 });
check(await navHas(vp, 'Tenders'), 'supplier sidebar has Tenders');
await vp.screenshot({ path: `${SHOTS}/p9-vendor-dashboard.png` });
await vp.locator('[data-tender-card]', { hasText: TITLE }).click();
await vp.waitForSelector('[data-prepare-bid]', { timeout: 30000 });
await vp.click('[data-prepare-bid]');
await vp.waitForSelector('[data-bid-form]', { timeout: 30000 });
await vp.fill('[data-bid-price="1"]', '28750');
await vp.setInputFiles('[data-bid-file]', quote);
await vp.waitForSelector('[data-bid-doc]', { timeout: 30000 });
check((await vp.textContent('[data-bid-total]')).includes('28,750'), 'bid total computed');
await vp.screenshot({ path: `${SHOTS}/p10-bid-form.png` });
await vp.click('[data-review-bid]');
await vp.waitForSelector('[data-confirm-bid]');
check(/final/.test(await vp.textContent('[data-confirm-bid]')), 'confirmation says the bid is final');
await vp.screenshot({ path: `${SHOTS}/p11-confirm.png` });
await vp.click('[data-submit-bid]');
await vp.waitForSelector('[data-my-bid-summary]', { timeout: 30000 });
const summary = await vp.textContent('[data-my-bid-summary]');
check(summary.includes('28,750') && summary.includes(`my-quote-${run}.pdf`), 'bid submitted; summary shows amount and document', summary);
check(await vp.locator('[data-bid-form], [data-prepare-bid]').count() === 0, 'no way to change the bid');
await vp.screenshot({ path: `${SHOTS}/p12-bid-done.png` });
await vp.goto(`${WEB}/supplier/tenders?tab=mine`, { waitUntil: 'networkidle' });
await vp.waitForSelector('[data-vendor-mine]', { timeout: 30000 });
check((await vp.textContent('[data-vendor-mine]')).includes(TITLE), 'tender under My tenders');

// ── 6. procurement sees the sealed bid ───────────────────────────────────────
console.log('\n== procurement: sealed bid ==');
await pp.goto(`${WEB}/tenders/${rfqId}`, { waitUntil: 'networkidle' });
await pp.waitForSelector('[data-tm-bid-table]');
const bt = await pp.textContent('[data-tm-bid-table]');
check(bt.includes(`UI Supplies ${run}`) && bt.includes('Sealed') && !bt.includes('28,750'), 'bidder visible, price sealed', bt.slice(0, 200));
await pp.screenshot({ path: `${SHOTS}/p13-procurement-sealed.png`, fullPage: true });

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
