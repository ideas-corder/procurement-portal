// `/tenders/requests` — Tender Requests, for HODs and requesters.
//
// HOD: the tender requests waiting for their approval, approved in one click
// (all lines; the full request page is one link away for partial decisions or
// a rejection). Requester: their tender requests and where each one is.
// Approval is the same POST /pr/:id/advance any PR uses.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Shell from '../../components/Shell';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { CategoryIcon, EmptyState, Icon, StatTile, StatusBadge, fmtDate, money } from '../../components/tenders/kit';

type Req = {
  prId: string; prNumber: string; title: string; stage: string; estimatedAmount: number | null;
  createdAt: string; requiredBy: string | null; requester: string; mine: boolean; awaitingMe: boolean;
  department: string | null;
  lines: Array<{ lineNo: number; description: string | null; quantity: number | null; uom: string | null; category: string | null; unitPriceEst: number | null }>;
  tender: { id: string; rfqNumber: string; state: string; deadlineAt: string; accepting: boolean } | null;
};

const STEPS = ['HOD approval', 'Ready to publish', 'Bidding', 'Evaluation', 'Approvals', 'Done'];
/** Where a tender request is, as an index into STEPS (-1 = rejected). */
function stepOf(r: Req): number {
  if (['REJECTED', 'Rejected', 'Cancelled'].includes(r.stage)) return -1;
  if (r.stage === 'D365_PUSHED') return 5;
  if (['IN_FINANCE_REVIEW', 'IN_MANAGEMENT_REVIEW', 'READY_FOR_D365', 'CS_LOCKED', 'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED'].includes(r.stage)) return 4;
  if (r.tender && !r.tender.accepting) return 3;
  if (r.tender?.accepting) return 2;
  if (r.stage === 'IN_PROCUREMENT_REVIEW') return 1;
  return 0;
}

function Timeline({ r }: { r: Req }) {
  const s = stepOf(r);
  if (s === -1) return <StatusBadge cls="lost">Rejected</StatusBadge>;
  return (
    <div className="tp-timeline">
      {STEPS.map((x, i) => <span key={x} className={`tp-tl${i < s ? ' done' : i === s ? ' now' : ''}`}>{x}</span>)}
    </div>
  );
}

export default function TenderRequests() {
  const router = useRouter();
  const { session, ready } = useSession();
  const [rows, setRows] = useState<Req[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.get<{ requests: Req[] }>('/tenders/requests').then(r => { setRows(r.data.requests); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session]);

  const role = session?.user?.role ?? '';
  const waiting = useMemo(() => (rows ?? []).filter(r => r.awaitingMe && r.stage === 'IN_HOD_REVIEW'), [rows]);
  const others = useMemo(() => (rows ?? []).filter(r => !(r.awaitingMe && r.stage === 'IN_HOD_REVIEW')), [rows]);
  const inBidding = (rows ?? []).filter(r => stepOf(r) === 2).length;
  const done = (rows ?? []).filter(r => stepOf(r) === 5).length;

  async function approve(r: Req) {
    setBusy(r.prId); setErr(null); setMsg(null);
    try {
      await api.post(`/pr/${r.prId}/advance`, {
        lineDecisions: Object.fromEntries(r.lines.map((_, i) => [i, 'approved'])),
        reason: 'Tender request approved',
      });
      setMsg(`${r.prNumber} approved. Procurement can now publish it as a tender.`);
      await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  if (!ready || !session) return null;

  return (
    <Shell title="Tender Requests" screenId="tender-requests"
           subtitle={role === 'hod' ? 'Requests to buy through an open tender, for your approval' : 'Your requests to buy through an open tender'}
           actions={role === 'requester' || role === 'admin' ? <Link href="/tenders/request" className="btn primary" data-new-tender-request="">+ New tender request</Link> : undefined}>
      {msg && <div className="alert success" data-tr-msg="">{msg}</div>}
      {err && <div className="alert danger">{err}</div>}

      <div className="tp-stats">
        {role === 'hod' && <StatTile icon="inbox" tone={['#FEF3C7', '#B45309']} n={rows ? waiting.length : '–'} label="Waiting for you" testId="waiting" />}
        <StatTile icon="doc" tone={['#E0F2FE', '#0369A1']} n={rows ? rows.length : '–'} label="Tender requests" testId="total" />
        <StatTile icon="clock" tone={['#DCFCE7', '#15803D']} n={rows ? inBidding : '–'} label="Open for bids" testId="bidding" />
        <StatTile icon="trophy" tone={['#EDE9FE', '#6D28D9']} n={rows ? done : '–'} label="Completed" testId="done" />
      </div>

      {!rows && !err && <div className="tp-empty">Loading…</div>}

      {rows && role === 'hod' && (
        <>
          <div className="tp-section-h"><h2>Waiting for your approval</h2></div>
          {waiting.length === 0 ? (
            <EmptyState title="Nothing to approve">Tender requests from your department appear here.</EmptyState>
          ) : (
            <div className="tp-grid" style={{ marginBottom: 20 }} data-tr-waiting="">
              {waiting.map(r => (
                <div key={r.prId} className="tp-card" style={{ cursor: 'default' }} data-tr={r.prNumber}>
                  <div className="tp-card-top">
                    <CategoryIcon code={r.lines[0]?.category} />
                    <div style={{ flex: 1 }}>
                      <div className="tp-card-title">{r.title}</div>
                      <div className="tp-card-ref">{r.prNumber} · {r.requester} · {fmtDate(r.createdAt, false)}</div>
                    </div>
                    <StatusBadge cls="wait">Needs approval</StatusBadge>
                  </div>
                  <table className="tp-table">
                    <tbody>
                      {r.lines.map(l => (
                        <tr key={l.lineNo}>
                          <td>{l.description ?? 'Item'}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{l.quantity} {l.uom}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className="text-mute">{money(l.unitPriceEst)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="tp-card-foot">
                    <span className="text-sm">Estimate <b className="tp-money">{money(r.estimatedAmount)}</b></span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <Link href={`/pr/${r.prId}`} className="btn sm ghost">Review in detail</Link>
                      <button className="btn sm success" onClick={() => approve(r)} disabled={busy === r.prId} data-tr-approve={r.prNumber}>
                        {busy === r.prId ? 'Approving…' : 'Approve'}
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {rows && (
        <>
          <div className="tp-section-h"><h2>{role === 'hod' ? 'All tender requests' : 'My tender requests'}</h2></div>
          {others.length === 0 ? (
            <EmptyState title="No tender requests yet">
              {role === 'requester' ? <Link href="/tenders/request">Raise your first tender request</Link> : 'They appear here once raised.'}
            </EmptyState>
          ) : (
            <div className="card" data-tr-all="">
              <div className="card-b" style={{ padding: 0 }}>
                <table className="tp-table">
                  <thead><tr><th>Request</th><th>Estimate</th><th>Progress</th><th>Tender</th><th></th></tr></thead>
                  <tbody>
                    {others.map(r => (
                      <tr key={r.prId} data-tr-row={r.prNumber}>
                        <td>
                          <b>{r.title}</b>
                          <div className="text-sm text-mute">{r.prNumber} · {r.requester} · {fmtDate(r.createdAt, false)}</div>
                        </td>
                        <td className="tp-money">{money(r.estimatedAmount)}</td>
                        <td><Timeline r={r} /></td>
                        <td className="text-sm">
                          {r.tender ? <><span className="mono">{r.tender.rfqNumber}</span><div className="text-mute">{r.tender.accepting ? `closes ${fmtDate(r.tender.deadlineAt)}` : 'closed'}</div></> : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Link href={`/pr/${r.prId}`} className="btn sm ghost"><Icon name="doc" size={14} /> Open</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
