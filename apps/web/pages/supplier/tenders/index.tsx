// `/supplier/tenders` — the supplier's tender dashboard.
//
// Two tabs: Browse (open tenders in my categories I have not bid on) and My
// Tenders (every tender I have bid on, with its outcome). Card details come
// from the public tender board; what is MINE (eligibility, my bid, Won / Not
// selected) comes from GET /supplier/tenders.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Shell from '../../../components/Shell';
import { api } from '../../../lib/api';
import { useSession } from '../../../lib/session';
import {
  type Tender, TenderCard, StatTile, EmptyState, FilterBar, EMPTY_FILTER, applyFilter, categoriesOf,
  StatusBadge, money, HeroArt,
} from '../../../components/tenders/kit';

type Mine = {
  openTenders: Array<{ rfqId: string }>;
  myBids: Array<{ rfqId: string; invitationId: string; status: string; canBid: boolean; myBid: { version: number; total: number | null } | null }>;
};
type Inbox = { identity?: { legalName?: string; vendorCode?: string } };

const OUTCOME: Record<string, { cls: string; label: string }> = {
  Won: { cls: 'won', label: 'Won' },
  'Not selected': { cls: 'lost', label: 'Not selected' },
  Submitted: { cls: 'draft', label: 'Bid submitted' },
  'Tender closed': { cls: 'closed', label: 'Awaiting result' },
  'Not submitted': { cls: 'wait', label: 'Not bid yet' },
};

export default function SupplierTenders() {
  const router = useRouter();
  const { session, ready } = useSession();
  const [board, setBoard] = useState<Tender[] | null>(null);
  const [mine, setMine] = useState<Mine | null>(null);
  const [me, setMe] = useState<Inbox['identity'] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState(EMPTY_FILTER);
  const tab = router.query.tab === 'mine' ? 'mine' : 'browse';
  const setTab = (k: 'browse' | 'mine') =>
    router.replace({ pathname: router.pathname, query: k === 'browse' ? {} : { tab: k } }, undefined, { shallow: true });

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/?next=%2Fsupplier%2Ftenders'); return; }
    Promise.all([
      api.get<{ tenders: Tender[] }>('/public/tenders?status=all'),
      api.get<Mine>('/supplier/tenders'),
      api.get<Inbox>('/supplier/inbox').catch(() => ({ data: {} as Inbox })),
    ]).then(([b, m, i]) => {
      setBoard(b.data.tenders); setMine(m.data); setMe(i.data.identity ?? null); setErr(null);
    }).catch(e => setErr(e.message));
  }, [ready, session]);

  const byId = useMemo(() => new Map((board ?? []).map(t => [t.id, t])), [board]);
  const browse = useMemo(() => {
    if (!mine) return [];
    const ids = new Set([
      ...mine.openTenders.map(o => o.rfqId),
      // Opened but not bid yet, still open: still something to do.
      ...mine.myBids.filter(b => !b.myBid && b.canBid).map(b => b.rfqId),
    ]);
    return [...ids].map(id => byId.get(id)).filter((t): t is Tender => Boolean(t && t.accepting));
  }, [mine, byId]);
  const myTenders = useMemo(() => (mine?.myBids ?? [])
    .filter(b => b.myBid)
    .map(b => ({ b, t: byId.get(b.rfqId) }))
    .filter((x): x is { b: Mine['myBids'][number]; t: Tender } => Boolean(x.t)), [mine, byId]);

  const shownBrowse = useMemo(() => applyFilter(browse, f), [browse, f]);
  const shownMine = useMemo(() => {
    const keep = new Set(applyFilter(myTenders.map(x => x.t), f).map(t => t.id));
    return myTenders.filter(x => keep.has(x.t.id));
  }, [myTenders, f]);
  const cats = useMemo(() => categoriesOf(tab === 'browse' ? browse : myTenders.map(x => x.t)), [tab, browse, myTenders]);
  const won = myTenders.filter(x => x.b.status === 'Won').length;
  const pending = myTenders.filter(x => x.b.status === 'Submitted' || x.b.status === 'Tender closed').length;

  if (!ready || !session) return null;

  return (
    <Shell title="Tenders" screenId="supplier-tenders" subtitle={me?.legalName ? `${me.legalName} · ${me.vendorCode ?? ''}` : undefined}>
      <section className="tp-hero compact">
        <div>
          <h1>Find a tender, send your best offer</h1>
          <p>Open tenders in the categories you supply. One sealed bid per tender: attach your quotation and submit before the deadline.</p>
        </div>
        <div style={{ width: 200 }}><HeroArt /></div>
      </section>

      <div className="tp-stats">
        <StatTile icon="inbox" tone={['#DCFCE7', '#15803D']} n={mine ? browse.length : '–'} label="Open for you" active={tab === 'browse'} onClick={() => setTab('browse')} testId="browse" />
        <StatTile icon="doc" tone={['#E0F2FE', '#0369A1']} n={mine ? myTenders.length : '–'} label="My bids" active={tab === 'mine'} onClick={() => setTab('mine')} testId="mine" />
        <StatTile icon="clock" tone={['#FEF3C7', '#B45309']} n={mine ? pending : '–'} label="Awaiting result" testId="pending" />
        <StatTile icon="trophy" tone={['#EDE9FE', '#6D28D9']} n={mine ? won : '–'} label="Won" testId="won" />
      </div>

      <div className="tab-row" role="tablist" style={{ marginBottom: 12 }}>
        <button type="button" role="tab" aria-selected={tab === 'browse'} className={`tab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')} data-vendor-tab="browse">
          Browse tenders <span className="tab-count">{browse.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'mine'} className={`tab${tab === 'mine' ? ' active' : ''}`} onClick={() => setTab('mine')} data-vendor-tab="mine">
          My tenders <span className="tab-count">{myTenders.length}</span>
        </button>
      </div>

      <FilterBar f={f} set={setF} categories={cats} />

      {err && <div className="alert danger">{err}</div>}
      {!mine && !err && <div className="tp-empty">Loading your tenders…</div>}

      {mine && tab === 'browse' && (shownBrowse.length === 0 ? (
        <EmptyState title={browse.length ? 'No tender matches these filters' : 'No open tenders in your categories right now'}>
          New tenders appear here as soon as they are published. <a href="/open-tenders">See every public tender</a>.
        </EmptyState>
      ) : (
        <div className="tp-grid" data-vendor-browse="">
          {shownBrowse.map(t => (
            <TenderCard key={t.id} t={t} onOpen={() => router.push(`/supplier/tenders/${t.id}`)}
                        footerRight={<span className="btn sm primary">Bid now</span>} />
          ))}
        </div>
      ))}

      {mine && tab === 'mine' && (shownMine.length === 0 ? (
        <EmptyState title={myTenders.length ? 'No bid matches these filters' : 'You have not bid on a tender yet'}>
          Pick one from Browse tenders.
        </EmptyState>
      ) : (
        <div className="tp-grid" data-vendor-mine="">
          {shownMine.map(({ b, t }) => {
            const o = OUTCOME[b.status] ?? { cls: 'closed', label: b.status };
            return (
              <TenderCard key={t.id} t={t} onOpen={() => router.push(`/supplier/tenders/${t.id}`)}
                          badge={<StatusBadge cls={o.cls}>{o.label}</StatusBadge>}
                          footerRight={<span className="text-sm">My bid <b className="tp-money">{money(b.myBid?.total ?? null, t.currency)}</b></span>} />
            );
          })}
        </div>
      ))}
    </Shell>
  );
}
