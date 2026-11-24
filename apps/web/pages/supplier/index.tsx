// `supplier-rfq` — the Supplier RFQ Inbox, plus open tenders.
//
// Port of renderSupplierInbox (prototype line 9001-9035). Gated to role
// 'vendor' by the sidebar's data-roles, and by SupplierGuard server-side — the
// nav entry is a convenience, the guard is the boundary.
//
// Three tabs:
//   Invited RFQs  — the original inbox (GET /supplier/inbox), invited RFQs only
//   Open Tenders  — tenders in my categories I can still join (GET /supplier/tenders)
//   My Bids       — tenders I have joined, open or closed
// `?tab=tenders|bids|invited` selects one, so a link can land on it.
//
// The page holds NO business logic. Every number a supplier sees was computed
// on the server, so this screen cannot disagree with the API.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import {
  SupplierKpiBand, SupplierInboxList, type InboxData,
} from '../../components/supplier/SupplierCards';
import {
  OpenTendersList, MyBidsList, type TendersData,
} from '../../components/supplier/TenderCards';

type TabKey = 'invited' | 'tenders' | 'bids';
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'invited', label: 'Invited RFQs' },
  { key: 'tenders', label: 'Open Tenders' },
  { key: 'bids', label: 'My Bids' },
];

export default function SupplierInbox() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [data, setData] = useState<InboxData | null>(null);
  const [tenders, setTenders] = useState<TendersData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tenderErr, setTenderErr] = useState<string | null>(null);
  const [joining, setJoining] = useState<string | null>(null);

  const q = String(router.query.tab ?? '');
  const tab: TabKey = q === 'tenders' || q === 'bids' ? q : 'invited';
  const setTab = (k: TabKey) =>
    router.replace({ pathname: router.pathname, query: k === 'invited' ? {} : { tab: k } }, undefined, { shallow: true });

  const loadTenders = useCallback(() => {
    api.get<TendersData>('/supplier/tenders')
      .then(r => { setTenders(r.data); setTenderErr(null); })
      .catch(e => setTenderErr(e.message));
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    api.get<InboxData>('/supplier/inbox')
      .then(r => setData(r.data))
      .catch(e => setErr(e.message));
    loadTenders();
  }, [ready, session, loadTenders]);

  if (!ready) return null;
  if (!session) return null;

  // Tender invitations are listed under My Bids, so the inbox shows invited
  // RFQs only. The KPI band stays as the server computed it.
  const invited: InboxData | null = data
    ? (() => {
        const invitations = data.invitations.filter(i => i.sourcingMode !== 'open_tender');
        return { ...data, invitations, empty: data.empty || invitations.length === 0 };
      })()
    : null;

  const counts: Record<TabKey, number> = {
    invited: invited?.invitations.length ?? 0,
    tenders: tenders?.openTenders.length ?? 0,
    bids: tenders?.myBids.length ?? 0,
  };

  async function bid(rfqId: string) {
    setJoining(rfqId); setTenderErr(null);
    try {
      const r = await api.post<{ invitationId: string }>(`/supplier/tenders/${rfqId}/join`);
      router.push(`/supplier/${r.data.invitationId}`);
    } catch (e: any) {
      setTenderErr(e.message || 'Could not open this tender.');
      loadTenders();
    } finally {
      setJoining(null);
    }
  }

  // A back-office session can reach this URL by typing it. The API refuses with
  // 403 and the message says why; rendering the refusal is better than a blank
  // screen, and better than a redirect that hides the reason.
  return (
    <Shell title="Supplier RFQ Inbox" screenId="supplier-rfq" subtitle={data?.subtitle}>
      {err && <div className="alert danger">{err}</div>}

      <div className="tab-row" role="tablist" aria-label="Supplier inbox sections" style={{ marginBottom: 12 }}>
        {TABS.map(t => {
          const on = t.key === tab;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={on}
              className={`tab${on ? ' active' : ''}${counts[t.key] === 0 && !on ? ' empty' : ''}`}
              onClick={() => setTab(t.key)}
              data-supplier-tab={t.key}
            >
              {t.label}
              <span className="tab-count">{counts[t.key]}</span>
            </button>
          );
        })}
      </div>

      {tab === 'invited' && (
        <>
          {!err && !data && <div className="card"><div className="card-b empty-state">Loading&hellip;</div></div>}
          {data && !data.empty && <SupplierKpiBand kpis={data.kpis} />}
          {invited && (
            <SupplierInboxList
              data={invited}
              onQuote={(id) => router.push(`/supplier/${id}`)}
            />
          )}
        </>
      )}

      {tab !== 'invited' && (
        <>
          {tenderErr && <div className="alert danger" style={{ marginBottom: 12 }}>{tenderErr}</div>}
          {!tenders && !tenderErr && <div className="card"><div className="card-b empty-state">Loading&hellip;</div></div>}
          {tenders && tab === 'tenders' && (
            <OpenTendersList tenders={tenders.openTenders} onBid={bid} busyId={joining} />
          )}
          {tenders && tab === 'bids' && (
            <MyBidsList bids={tenders.myBids} onOpen={(id) => router.push(`/supplier/${id}`)} />
          )}
        </>
      )}
    </Shell>
  );
}
