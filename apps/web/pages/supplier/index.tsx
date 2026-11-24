// `supplier-rfq` — the Supplier RFQ Inbox (invited RFQs).
//
// Port of renderSupplierInbox (prototype line 9001-9035). Gated to role
// 'vendor' by the sidebar's data-roles, and by SupplierGuard server-side — the
// nav entry is a convenience, the guard is the boundary.
//
// Open tenders have their own dashboard at /supplier/tenders. This inbox lists
// only the RFQs procurement invited this supplier to; tender invitations
// (created when a supplier opens a tender) are left to the tender screens.
// The old `?tab=tenders|bids` links are forwarded there.
//
// The page holds NO business logic. Every number a supplier sees was computed
// on the server, so this screen cannot disagree with the API.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import {
  SupplierKpiBand, SupplierInboxList, type InboxData,
} from '../../components/supplier/SupplierCards';

export default function SupplierInbox() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [data, setData] = useState<InboxData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    const tab = router.query.tab;
    if (tab === 'tenders') { router.replace('/supplier/tenders'); return; }
    if (tab === 'bids') { router.replace('/supplier/tenders?tab=mine'); return; }
    api.get<InboxData>('/supplier/inbox')
      .then(r => setData(r.data))
      .catch(e => setErr(e.message));
  }, [ready, session, router.query.tab]);

  if (!ready) return null;
  if (!session) return null;

  const invited: InboxData | null = data
    ? (() => {
        const invitations = data.invitations.filter(i => i.sourcingMode !== 'open_tender');
        return { ...data, invitations, empty: data.empty || invitations.length === 0 };
      })()
    : null;

  // A back-office session can reach this URL by typing it. The API refuses with
  // 403 and the message says why; rendering the refusal is better than a blank
  // screen, and better than a redirect that hides the reason.
  return (
    <Shell title="Supplier RFQ Inbox" screenId="supplier-rfq" subtitle={data?.subtitle}>
      {err && <div className="alert danger">{err}</div>}
      <div className="alert info" data-tenders-moved="">
        <div>
          This inbox lists the RFQs procurement invited you to. Open tenders you can bid on are on the{' '}
          <Link href="/supplier/tenders"><b>Tenders</b></Link> page.
        </div>
      </div>
      {!err && !data && <div className="card"><div className="card-b empty-state">Loading&hellip;</div></div>}
      {data && !data.empty && <SupplierKpiBand kpis={data.kpis} />}
      {invited && (
        <SupplierInboxList
          data={invited}
          onQuote={(id) => router.push(`/supplier/${id}`)}
        />
      )}
    </Shell>
  );
}
