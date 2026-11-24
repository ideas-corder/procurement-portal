// Browser check: a company applies, procurement approves it on screen, the new
// supplier sets its password from the one-time link, signs in and sees tenders.
//
//   node scripts/verify_vendor_onboarding_ui.mjs [screenshot-dir]
//
// Each run creates one new vendor (vendors cannot be deleted by design).
// Needs the `playwright` package (like the other verify_*_ui scripts). If the
// installed browser build differs from the package's, point PW_CHROMIUM at a
// chrome.exe.
import { chromium } from 'playwright';
import { tmpdir } from 'node:os';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const SHOTS = process.argv[2] || tmpdir();
const EXE = process.env.PW_CHROMIUM || undefined;

let pass = 0, fail = 0;
const check = (c, l, d = '') => { if (c) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}  ${d}`); } };

async function call(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  return { status: r.status, data: d };
}

const run = Date.now() % 1e7;
const EMAIL = `zara${run}@example.test`;
const NAME = `Zara Supplies ${run}`;
const a1 = await call('/onboarding/applications', { method: 'POST', body: {
  legalName: NAME, ntn: `${run}-9`, contactName: 'Zara Ahmed', contactEmail: EMAIL, categories: 'IT_HARDWARE' } });
const a2 = await call('/onboarding/applications', { method: 'POST', body: {
  legalName: `Fake Co ${run}`, ntn: `${run}-8`, contactName: 'X', contactEmail: `fake${run}@example.test`, categories: 'IT_HARDWARE' } });
const REF1 = a1.data?.reference, REF2 = a2.data?.reference;
console.log(`applications ${REF1}, ${REF2}`);

const procS = (await call('/auth/login', { method: 'POST', body: { email: 'procurement@pakboxes.pk', password: 'demo' } })).data;

const browser = await chromium.launch(EXE ? { executablePath: EXE } : {});
const errors = [];
const watch = (p) => {
  // "Abort fetching component for route" is Next.js cancelling a route load that
  // a second navigation replaced: the login page both pushes /dashboard after
  // sign-in and replaces to it once the session renders (pre-existing). The
  // user still lands on the right page, so it is not counted as a page error.
  p.on('pageerror', (e) => { if (!/Abort fetching component for route/.test(e.message)) errors.push(e.message); });
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Abort fetching component for route/.test(m.text())) errors.push(m.text()); });
};

// ── procurement ──────────────────────────────────────────────────────────────
const staffCtx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
await staffCtx.addInitScript((s) => localStorage.setItem('pk_session', JSON.stringify(s)), procS);
const page = await staffCtx.newPage(); watch(page);

await page.goto(`${WEB}/vendors`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-pending-applications]', { timeout: 30000 });
check(/waiting for a decision/.test(await page.textContent('[data-pending-applications]')), 'Vendor Master shows the pending-applications notice');
await page.click('text=Review applications');
await page.waitForURL(/vendor-applications/);
await page.waitForSelector(`[data-application="${REF1}"]`, { timeout: 30000 });
check(true, 'applications page lists the new application');
await page.screenshot({ path: `${SHOTS}/a1-queue.png` });

await page.click(`[data-approve="${REF1}"]`);
await page.waitForSelector('[data-decision-dialog]');
check((await page.inputValue('input[type="email"]')) === EMAIL, 'approve dialog pre-fills the applicant email');
await page.screenshot({ path: `${SHOTS}/a2-approve-dialog.png` });
await page.click('[data-confirm-approve]');
await page.waitForSelector('[data-approval-outcome]', { timeout: 30000 });
const outcome = await page.textContent('[data-approval-outcome]');
check(/approved/.test(outcome) && /V-\d{5}/.test(outcome) && outcome.includes(EMAIL), 'outcome names the new vendor code and login', outcome.slice(0, 160));
const link = await page.inputValue('[data-password-link]');
check(/\/set-password\/[A-Za-z0-9_-]{20,}$/.test(link), 'one-time password link shown to copy', link);
await page.screenshot({ path: `${SHOTS}/a3-approved.png` });

await page.click(`[data-reject="${REF2}"]`);
await page.waitForSelector('[data-decision-dialog]');
check(await page.locator('[data-confirm-reject]').isDisabled(), 'reject needs a reason');
await page.fill('[data-decision-dialog] textarea', 'Could not verify the NTN');
await page.click('[data-confirm-reject]');
await page.waitForSelector(`[data-application="${REF2}"]`, { state: 'detached', timeout: 15000 });
check(true, 'rejected application leaves the waiting list');

// ── the new supplier, in a fresh browser with no session ─────────────────────
const vCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const vp = await vCtx.newPage(); watch(vp);
const path = new URL(link).pathname;
await vp.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
await vp.waitForSelector('[data-pw1]', { timeout: 30000 });
check((await vp.textContent('[data-set-password]')).includes(EMAIL), 'set-password page names the account');
await vp.fill('[data-pw1]', 'short');
await vp.fill('[data-pw2]', 'short');
check(await vp.locator('[data-set-password-submit]').isDisabled(), 'a weak password cannot be submitted');
const PW = 'Zara2026pass';
await vp.fill('[data-pw1]', PW);
await vp.fill('[data-pw2]', PW);
await vp.screenshot({ path: `${SHOTS}/a4-set-password.png` });
await vp.click('[data-set-password-submit]');
await vp.waitForSelector('[data-password-done]', { timeout: 15000 });
check(true, 'password set');
await vp.click('text=Go to sign in');
await vp.waitForSelector('input[type="email"]');
await vp.waitForFunction((e) => document.querySelector('input[type="email"]')?.value === e, EMAIL, { timeout: 10000 }).catch(() => {});
check((await vp.inputValue('input[type="email"]')) === EMAIL, 'sign-in page pre-fills the email');
await vp.fill('input[type="password"]', PW);
await vp.click('button[type="submit"]');
await vp.waitForURL(/\/(dashboard|supplier)/, { timeout: 30000 });
// Let the post-login navigation settle (a vendor is forwarded on to /supplier);
// leaving mid-route makes Next.js log an aborted route load.
await vp.waitForLoadState('networkidle');
await vp.waitForTimeout(1500);
await vp.goto(`${WEB}/supplier?tab=tenders`, { waitUntil: 'networkidle' });
await vp.waitForSelector('[data-supplier-tab="tenders"]', { timeout: 30000 });
const sub = await vp.textContent('body');
check(sub.includes(NAME), 'supplier portal acts as the new vendor');
await vp.screenshot({ path: `${SHOTS}/a5-supplier.png` });

// the link is spent
await vp.goto(`${WEB}${path}`, { waitUntil: 'networkidle' });
await vp.waitForSelector('[data-link-invalid]', { timeout: 15000 });
check(/already been used/.test(await vp.textContent('[data-link-invalid]')), 'the link cannot be used twice');

check(errors.length === 0, 'no page errors', errors.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
