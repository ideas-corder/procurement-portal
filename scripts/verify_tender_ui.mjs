// Browser check for the open-tender staff UI, against the live local stack.
//
//   node scripts/verify_tender_ui.mjs [screenshot-dir]
//
// Covers: the Post Tender button and dialog on a PR at procurement review, the
// tender card (open / closed), Ready for CS held back while bidding is open
// (UI and API), and the header bell showing the "tender closed" notification.
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

const req = (await session('requester@pakboxes.pk')).token;
const hod = (await session('hod.sales@pakboxes.pk')).token;
const procS = await session('procurement@pakboxes.pk');

const cc = (await call('/lookups/cost-centers', { token: req })).data[0].id;
const created = await call('/pr', { method: 'POST', token: req, body: {
  scope: 'Tender UI', expenseType: 'OPEX', costCenterId: cc, requiredByDate: '2026-12-31', title: 'Tender UI check',
  lines: [{ itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 }, { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 }] } });
await call(`/pr/${created.data.id}/advance`, { method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved', 1: 'approved' }, reason: 'ui' } });
const prId = sql(`SELECT id FROM proc.purchase_requisitions WHERE parent_pr_id='${created.data.id}' AND status='IN_PROCUREMENT_REVIEW' LIMIT 1`);
console.log('fixture PR', prId);

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.addInitScript((s) => localStorage.setItem('pk_session', JSON.stringify(s)), procS);

await page.goto(`${WEB}/pr/${prId}`, { waitUntil: 'networkidle' });
const postBtn = page.locator('[data-post-tender]');
await postBtn.waitFor({ timeout: 30000 });
check(await postBtn.isVisible(), 'Post Tender button shows next to Issue RFQ');
check(await page.getByRole('button', { name: /Issue RFQ/ }).isVisible(), 'Issue RFQ still there');
check(await page.locator('[data-notification-bell]').isVisible(), 'bell in header');
await page.screenshot({ path: `${SHOTS}/1-pr-before.png` });

await postBtn.click();
const dlg = page.locator('[data-tender-dialog]');
await dlg.waitFor();
check(await dlg.isVisible(), 'Post Tender dialog opens');
await page.fill('[data-tender-notes]', 'Delivery to Karachi plant within 14 days. Prices inclusive of GST.');
await page.screenshot({ path: `${SHOTS}/2-dialog.png` });

// too-soon deadline is refused in the dialog
const keep = await page.inputValue('[data-tender-deadline]');
const soon = new Date(Date.now() + 2 * 3600e3);
const pad = (n) => String(n).padStart(2, '0');
await page.fill('[data-tender-deadline]', `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:${pad(soon.getMinutes())}`);
check(await page.locator('[data-tender-post]').isDisabled(), 'Post disabled for a deadline under 24h');
await page.fill('[data-tender-deadline]', keep);

await page.click('[data-tender-post]');
await dlg.waitFor({ state: 'detached', timeout: 30000 });
await page.waitForSelector('[data-tender-header]', { timeout: 30000 });
const body = await page.textContent('body');
check(/Tender RFQ-\d+-\d+ posted/.test(body), 'success message shown', body.match(/Tender[^.]*posted[^.]*\./)?.[0]);
check(await page.locator('[data-tender-state="open"]').isVisible(), 'card: Open tender, Accepting bids');
check(body.includes('Delivery to Karachi plant'), 'card shows the tender notes');
check(!(await page.locator('[data-post-tender]').count()), 'Post Tender gone once a tender exists');
check(!(await page.getByRole('button', { name: /Re-issue RFQ/ }).count()), 'Re-issue hidden on a tender');
const rcs = page.getByRole('button', { name: 'Ready for CS' });
check((await rcs.count()) === 0 || await rcs.isDisabled(), 'Ready for CS not available while bidding is open');
await page.screenshot({ path: `${SHOTS}/3-tender-posted.png`, fullPage: false });

// API agrees: early ready-for-cs is refused
const early = await call(`/pr/${prId}/ready-for-cs`, { method: 'POST', token: procS.token, body: { remarks: 'early' } });
check(early.status === 400 && /still open for bids/.test(early.data?.message ?? ''), 'API refuses Ready for CS before the deadline', `${early.status} ${early.data?.message}`);

// close it: move deadline into the past, run the closer, then the bell shows it
const rfqId = sql(`SELECT id FROM proc.rfq WHERE pr_id='${prId}' AND state <> 'Cancelled'`);
sql(`UPDATE proc.rfq SET created_at=now()-interval '4 days', issued_at=now()-interval '4 days', initial_deadline_at=now()-interval '1 minute', deadline_at=now()-interval '1 minute' WHERE id='${rfqId}'`);
await call('/rfq/tenders/close-due', { method: 'POST', token: procS.token });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-tender-header]');
check(await page.locator('[data-tender-state="closed"]').isVisible(), 'card: Closed for bids after the deadline');
check(await page.locator('[data-notification-count]').isVisible(), 'bell shows an unread count');
await page.click('[data-notification-bell] button');
await page.waitForSelector('[data-notification-item]');
// Match THIS tender's notification, not merely the newest: the API timer may
// close another test's tender at the same moment.
const rfqNumber = sql(`SELECT rfq_number FROM proc.rfq WHERE id='${rfqId}'`);
const mine = page.locator('[data-notification-item]', { hasText: `Tender ${rfqNumber} closed - 0 bids` });
check(await mine.count() === 1, 'the bell lists this tender closing', rfqNumber);
await page.screenshot({ path: `${SHOTS}/4-bell-open.png` });
await mine.first().click();
await page.waitForURL(/\/rfq\//, { timeout: 15000 });
check(page.url().includes(`/rfq/${rfqId}`), 'clicking it opens the RFQ page');
await page.screenshot({ path: `${SHOTS}/5-rfq-page.png` });

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
