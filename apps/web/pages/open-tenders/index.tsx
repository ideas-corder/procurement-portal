// `/open-tenders` — the public tender board. No login.
//
// Anyone can browse every open tender, its budget, deposit, items and
// documents. To bid, a company registers on the onboarding form, is approved,
// and signs in to its supplier dashboard.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { api } from '../../lib/api';
import PublicFrame, { ONBOARDING_URL } from '../../components/tenders/PublicFrame';
import {
  type Tender, TenderCard, StatTile, HeroArt, EmptyState, FilterBar, EMPTY_FILTER, applyFilter, categoriesOf,
} from '../../components/tenders/kit';

type Board = { tenders: Tender[]; stats: { open: number; closingSoon: number; suppliers: number } };

export default function OpenTenders() {
  const router = useRouter();
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [data, setData] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState(EMPTY_FILTER);

  useEffect(() => {
    setData(null);
    api.get<Board>(`/public/tenders?status=${status}`)
      .then(r => { setData(r.data); setErr(null); })
      .catch(e => setErr(e.message));
  }, [status]);

  const list = useMemo(() => applyFilter(data?.tenders ?? [], f), [data, f]);
  const cats = useMemo(() => categoriesOf(data?.tenders ?? []), [data]);

  return (
    <PublicFrame>
      <section className="tp-hero">
        <div>
          <h1>Open tenders from PakBoxes</h1>
          <p>
            Browse what we are buying, download the tender documents and send your best offer before
            the deadline. Every bid is sealed: no supplier sees another&apos;s price.
          </p>
          <div className="tp-hero-actions">
            <a href={ONBOARDING_URL} className="btn light">Register as a supplier</a>
            <a href="/?next=%2Fsupplier%2Ftenders" className="btn outline-light">Already registered? Sign in</a>
          </div>
        </div>
        <HeroArt />
      </section>

      <div className="tp-stats">
        <StatTile icon="inbox" tone={['#DCFCE7', '#15803D']} n={data?.stats.open ?? '–'} label="Open tenders" testId="open" />
        <StatTile icon="clock" tone={['#FEF3C7', '#B45309']} n={data?.stats.closingSoon ?? '–'} label="Closing in 3 days" testId="soon" />
        <StatTile icon="users" tone={['#E0F2FE', '#0369A1']} n={data?.stats.suppliers ?? '–'} label="Registered suppliers" testId="suppliers" />
      </div>

      <div className="tp-section-h">
        <h2>{status === 'open' ? 'Tenders open for bidding' : 'Recently closed tenders'}</h2>
        <div className="tp-chip-row">
          <button type="button" className={`tp-chip${status === 'open' ? ' on' : ''}`} onClick={() => setStatus('open')} data-public-status="open">Open</button>
          <button type="button" className={`tp-chip${status === 'closed' ? ' on' : ''}`} onClick={() => setStatus('closed')} data-public-status="closed">Closed</button>
        </div>
      </div>

      <FilterBar f={f} set={setF} categories={cats} />

      {err && <div className="alert danger">{err}</div>}
      {!data && !err && <div className="tp-empty">Loading tenders…</div>}
      {data && list.length === 0 && (
        <EmptyState title={data.tenders.length ? 'No tender matches these filters' : 'No open tenders right now'}>
          {data.tenders.length ? 'Try clearing a filter.' : 'New tenders appear here as soon as they are published.'}
        </EmptyState>
      )}
      {data && list.length > 0 && (
        <div className="tp-grid" data-public-tenders="">
          {list.map(t => (
            <TenderCard key={t.id} t={t} onOpen={() => router.push(`/open-tenders/${t.id}`)}
                        footerRight={<span className="btn sm">View tender</span>} />
          ))}
        </div>
      )}

      <div className="tp-steps">
        {[
          ['Register', 'Fill in the supplier form with your company, NTN and the category you supply.'],
          ['Get approved', 'Our procurement team reviews your application and sends you a sign-in link.'],
          ['Bid', 'Sign in, open a tender in your category, attach your quotation and submit before the deadline.'],
        ].map(([h, p], i) => (
          <div className="tp-step" key={h}>
            <div className="tp-step-n">{i + 1}</div>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{h}</div>
            <div className="text-sm text-mute">{p}</div>
          </div>
        ))}
      </div>
    </PublicFrame>
  );
}
