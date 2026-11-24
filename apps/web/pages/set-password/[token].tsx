// `/set-password/:token` — a new supplier sets its password.
//
// Public page (no session): the one-time link Procurement passes on after
// approving an onboarding application. The API checks the token; this page
// only shows whose account it is, collects the password twice and submits.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { api } from '../../lib/api';

type Describe = { valid: boolean; reason?: string; email?: string; displayName?: string; expiresAt?: string };

const MIN = 8;
function problem(pw: string): string | null {
  if (pw.length < MIN) return `At least ${MIN} characters.`;
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use at least one letter and one number.';
  return null;
}

export default function SetPassword() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const [info, setInfo] = useState<Describe | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.get<Describe>(`/auth/set-password/${encodeURIComponent(token)}`)
      .then(r => setInfo(r.data))
      .catch(e => setInfo({ valid: false, reason: e.message }));
  }, [token]);

  const p = pw ? problem(pw) : null;
  const mismatch = pw2.length > 0 && pw !== pw2;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (problem(pw) || pw !== pw2) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ email: string }>('/auth/set-password', { token, password: pw });
      setDone(r.data.email);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-shell">
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div className="brand-logo lg">P</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--navy)', marginBottom: 4 }}>Supplier portal</h1>
          <p className="text-mute text-sm">Set your password</p>
        </div>
        <div className="card">
          <div className="card-b" data-set-password="">
            {!info && <div className="empty-state">Checking your link&hellip;</div>}

            {info && !info.valid && !done && (
              <div className="alert danger" data-link-invalid="">{info.reason ?? 'This link is not valid.'}</div>
            )}

            {done && (
              <>
                <div className="alert success" data-password-done="">
                  Password set for <b>{done}</b>. You can now sign in.
                </div>
                <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => router.push(`/?email=${encodeURIComponent(done)}`)}>
                  Go to sign in
                </button>
              </>
            )}

            {info?.valid && !done && (
              <form onSubmit={submit}>
                <p className="text-sm" style={{ marginTop: 0 }}>
                  Account: <b>{info.displayName}</b><br />
                  Sign-in email: <b>{info.email}</b>
                </p>
                <label className="field">
                  <span className="lbl">New password <span className="req">*</span></span>
                  <input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" required data-pw1="" />
                  <span className="text-sm text-mute" style={{ display: 'block', marginTop: 4 }}>{p ?? `At least ${MIN} characters, with a letter and a number.`}</span>
                </label>
                <label className="field">
                  <span className="lbl">Repeat password <span className="req">*</span></span>
                  <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" required data-pw2="" />
                  {mismatch && <span className="text-sm" style={{ color: 'var(--danger)', display: 'block', marginTop: 4 }}>The two passwords differ.</span>}
                </label>
                {err && <div className="alert danger" style={{ marginTop: 10, marginBottom: 0 }}>{err}</div>}
                <button type="submit" className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }}
                        disabled={busy || Boolean(problem(pw)) || pw !== pw2} data-set-password-submit="">
                  {busy ? 'Saving…' : 'Set password'}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
