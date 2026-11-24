// `vendor-applications` — the onboarding queue.
//
// Companies apply through the public onboarding form (apps/onboarding). Here
// Procurement / CS approve or reject them. Approving creates the vendor (new
// V-code), maps its line category and creates its supplier login; the response
// carries a ONE-TIME link for the supplier to set its password, shown here once
// to copy and pass on (it is also queued as an email in the outbox).
//
// The decision logic lives in the API (VendorApplicationsService); this page
// only collects the inputs and shows the result.

import { useCallback, useEffect, useState } from 'react';
import Shell from '../components/Shell';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { roleAllowed } from '@procurement/roles';

type Application = {
  id: string;
  reference: string;
  legal_name: string;
  ntn: string;
  contact_name: string | null;
  contact_email: string | null;
  categories: string | null;
  state: 'Submitted' | 'Under_Review' | 'Approved' | 'Rejected' | string;
  submitted_at: string;
  reviewed_at: string | null;
  decision_note: string | null;
  reviewed_by_email: string | null;
};
type Category = { code: string; name: string; active: boolean };
type LinkInfo = { url: string; expiresAt: string; emailQueued: boolean };
type Outcome = {
  kind: 'approved' | 'link';
  reference: string;
  vendorCode?: string;
  email?: string;
  link: LinkInfo;
};

const PENDING = ['Submitted', 'Under_Review'];
const STATE_PILL: Record<string, string> = {
  Submitted: 'warn', Under_Review: 'warn', Approved: 'success', Rejected: 'danger',
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export default function VendorApplications() {
  const { session } = useSession();
  const role = session?.user?.role ?? '';
  const allowed = roleAllowed(role, 'procurement,cs');

  const [apps, setApps] = useState<Application[] | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [showDecided, setShowDecided] = useState(false);

  const [approving, setApproving] = useState<Application | null>(null);
  const [rejecting, setRejecting] = useState<Application | null>(null);
  const [form, setForm] = useState({ email: '', category: '', note: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [dlgErr, setDlgErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([
        api.get<{ applications: Application[] }>('/vendors/applications'),
        api.get<{ items: Category[] }>('/vendors/categories'),
      ]);
      setApps(a.data.applications ?? []);
      setCats((c.data.items ?? []).filter(x => x.active));
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const openApprove = (a: Application) => {
    setDlgErr(null); setOutcome(null);
    setForm({ email: a.contact_email ?? '', category: (a.categories ?? '').split(',')[0]?.trim() ?? '', note: '', reason: '' });
    setApproving(a);
  };
  const openReject = (a: Application) => {
    setDlgErr(null); setOutcome(null);
    setForm({ email: '', category: '', note: '', reason: '' });
    setRejecting(a);
  };

  async function approve() {
    if (!approving) return;
    setBusy(true); setDlgErr(null);
    try {
      const r = await api.post<any>(`/vendors/applications/${approving.id}/approve`, {
        contactEmail: form.email.trim() || undefined,
        categories: form.category ? [form.category] : undefined,
        note: form.note.trim() || undefined,
      });
      setOutcome({
        kind: 'approved', reference: approving.reference,
        vendorCode: r.data.vendor?.vendorCode, email: r.data.login?.email, link: r.data.passwordLink,
      });
      setApproving(null);
      load();
    } catch (e: any) {
      setDlgErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!rejecting) return;
    setBusy(true); setDlgErr(null);
    try {
      await api.post(`/vendors/applications/${rejecting.id}/reject`, { reason: form.reason });
      setRejecting(null);
      load();
    } catch (e: any) {
      setDlgErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function newLink(a: Application) {
    setErr(null); setOutcome(null);
    try {
      const r = await api.post<any>(`/vendors/applications/${a.id}/password-link`);
      setOutcome({ kind: 'link', reference: a.reference, email: a.contact_email ?? undefined, link: r.data.passwordLink });
    } catch (e: any) {
      setErr(e.message);
    }
  }

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard blocked: the link stays selectable on screen */ }
  }

  const pending = (apps ?? []).filter(a => PENDING.includes(a.state));
  const decided = (apps ?? []).filter(a => !PENDING.includes(a.state));
  const shown = showDecided ? [...pending, ...decided] : pending;

  return (
    <Shell title="Vendor Applications" subtitle="Companies that applied through the onboarding form" screenId="vendors">
      {!allowed && (
        <div className="card"><div className="card-b">Vendor applications are handled by Procurement and CS.</div></div>
      )}
      {allowed && err && <div className="alert danger">{err}</div>}

      {allowed && outcome && (
        <div className="alert success" data-approval-outcome="">
          <div style={{ width: '100%' }}>
            {outcome.kind === 'approved' ? (
              <div>
                <b>{outcome.reference} approved.</b> Vendor <b className="mono">{outcome.vendorCode}</b> created
                {' '}with a supplier login for <b>{outcome.email}</b>.
              </div>
            ) : (
              <div><b>New password link for {outcome.reference}.</b> The previous link no longer works.</div>
            )}
            <div style={{ marginTop: 8 }}>
              Send this one-time link to the supplier to set its password
              {outcome.link.emailQueued ? ' (an email with it is also queued in the outbox)' : ''}.
              It works once and expires {fmt(outcome.link.expiresAt)}. It is shown only now.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <input readOnly value={outcome.link.url} style={{ flex: 1 }} onFocus={e => e.currentTarget.select()} data-password-link="" />
              <button className="btn sm" onClick={() => copy(outcome.link.url)}>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
          </div>
        </div>
      )}

      {allowed && !apps && !err && <div className="card"><div className="card-b empty-state">Loading&hellip;</div></div>}

      {allowed && apps && (
        <div className="card">
          <div className="card-h">
            <h3>{pending.length} waiting for a decision</h3>
            <label className="text-sm" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={showDecided} onChange={e => setShowDecided(e.target.checked)} />
              Show decided ({decided.length})
            </label>
          </div>
          <div className="card-b">
            {shown.length === 0 ? (
              <div className="empty-state">No applications waiting. New ones appear here when a company applies.</div>
            ) : (
              <table className="t" data-applications="">
                <thead>
                  <tr>
                    <th>Reference</th><th>Company</th><th>NTN</th><th>Contact</th><th>Category</th>
                    <th>Submitted</th><th>Status</th><th style={{ textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(a => (
                    <tr key={a.id} data-application={a.reference}>
                      <td className="mono">{a.reference}</td>
                      <td><b>{a.legal_name}</b></td>
                      <td className="mono">{a.ntn}</td>
                      <td>
                        <div>{a.contact_name ?? '—'}</div>
                        <div className="text-sm text-mute">{a.contact_email ?? 'no email'}</div>
                      </td>
                      <td>{a.categories ?? '—'}</td>
                      <td className="text-sm">{fmt(a.submitted_at)}</td>
                      <td>
                        <span className={`pill ${STATE_PILL[a.state] ?? ''}`}>{a.state.replace('_', ' ')}</span>
                        {a.decision_note && <div className="text-sm text-mute">{a.decision_note}</div>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {PENDING.includes(a.state) && (
                          <>
                            <button className="btn sm success" onClick={() => openApprove(a)} data-approve={a.reference}>Approve</button>{' '}
                            <button className="btn sm danger" onClick={() => openReject(a)} data-reject={a.reference}>Reject</button>
                          </>
                        )}
                        {a.state === 'Approved' && (
                          <button className="btn sm ghost" onClick={() => newLink(a)} data-new-link={a.reference}
                                  title="Issue a new one-time set-password link (the old one stops working)">
                            New password link
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {(approving || rejecting) && (
        <div
          role="dialog" aria-modal="true"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex',
                   alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
          onClick={e => { if (e.target === e.currentTarget && !busy) { setApproving(null); setRejecting(null); } }}
        >
          <div style={{ width: 560, maxWidth: '94vw', background: 'var(--surface)', borderRadius: 10,
                        border: '1px solid var(--line)', padding: 20 }} data-decision-dialog="">
            <h3 style={{ marginTop: 0 }}>
              {approving ? `Approve ${approving.reference}` : `Reject ${rejecting!.reference}`}
            </h3>
            <p className="text-sm text-mute" style={{ marginTop: 0 }}>
              {(approving ?? rejecting)!.legal_name} &middot; NTN {(approving ?? rejecting)!.ntn}
            </p>
            {dlgErr && <div className="alert danger">{dlgErr}</div>}

            {approving ? (
              <>
                <div className="alert info">
                  <div>
                    Approving creates the vendor with a new vendor code, maps it to the category below and
                    creates its supplier login. You will get a one-time link for the supplier to set its password.
                  </div>
                </div>
                <label className="field">
                  <span className="lbl">Supplier login email *</span>
                  <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} disabled={busy} />
                </label>
                <label className="field">
                  <span className="lbl">Category *</span>
                  <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} disabled={busy}>
                    <option value="">Choose…</option>
                    {cats.map(c => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
                  </select>
                </label>
                <label className="field">
                  <span className="lbl">Note (optional)</span>
                  <input type="text" value={form.note} maxLength={500} onChange={e => setForm({ ...form, note: e.target.value })} disabled={busy} />
                </label>
                <div className="btn-row">
                  <button className="btn success" onClick={approve} disabled={busy || !form.email.trim() || !form.category} data-confirm-approve="">
                    {busy ? 'Approving…' : 'Approve and create login'}
                  </button>
                  <button className="btn ghost" onClick={() => setApproving(null)} disabled={busy}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <label className="field">
                  <span className="lbl">Reason *</span>
                  <textarea rows={3} value={form.reason} maxLength={1000} onChange={e => setForm({ ...form, reason: e.target.value })} disabled={busy} />
                </label>
                <div className="btn-row">
                  <button className="btn danger" onClick={reject} disabled={busy || !form.reason.trim()} data-confirm-reject="">
                    {busy ? 'Rejecting…' : 'Reject application'}
                  </button>
                  <button className="btn ghost" onClick={() => setRejecting(null)} disabled={busy}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
