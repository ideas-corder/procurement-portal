// `/supplier/tenders/:id` — one tender, and the supplier's ONE final bid.
//
// Flow: Prepare bid (joins the tender, which loads the line form) -> enter unit
// prices and terms -> optionally attach a document -> Review -> confirm that
// the bid is final -> submit. After that the bid is read-only.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Shell from '../../../components/Shell';
import { api, uploadFile } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import { TenderInfo } from '../../../components/tenders/TenderInfo';
import { type Tender, Icon, StatusBadge, fmtDate, money, timeLeft, fileSize } from '../../../components/tenders/kit';
import { SUPPLIER_TERM_OPTIONS, SUPPLIER_TERM_DEFAULTS } from '@procurement/workflow-engine';

type MyBid = {
  version: number; total: number | null; submittedAt: string; state: string;
  leadTimeDays: number | null; warrantyMonths: number | null; paymentTerms: string | null; remarks: string | null;
  lines: Array<{ lineNo: number; unitPrice: number | null }>;
  documents: Array<{ id: string; name: string }>;
};
type Detail = { tender: Tender; invitationId: string | null; eligible: boolean; canBid: boolean; myBid: MyBid | null };
type FormLine = { lineNo: number; description: string; qty: number; uom: string; unitPrice: number | null };

const OUTCOME: Record<string, { cls: string; label: string; note: string }> = {
  Won: { cls: 'won', label: 'You won this tender', note: 'Procurement will contact you with the purchase order.' },
  'Not selected': { cls: 'lost', label: 'Not selected', note: 'Another bid was selected this time. Thank you for bidding.' },
  'Tender closed': { cls: 'closed', label: 'Bidding closed', note: 'Bids are being evaluated. The result appears here once it is final.' },
  Submitted: { cls: 'draft', label: 'Bid submitted', note: 'Your bid is sealed until the deadline. It cannot be changed.' },
};

export default function SupplierTender() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const { session, ready } = useSession();
  const [d, setD] = useState<Detail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // bid form
  const [inv, setInv] = useState<string | null>(null);
  const [lines, setLines] = useState<FormLine[] | null>(null);
  const [terms, setTerms] = useState<{ leadTime: string; warranty: string; paymentTerms: string; remarks: string }>({
    leadTime: SUPPLIER_TERM_DEFAULTS.leadTime, warranty: SUPPLIER_TERM_DEFAULTS.warranty,
    paymentTerms: SUPPLIER_TERM_DEFAULTS.paymentTerms, remarks: '',
  });
  const [doc, setDoc] = useState<{ id: string; name: string; size: number | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function load() {
    try {
      const [r, m] = await Promise.all([
        api.get<Detail>(`/supplier/tenders/${id}`),
        api.get<{ myBids: Array<{ rfqId: string; status: string }> }>('/supplier/tenders'),
      ]);
      setD(r.data);
      setStatus(m.data.myBids.find(b => b.rfqId === id)?.status ?? null);
      setInv(r.data.invitationId);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace(`/?next=${encodeURIComponent(`/supplier/tenders/${id}`)}`); return; }
    if (id) load();
  }, [ready, session, id]);

  const total = useMemo(() => {
    if (!lines) return null;
    if (lines.some(l => l.unitPrice === null || !Number.isFinite(l.unitPrice))) return null;
    return lines.reduce((s, l) => s + (l.unitPrice as number) * l.qty, 0);
  }, [lines]);

  async function prepare() {
    setBusy('prepare'); setFormErr(null);
    try {
      let invitationId = inv;
      if (!invitationId) {
        const j = await api.post<{ invitationId: string }>(`/supplier/tenders/${id}/join`);
        invitationId = j.data.invitationId;
        setInv(invitationId);
      }
      const f = await api.get<any>(`/supplier/rfq/${invitationId}`);
      setLines((f.data.lines ?? []).map((l: any) => ({
        lineNo: l.lineNo, description: l.description, qty: Number(l.qty ?? 0), uom: l.uom, unitPrice: null,
      })));
    } catch (e: any) {
      setFormErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function attach(file: File | undefined) {
    if (!file) return;
    setBusy('upload'); setFormErr(null);
    try {
      const r = await uploadFile(`/supplier/tenders/${id}/documents`, file);
      setDoc({ id: r.id, name: file.name, size: r.size ?? file.size });
    } catch (e: any) {
      setFormErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!inv || !lines || total === null) return;
    setBusy('submit'); setFormErr(null);
    try {
      await api.post(`/supplier/rfq/${inv}/quote`, {
        lines: lines.map(l => ({ lineNo: l.lineNo, unitPrice: l.unitPrice })),
        totalAmount: total,
        leadTime: terms.leadTime, warranty: terms.warranty, paymentTerms: terms.paymentTerms,
        remarks: terms.remarks || undefined,
        ...(doc ? { attachmentId: doc.id } : {}),
      });
      setConfirming(false);
      setLines(null);
      await load();
    } catch (e: any) {
      setConfirming(false);
      setFormErr(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!ready || !session) return null;
  const t = d?.tender;
  const o = status ? OUTCOME[status] : null;

  return (
    <Shell title={t?.title ?? 'Tender'} screenId="supplier-tenders" subtitle={t ? `${t.rfqNumber} · closes ${fmtDate(t.deadlineAt)}` : undefined}>
      <p className="text-sm" style={{ marginBottom: 12 }}><Link href="/supplier/tenders">&larr; Back to tenders</Link></p>
      {err && <div className="alert danger">{err}</div>}
      {!d && !err && <div className="tp-empty">Loading…</div>}

      {d && t && (
        <div className="tp-detail">
          <TenderInfo t={t} />

          <div className="tp-sticky">
            <div className="card" data-bid-panel="">
              <div className="card-b">
                {/* ── already bid: read-only ── */}
                {d.myBid && (
                  <div data-my-bid-summary="">
                    {o && <div style={{ marginBottom: 8 }}><StatusBadge cls={o.cls}>{o.label}</StatusBadge></div>}
                    <div className="text-sm text-mute">Your bid</div>
                    <div className="tp-countdown">{money(d.myBid.total, t.currency)}</div>
                    <div className="text-sm text-mute" style={{ marginBottom: 10 }}>Submitted {fmtDate(d.myBid.submittedAt)}</div>
                    <table className="tp-table" style={{ marginBottom: 10 }}>
                      <tbody>
                        {d.myBid.lines.map(l => {
                          const tl = t.lines.find(x => x.lineNo === l.lineNo);
                          return (
                            <tr key={l.lineNo}>
                              <td>{tl?.description ?? `Line ${l.lineNo}`}</td>
                              <td style={{ textAlign: 'right' }} className="tp-money">{money(l.unitPrice, t.currency)} <span className="text-sm text-mute">/ {tl?.uom ?? 'unit'}</span></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <div className="text-sm" style={{ lineHeight: 1.8 }}>
                      Delivery <b>{d.myBid.leadTimeDays ?? '—'} days</b> · Warranty <b>{d.myBid.warrantyMonths ?? '—'} months</b><br />
                      Payment <b>{d.myBid.paymentTerms ?? '—'}</b>
                    </div>
                    {d.myBid.documents.map(x => (
                      <div key={x.id} className="tp-doc" style={{ marginTop: 8 }}><Icon name="doc" color="var(--accent)" /><span className="tp-doc-name">{x.name}</span></div>
                    ))}
                    {o && <p className="text-sm text-mute" style={{ marginTop: 10 }}>{o.note}</p>}
                  </div>
                )}

                {/* ── can bid ── */}
                {!d.myBid && d.canBid && !lines && (
                  <div>
                    <div className="text-sm text-mute">Bidding closes in</div>
                    <div className="tp-countdown">{timeLeft(t.deadlineAt).replace(' left', '')}</div>
                    <div className="text-sm text-mute" style={{ marginBottom: 14 }}>{fmtDate(t.deadlineAt)}</div>
                    {formErr && <div className="alert danger">{formErr}</div>}
                    <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={prepare}
                            disabled={busy === 'prepare'} data-prepare-bid="">
                      {busy === 'prepare' ? 'Opening…' : 'Prepare my bid'}
                    </button>
                    <ul className="text-sm text-mute" style={{ marginTop: 12, paddingLeft: 18, lineHeight: 1.7 }}>
                      <li>Your bid is sealed: nobody sees it before the deadline.</li>
                      <li>You can bid once. A submitted bid cannot be changed.</li>
                    </ul>
                  </div>
                )}

                {!d.myBid && d.canBid && lines && (
                  <div data-bid-form="">
                    <h3 style={{ fontSize: 16, fontWeight: 800, color: 'var(--navy)', marginBottom: 10 }}>Your bid</h3>
                    {formErr && <div className="alert danger">{formErr}</div>}
                    {lines.map((l, i) => (
                      <label key={l.lineNo} className="field" style={{ marginBottom: 10 }}>
                        <span className="lbl">{l.description} · {l.qty} {l.uom}</span>
                        <input type="number" min={0} step="0.01" placeholder={`Unit price (${t.currency})`}
                               value={l.unitPrice ?? ''} data-bid-price={l.lineNo}
                               onChange={e => {
                                 const v = e.target.value === '' ? null : Number(e.target.value);
                                 setLines(ls => ls!.map((x, j) => j === i ? { ...x, unitPrice: v } : x));
                               }} />
                      </label>
                    ))}
                    <div className="tp-fact" style={{ marginBottom: 12 }}>
                      <div className="tp-fact-l">Total</div>
                      <div className="tp-fact-v" data-bid-total="">{total === null ? 'Enter every unit price' : money(total, t.currency)}</div>
                    </div>
                    <div className="field-row">
                      <label className="field"><span className="lbl">Delivery</span>
                        <select value={terms.leadTime} onChange={e => setTerms({ ...terms, leadTime: e.target.value })}>
                          {SUPPLIER_TERM_OPTIONS.leadTime.map(x => <option key={x}>{x}</option>)}
                        </select>
                      </label>
                      <label className="field"><span className="lbl">Warranty</span>
                        <select value={terms.warranty} onChange={e => setTerms({ ...terms, warranty: e.target.value })}>
                          {SUPPLIER_TERM_OPTIONS.warranty.map(x => <option key={x}>{x}</option>)}
                        </select>
                      </label>
                    </div>
                    <label className="field"><span className="lbl">Payment terms</span>
                      <select value={terms.paymentTerms} onChange={e => setTerms({ ...terms, paymentTerms: e.target.value })}>
                        {SUPPLIER_TERM_OPTIONS.paymentTerms.map(x => <option key={x}>{x}</option>)}
                      </select>
                    </label>
                    <label className="field"><span className="lbl">Remarks (optional)</span>
                      <textarea rows={2} maxLength={2000} value={terms.remarks} onChange={e => setTerms({ ...terms, remarks: e.target.value })} />
                    </label>

                    <div className="lbl" style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Your quotation document (optional)</div>
                    {doc ? (
                      <div className="tp-doc" data-bid-doc="">
                        <Icon name="check" color="var(--success)" />
                        <span style={{ flex: 1 }}><span className="tp-doc-name">{doc.name}</span> <span className="text-sm text-mute">{fileSize(doc.size)}</span></span>
                        <button type="button" className="btn sm ghost" onClick={() => setDoc(null)}>Remove</button>
                      </div>
                    ) : (
                      <label className="tp-doc" style={{ cursor: 'pointer', borderStyle: 'dashed' }}>
                        <Icon name="upload" color="var(--accent)" />
                        <span className="text-sm">{busy === 'upload' ? 'Uploading…' : 'Attach PDF, Word, Excel or image'}</span>
                        <input type="file" style={{ display: 'none' }} data-bid-file=""
                               onChange={e => attach(e.target.files?.[0])} disabled={busy === 'upload'} />
                      </label>
                    )}

                    <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
                            disabled={total === null || busy !== null} onClick={() => setConfirming(true)} data-review-bid="">
                      Review bid
                    </button>
                  </div>
                )}

                {!d.myBid && !d.canBid && (
                  <div style={{ textAlign: 'center' }}>
                    <Icon name={t.accepting ? 'alert' : 'clock'} size={28} color="var(--text-mute)" />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>
                      {t.accepting ? 'Outside your registered categories' : 'Bidding is closed'}
                    </div>
                    <div className="text-sm text-mute">
                      {t.accepting ? 'Only suppliers registered in this category can bid.' : `Closed ${fmtDate(t.deadlineAt)}`}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {confirming && t && lines && (
        <div role="dialog" aria-modal="true"
             style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
             onClick={e => { if (e.target === e.currentTarget && !busy) setConfirming(false); }}>
          <div style={{ width: 480, maxWidth: '94vw', background: 'var(--surface)', borderRadius: 14, padding: 22, border: '1px solid var(--line)' }} data-confirm-bid="">
            <h3 style={{ fontSize: 18, fontWeight: 800, color: 'var(--navy)', marginBottom: 6 }}>Submit your final bid?</h3>
            <p className="text-sm text-mute" style={{ marginBottom: 12 }}>{t.title} · {t.rfqNumber}</p>
            <div className="tp-fact" style={{ marginBottom: 10 }}>
              <div className="tp-fact-l">Total</div><div className="tp-fact-v">{money(total, t.currency)}</div>
            </div>
            <div className="text-sm" style={{ marginBottom: 12 }}>
              {terms.leadTime} delivery · {terms.warranty} warranty · {terms.paymentTerms}{doc ? ` · document: ${doc.name}` : ' · no document attached'}
            </div>
            <div className="alert warn"><div><b>This bid is final.</b> Once submitted it cannot be changed or withdrawn.</div></div>
            <div className="btn-row">
              <button className="btn primary" onClick={submit} disabled={busy === 'submit'} data-submit-bid="">
                {busy === 'submit' ? 'Submitting…' : 'Yes, submit my bid'}
              </button>
              <button className="btn ghost" onClick={() => setConfirming(false)} disabled={busy === 'submit'}>Go back</button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}
