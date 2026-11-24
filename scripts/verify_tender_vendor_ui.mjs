// Browser check for the vendor side of open tenders, against the live local stack.
//
//   node scripts/verify_tender_vendor_ui.mjs [screenshot-dir]
//
// vendor1 opens the supplier portal, sees the tender under Open Tenders, clicks
// Bid now, prices the line, submits, then finds it under My Bids as Submitted
// and can edit it. The Invited RFQs tab must not list the tender.
//
// Setup: vendor1@example.com is mapped to IT_HARDWARE in the LOCAL database for
// the run and the mapping is restored on exit.
//
// Needs the `playwright` package (like the other verify_*_ui scripts). If the
// installed browser build differs from the package's, point PW_CHROMIUM at a
// chrome.exe.
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const SHOTS = process.argv[2] || tmpdir();
const EXE = process.env.PW_CHROMIUM || undefined;
const LAPTOP = '55555555-5555-5555-5555-555555555503';
const PEN = '55555555-5555-5555-5555-555555555505';

let pass = 0, fail = 0;
const check = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}  ${d}`); } };
const sql = (q) => spawnSync('docker', ['exec', 'procurement-portal-db', 'psql', '-U', 'proc', '-d', 'procurementDB', '-X', '-A', '-t', '-c', q], { encoding: 'utf8' }).stdout.trim();

async function call(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { status: r.status, data: d };
}
const session = async (email) => (await call('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data;

// ── setup: vendor1 in the category, restored on exit ─────────────────────────
const MAP_WHERE = `u.email = 'vendor1@example.com' AND c.code = 'IT_HARDWARE'`;
const had = sql(`SELECT vc.is_active FROM core.vendor_categories vc JOIN core.users u ON u.vendor_id = vc.vendor_id
                  JOIN core.categories c ON c.id = vc.category_id WHERE ${MAP_WHERE}`);
sql(`INSERT INTO core.vendor_categories (vendor_id, category_id, is_active)
     SELECT u.vendor_id, c.id, true FROM core.users u, core.categories c WHERE ${MAP_WHERE}
     ON CONFLICT (vendor_id, category_id) DO UPDATE SET is_active = true`);
process.on('exit', () => {
  if (had === '') {
    sql(`DELETE FROM core.vendor_categories vc USING core.users u, core.categories c
          WHERE u.vendor_id = vc.vendor_id AND c.id = vc.category_id AND ${MAP_WHERE}`);
  } else {
    sql(`UPDATE core.vendor_categories vc SET is_active = ${had === 't'} FROM core.users u, core.categories c
          WHERE u.vendor_id = vc.vendor_id AND c.id = vc.category_id AND ${MAP_WHERE}`);
  }
  console.log('  (vendor1 category mapping restored)');
});

const req = (await session('requester@pakboxes.pk')).token;
const hod = (await session('hod.sales@pakboxes.pk')).token;
const proc = (await session('procurement@pakboxes.pk')).token;
const vendorS = await session('vendor1@example.com');

const cc = (await call('/lookups/cost-centers', { token: req })).data[0].id;
const created = await call('/pr', { method: 'POST', token: req, body: {
  scope: 'Tender vendor UI', expenseType: 'OPEX', costCenterId: cc, requiredByDate: '2026-12-31', title: 'Tender vendor UI',
  lines: [{ itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 }, { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 }] } });
await call(`/pr/${created.data.id}/advance`, { method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved', 1: 'approved' }, reason: 'ui' } });
const prId = sql(`SELECT id FROM proc.purchase_requisitions WHERE parent_pr_id='${created.data.id}' AND status='IN_PROCUREMENT_REVIEW' LIMIT 1`);
const posted = await call(`/pr/${prId}/tender`, { method: 'POST', token: proc, body: {
  deadlineAt: new Date(Date.now() + 2 * 86400e3).toISOString(), title: 'Laptops for Sales team', notes: 'Deliver to Karachi plant within 14 days.' } });
const rfqId = posted.data?.rfq?.id;
const rfqNumber = posted.data?.rfq?.rfq_number;
if (!rfqId) { console.log('tender not posted', posted); process.exit(1); }
console.log(`fixture tender ${rfqNumber}`);

// ── the browser, as vendor1 ──────────────────────────────────────────────────
const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript((s) => localStorage.setItem('pk_session', JSON.stringify(s)), vendorS);

await page.goto(`${WEB}/supplier`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-supplier-tab="tenders"]', { timeout: 30000 });
check(await page.locator('[data-supplier-tab="invited"][aria-selected="true"]').count() === 1, 'Invited RFQs is the default tab');
check(!(await page.textContent('body')).includes(rfqNumber), 'tender not listed under Invited RFQs');

await page.click('[data-supplier-tab="tenders"]');
await page.waitForSelector(`[data-tender="${rfqId}"]`, { timeout: 15000 });
const row = await page.textContent(`[data-tender="${rfqId}"]`);
check(row.includes('Laptops for Sales team') && row.includes('Deliver to Karachi plant'), 'Open Tenders shows title and requirement');
check(/closes in 1d 2[23]h|closes in 2d 0h|closes in 1d \d+h/.test(row), 'countdown shown', row);
check(page.url().includes('tab=tenders'), 'tab is in the URL');
await page.screenshot({ path: `${SHOTS}/v1-open-tenders.png` });

await page.click(`[data-bid-now="${rfqId}"]`);
await page.waitForURL(/\/supplier\/[0-9a-f-]{36}/, { timeout: 15000 });
await page.waitForSelector('[data-tender-alert]', { timeout: 15000 });
const alertTxt = await page.textContent('[data-tender-alert]');
check(alertTxt.includes(rfqNumber) && /sealed/.test(alertTxt) && alertTxt.includes('Deliver to Karachi plant'), 'bid form: tender alert with requirement');
check(await page.getByRole('heading', { name: 'Submit Bid' }).count() > 0, 'page titled Submit Bid');

const priceInput = page.locator('input[type="number"]').first();
await priceInput.fill('43000');
await page.screenshot({ path: `${SHOTS}/v2-bid-form.png` });
await page.getByRole('button', { name: 'Submit bid' }).click();
await page.waitForSelector('.alert.success', { timeout: 15000 });
const ok1 = await page.textContent('.alert.success');
check(/Submitted as V1/.test(ok1) && /change your bid until the deadline/.test(ok1), 'bid submitted as V1', ok1);
// The success message lands first; the refreshed form (with my live V1) a moment later.
const upd = await page.getByRole('button', { name: 'Update bid' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
check(upd, 'button now says Update bid');

// back to My Bids
await page.click('text=← My Bids');
await page.waitForSelector(`[data-my-bid="${rfqId}"]`, { timeout: 15000 });
const mb = await page.textContent(`[data-my-bid="${rfqId}"]`);
check(/Submitted/.test(mb) && /V1 · PKR 86,000/.test(mb), 'My Bids: Submitted, V1, PKR 86,000', mb);
check(/Edit bid/.test(mb), 'My Bids offers Edit bid');
await page.screenshot({ path: `${SHOTS}/v3-my-bids.png` });

// close it and look again
sql(`UPDATE proc.rfq SET created_at=now()-interval '4 days', issued_at=now()-interval '4 days', initial_deadline_at=now()-interval '1 minute', deadline_at=now()-interval '1 minute' WHERE id='${rfqId}'`);
await call('/rfq/tenders/close-due', { method: 'POST', token: proc });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector(`[data-my-bid="${rfqId}"]`);
const mb2 = await page.textContent(`[data-my-bid="${rfqId}"]`);
check(/Tender closed/.test(mb2) && /View/.test(mb2), 'after the deadline: Tender closed, View only', mb2);
await page.click(`[data-my-bid="${rfqId}"] [data-open-bid]`);
await page.waitForSelector('[data-tender-alert]');
check(/Bidding closed/.test(await page.textContent('[data-tender-alert]')), 'bid form says bidding closed');
check(await page.getByRole('button', { name: /Submit bid|Update bid/ }).count() === 0, 'no submit button after the deadline');
await page.screenshot({ path: `${SHOTS}/v4-closed.png` });

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
