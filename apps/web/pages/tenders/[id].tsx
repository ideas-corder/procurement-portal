// `/tenders/:id` — one tender for procurement: info, documents, and its bids.
//
// Before the deadline the bids are SEALED by the API (who has bid is shown,
// prices and documents are not). After it, the bids open and the next step
// is the existing CS flow, reached from here.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Shell from '../../components/Shell';
import { api, uploadFile, downloadFile } from '../../lib/api';
import { useSession } from '../../lib/session';
import { TenderInfo } from '../../components/tenders/TenderInfo';
import { type Tender, Icon, StatusBadge, fmtDate, money, timeLeft } from '../../components/tenders/kit';

type Bid = {
  vendorId: string; vendorCode: string; vendorName: string; joinedAt: string; submitted: boolean;
  submittedAt: string | null; state: string | null; total: number | null; currency: string;
  leadTimeDays: number | null; warrantyMonths: number | null; paymentTerms: string | null;
  attachments: Array<{ id: string; name: string }>; sealed?: boolean;
};
type Detail = {
  tender: Tender & { prId: string; prNumber: string; prStage: string; estimatedAmount: number | null; sealed: boolean };
  bids: Bid[];
  cs: { id: string; csNumber: string; state: string } | null;
};

const STAGE_LABEL: Record<string, string> = {
  IN_PROCUREMENT_REVIEW: 'Procurement review', QUOTES_RECEIVED: 'Quotes received (CS)',
  IN_FINANCE_REVIEW: 'Finance review', IN_MANAGEMENT_REVIEW: 'Management review', READY_FOR_D365: 'Ready for D365',
  D365_PUSHED: 'Pushed to D365', CS_LOCKED: 'CS locked', PACK_LOCKED: 'Pack locked',
};

export default function TenderDetail() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const { session, ready } = useSession();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.get<Detail>(`/tenders/${id}`).then(r => { setD(r.data); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    if (id) load();
  }, [ready, session, id]);

  async function addDocs(files: FileList | null) {
    if (!files?.length) return;
    setBusy('upload'); setErr(null);
    try {
      for (const f of Array.from(files)) await uploadFile(`/tenders/${id}/documents`, f);
      setMsg(`${files.length} document(s) published with the tender.`);
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }
  async function removeDoc(docId: string) {
    setBusy(docId); setErr(null);
    try { await api.del(`/tenders/${id}/documents/${docId}`); await load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }
  async function readyForCs() {
    if (!d) return;
    setBusy('cs'); setErr(null);
    try {
      await api.post(`/pr/${d.tender.prId}/ready-for-cs`, { remarks: `Tender ${d.tender.rfqNumber} closed` });
      setMsg('Sent to CS. Open the comparative statement to evaluate the bids.');
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  if (!ready || !session) return null;
  const t = d?.tender;
  const submitted = d?.bids.filter(b => b.submitted) ?? [];
  const lowest = submitted.filter(b => b.total !== null).sort((a, b) => (a.total as number) - (b.total as number))[0];

  return (
    <Shell title={t?.title ?? 'Tender'} screenId="tenders" subtitle={t ? `${t.rfqNumber} · request ${t.prNumber}` : undefined}>
      <p className="text-sm" style={{ marginBottom: 12 }}><Link href="/tenders">&larr; Tender Management</Link></p>
      {msg && <div className="alert success">{msg}</div>}
      {err && <div className="alert danger">{err}</div>}
      {!d && !err && <div className="tp-empty">Loading…</div>}

      {d && t && (
        <>
          <div className="tp-detail">
            <TenderInfo t={t} docActions={t.accepting ? (docId) => (
              <button className="btn sm ghost" onClick={() => removeDoc(docId)} disabled={busy === docId} title="Unpublish this document">Remove</button>
            ) : undefined}>
              {t.accepting && (
                <label className="tp-doc" style={{ cursor: 'pointer', borderStyle: 'dashed', marginTop: 8 }}>
                  <Icon name="upload" color="var(--accent)" />
                  <span className="text-sm">{busy === 'upload' ? 'Uploading…' : 'Add tender documents'}</span>
                  <input type="file" multiple style={{ display: 'none' }} onChange={e => addDocs(e.target.files)} data-tm-add-doc="" />
                </label>
              )}
            </TenderInfo>

            <div className="tp-sticky">
              <div className="card">
                <div className="card-b">
                  <div className="text-sm text-mute">{t.accepting ? 'Bidding closes in' : 'Bidding closed'}</div>
                  <div className="tp-countdown">{t.accepting ? timeLeft(t.deadlineAt).replace(' left', '') : fmtDate(t.deadlineAt, false)}</div>
                  <div className="tp-facts" style={{ margin: '12px 0' }}>
                    <div className="tp-fact"><div className="tp-fact-l">Bids</div><div className="tp-fact-v" data-tm-bids="">{submitted.length}</div></div>
                    <div className="tp-fact"><div className="tp-fact-l">Opened by</div><div className="tp-fact-v">{d.bids.length}</div></div>
                    <div className="tp-fact"><div className="tp-fact-l">Estimate</div><div className="tp-fact-v">{money(t.estimatedAmount, t.currency)}</div></div>
                    <div className="tp-fact"><div className="tp-fact-l">Lowest bid</div><div className="tp-fact-v">{t.sealed ? 'Sealed' : money(lowest?.total ?? null, t.currency)}</div></div>
                  </div>
                  <div className="text-sm" style={{ marginBottom: 10 }}>
                    Request stage: <b>{STAGE_LABEL[t.prStage] ?? t.prStage}</b>
                  </div>
                  {!t.accepting && t.prStage === 'IN_PROCUREMENT_REVIEW' && submitted.length > 0 && (
                    <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}
                            onClick={readyForCs} disabled={busy === 'cs'} data-tm-ready-cs="">
                      {busy === 'cs' ? 'Sending…' : 'Send to CS for evaluation'}
                    </button>
                  )}
                  {!t.accepting && t.prStage !== 'IN_PROCUREMENT_REVIEW' && (
                    <Link href={`/cs/${t.prId}`} className="btn primary" style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }}>
                      {d.cs ? `Open ${d.cs.csNumber}` : 'Open the comparative statement'}
                    </Link>
                  )}
                  <Link href={`/pr/${t.prId}`} className="btn" style={{ width: '100%', justifyContent: 'center' }}>Open the request</Link>
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }} data-tm-bid-table="">
            <div className="card-h">
              <h3>Bids</h3>
              {t.sealed && <span className="pill info">Sealed until {fmtDate(t.deadlineAt)}</span>}
            </div>
            <div className="card-b" style={{ padding: 0 }}>
              {d.bids.length === 0 ? (
                <div className="tp-empty" style={{ border: 0 }}>No supplier has opened this tender yet.</div>
              ) : (
                <table className="tp-table">
                  <thead><tr>
                    <th>Supplier</th><th>Status</th><th style={{ textAlign: 'right' }}>Total</th>
                    <th>Delivery</th><th>Warranty</th><th>Payment</th><th>Document</th>
                  </tr></thead>
                  <tbody>
                    {d.bids.map(b => (
                      <tr key={b.vendorId} className={!t.sealed && lowest && b.vendorId === lowest.vendorId ? 'best' : ''}>
                        <td><b>{b.vendorName}</b><div className="text-sm text-mute">{b.vendorCode}</div></td>
                        <td>
                          {b.submitted
                            ? <StatusBadge cls={b.state === 'Awarded' ? 'won' : 'draft'}>{b.state === 'Awarded' ? 'Awarded' : 'Bid in'}</StatusBadge>
                            : <StatusBadge cls="wait">Opened, no bid</StatusBadge>}
                          {b.submittedAt && <div className="text-sm text-mute">{fmtDate(b.submittedAt)}</div>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {!b.submitted ? '—' : b.total === null ? <span className="pill draft">Sealed</span> : <span className="tp-money">{money(b.total, b.currency)}</span>}
                          {!t.sealed && lowest && b.vendorId === lowest.vendorId && <div className="text-sm" style={{ color: 'var(--success)', fontWeight: 700 }}>Lowest</div>}
                        </td>
                        <td>{b.leadTimeDays !== null ? `${b.leadTimeDays} d` : '—'}</td>
                        <td>{b.warrantyMonths !== null ? `${b.warrantyMonths} mo` : '—'}</td>
                        <td>{b.paymentTerms ?? '—'}</td>
                        <td>
                          {b.attachments.length === 0 ? <span className="text-sm text-mute">{t.sealed && b.submitted ? 'Sealed' : '—'}</span> :
                            b.attachments.map(a => (
                              <button key={a.id} className="btn sm ghost" onClick={() => downloadFile(a.id, a.name)}>
                                <Icon name="download" size={14} /> {a.name.replace(/^V-\d+__/, '')}
                              </button>
                            ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
