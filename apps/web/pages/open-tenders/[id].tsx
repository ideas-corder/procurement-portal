// `/open-tenders/:id` — one tender, public. Documents download without login.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import PublicFrame, { ONBOARDING_URL } from '../../components/tenders/PublicFrame';
import { TenderInfo } from '../../components/tenders/TenderInfo';
import { type Tender, Icon, fmtDate, timeLeft } from '../../components/tenders/kit';

export default function OpenTender() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  const { session } = useSession();
  const [t, setT] = useState<Tender | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.get<Tender>(`/public/tenders/${id}`).then(r => setT(r.data)).catch(e => setErr(e.message));
  }, [id]);

  const isVendor = session?.user?.role === 'vendor';
  const bidHref = `/supplier/tenders/${id}`;

  return (
    <PublicFrame>
      <p className="text-sm" style={{ marginBottom: 12 }}><Link href="/open-tenders">&larr; All tenders</Link></p>
      {err && <div className="alert danger">{err}</div>}
      {!t && !err && <div className="tp-empty">Loading…</div>}
      {t && (
        <div className="tp-detail">
          <TenderInfo t={t} />
          <div className="tp-sticky">
            <div className="card" data-public-bid-panel="">
              <div className="card-b">
                {t.accepting ? (
                  <>
                    <div className="text-sm text-mute">Bidding closes in</div>
                    <div className="tp-countdown">{timeLeft(t.deadlineAt).replace(' left', '')}</div>
                    <div className="text-sm text-mute" style={{ marginBottom: 14 }}>{fmtDate(t.deadlineAt)}</div>
                    {isVendor ? (
                      <Link href={bidHref} className="btn primary" style={{ width: '100%', justifyContent: 'center' }}>
                        Open in my dashboard to bid
                      </Link>
                    ) : (
                      <>
                        <a href={`/?next=${encodeURIComponent(bidHref)}`} className="btn primary"
                           style={{ width: '100%', justifyContent: 'center', marginBottom: 8 }} data-signin-to-bid="">
                          Sign in to bid
                        </a>
                        <a href={ONBOARDING_URL} className="btn" style={{ width: '100%', justifyContent: 'center' }}>
                          New supplier? Register first
                        </a>
                      </>
                    )}
                    <ul className="text-sm text-mute" style={{ marginTop: 14, paddingLeft: 18, lineHeight: 1.7 }}>
                      <li>Only registered suppliers in this category can bid.</li>
                      <li>Bids are sealed until the deadline.</li>
                      <li>One bid per supplier, and it is final.</li>
                    </ul>
                  </>
                ) : (
                  <div style={{ textAlign: 'center' }}>
                    <Icon name="clock" size={28} color="var(--text-mute)" />
                    <div style={{ fontWeight: 700, marginTop: 6 }}>Bidding is closed</div>
                    <div className="text-sm text-mute">Closed {fmtDate(t.deadlineAt)}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </PublicFrame>
  );
}
