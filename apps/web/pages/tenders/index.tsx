// `/tenders` — Tender Management (procurement, CS).
//
// The tender flow on its own screen: tender requests the HOD approved and that
// are waiting to be published, then every tender by stage. Publishing reuses
// the PR's POST /pr/:id/tender (PostTenderModal); everything after it — bids,
// CS, finance, D365 — is the same workflow as before.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Shell from '../../components/Shell';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import PostTenderModal from '../../components/sourcing/PostTenderModal';
import {
  type Tender, TenderCard, StatTile, EmptyState, FilterBar, EMPTY_FILTER, applyFilter, categoriesOf,
  StatusBadge, money, fmtDate, CategoryIcon, Icon,
} from '../../components/tenders/kit';

type Ready = {
  prId: string; prNumber: string; title: string; estimatedAmount: number | null; requester: string;
  department: string | null; createdAt: string; requiredBy: string | null;
  lines: Array<{ lineNo: number; description: string | null; quantity: number | null; uom: string | null; category: string | null }>;
};
type ManagedTender = Tender & {
  prId: string; prNumber: string; prStage: string; estimatedAmount: number | null;
  biddersJoined: number; bids: number; lowestBid: number | null; awardedTo: string | null;
};
type Overview = { readyToPublish: Ready[]; tenders: ManagedTender[] };
type View = 'ready' | 'open' | 'closed' | 'awarded' | 'all';

export default function TenderManagement() {
  const router = useRouter();
  const { session, ready } = useSession();
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<Ready | null>(null);
  const [f, setF] = useState(EMPTY_FILTER);
  const q = String(router.query.view ?? '');
  const view: View = (['ready', 'open', 'closed', 'awarded', 'all'] as View[]).includes(q as View) ? q as View : 'open';
  const setView = (v: View) => router.replace({ pathname: router.pathname, query: { view: v } }, undefined, { shallow: true });

  const load = () => api.get<Overview>('/tenders/overview').then(r => { setData(r.data); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session]);

  // Land on Ready to publish when something is waiting and no view was chosen.
  useEffect(() => {
    if (data && !router.query.view && data.readyToPublish.length > 0) setView('ready');
  }, [data]);

  const groups = useMemo(() => {
    const t = data?.tenders ?? [];
    return {
      open: t.filter(x => x.accepting),
      closed: t.filter(x => !x.accepting && x.status !== 'Awarded' && !x.awardedTo),
      awarded: t.filter(x => !x.accepting && (x.status === 'Awarded' || Boolean(x.awardedTo))),
      all: t,
    };
  }, [data]);
  const list = view === 'ready' ? [] : groups[view];
  const shown = useMemo(() => applyFilter(list, f), [list, f]);
  const cats = useMemo(() => categoriesOf(data?.tenders ?? []), [data]);

  if (!ready || !session) return null;
  const allowed = ['procurement', 'cs', 'admin'].includes(session.user.role);

  return (
    <Shell title="Tender Management" screenId="tenders" subtitle="Publish tender requests and follow every tender to award">
      {!allowed && <div className="card"><div className="card-b">Tender management is for Procurement and CS.</div></div>}
      {allowed && (
        <>
          {msg && <div className="alert success" data-tm-msg="">{msg}</div>}
          {err && <div className="alert danger">{err}</div>}

          <div className="tp-stats">
            <StatTile icon="inbox" tone={['#E0F2FE', '#0369A1']} n={data ? data.readyToPublish.length : '–'} label="Ready to publish" active={view === 'ready'} onClick={() => setView('ready')} testId="ready" />
            <StatTile icon="clock" tone={['#DCFCE7', '#15803D']} n={data ? groups.open.length : '–'} label="Open for bids" active={view === 'open'} onClick={() => setView('open')} testId="open" />
            <StatTile icon="doc" tone={['#FEF3C7', '#B45309']} n={data ? groups.closed.length : '–'} label="Closed, to evaluate" active={view === 'closed'} onClick={() => setView('closed')} testId="closed" />
            <StatTile icon="trophy" tone={['#EDE9FE', '#6D28D9']} n={data ? groups.awarded.length : '–'} label="Awarded" active={view === 'awarded'} onClick={() => setView('awarded')} testId="awarded" />
          </div>

          {!data && !err && <div className="tp-empty">Loading tenders…</div>}

          {data && view === 'ready' && (
            <>
              <div className="tp-section-h"><h2>Tender requests approved by the HOD</h2></div>
              {data.readyToPublish.length === 0 ? (
                <EmptyState title="Nothing waiting to be published">Approved tender requests appear here.</EmptyState>
              ) : (
                <div className="tp-grid" data-ready-list="">
                  {data.readyToPublish.map(r => (
                    <div key={r.prId} className="tp-card" style={{ cursor: 'default' }} data-ready={r.prNumber}>
                      <div className="tp-card-top">
                        <CategoryIcon code={r.lines[0]?.category} />
                        <div style={{ flex: 1 }}>
                          <div className="tp-card-title">{r.title}</div>
                          <div className="tp-card-ref">{r.prNumber} · {r.department ?? '—'} · {r.requester}</div>
                        </div>
                        <StatusBadge cls="draft">Ready</StatusBadge>
                      </div>
                      <div className="tp-card-meta">
                        <span><Icon name="wallet" size={13} /> Estimate <b>{money(r.estimatedAmount)}</b></span>
                        <span><Icon name="tag" size={13} /> {r.lines.length} item{r.lines.length === 1 ? '' : 's'}</span>
                        {r.requiredBy && <span><Icon name="clock" size={13} /> Needed by {fmtDate(r.requiredBy, false)}</span>}
                      </div>
                      <div className="text-sm text-mute">
                        {r.lines.slice(0, 3).map(l => `${l.description ?? 'Item'} × ${l.quantity ?? '?'}`).join(' · ')}
                        {r.lines.length > 3 ? ` · +${r.lines.length - 3} more` : ''}
                      </div>
                      <div className="tp-card-foot">
                        <a className="text-sm" href={`/pr/${r.prId}`}>Open request</a>
                        <button className="btn sm primary" onClick={() => { setMsg(null); setPublishing(r); }} data-publish={r.prNumber}>
                          Publish tender
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {data && view !== 'ready' && (
            <>
              <FilterBar f={f} set={setF} categories={cats} extra={
                <div className="tp-chip-row">
                  <button type="button" className={`tp-chip${view === 'all' ? ' on' : ''}`} onClick={() => setView('all')}>All <span className="tp-chip-n">{groups.all.length}</span></button>
                </div>
              } />
              {shown.length === 0 ? (
                <EmptyState title={list.length ? 'No tender matches these filters' : 'No tenders here yet'} />
              ) : (
                <div className="tp-grid" data-tm-list={view}>
                  {shown.map(t => (
                    <TenderCard key={t.id} t={t} onOpen={() => router.push(`/tenders/${t.id}`)}
                      badge={t.awardedTo ? <StatusBadge cls="awarded">Awarded</StatusBadge> : undefined}
                      footerRight={
                        <span className="text-sm">
                          <b>{t.bids}</b> bid{t.bids === 1 ? '' : 's'}
                          {t.lowestBid !== null && <> · lowest <b className="tp-money">{money(t.lowestBid, t.currency)}</b></>}
                          {t.accepting && t.bids > 0 && <> · <span className="text-mute">sealed</span></>}
                        </span>
                      }>
                      {t.awardedTo && <div className="text-sm"><Icon name="trophy" size={13} color="#6D28D9" /> Awarded to <b>{t.awardedTo}</b></div>}
                    </TenderCard>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {publishing && (
        <PostTenderModal
          prId={publishing.prId}
          prNumber={publishing.prNumber}
          prTitle={publishing.title}
          onClose={() => setPublishing(null)}
          onPosted={(m) => { setPublishing(null); setMsg(m); load().then(() => setView('open')); }}
        />
      )}
    </Shell>
  );
}
