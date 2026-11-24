// Vendor-side open tender lists: "Open Tenders" and "My Bids".
//
// Data comes from GET /supplier/tenders; this file only formats it. Bids are
// sealed, so nothing here (or in the API payload) names another bidder.

// ─── shapes the API returns ─────────────────────────────────────────────────

export type OpenTender = {
  rfqId: string;
  rfqNumber: string;
  title: string | null;
  notes: string | null;
  currency: string;
  issuedAt: string | null;
  deadlineAt: string;
  lineCount: number;
};

export type MyBid = {
  invitationId: string;
  rfqId: string;
  rfqNumber: string;
  title: string | null;
  deadlineAt: string;
  currency: string;
  tenderState: string;
  myBid: { version: number; total: number | null } | null;
  /** 'Won' / 'Not selected' appear only once the comparative statement is final. */
  status: 'Not submitted' | 'Submitted' | 'Tender closed' | 'Won' | 'Not selected' | string;
  canBid: boolean;
};

export type TendersData = { openTenders: OpenTender[]; myBids: MyBid[] };

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * "closes in 2d 5h" / "closes in 3h 10m" / "closed". Computed once per render,
 * not a ticking timer: the supplier screens carry no running countdown (W4-2).
 */
export function closesIn(deadlineIso: string, nowMs: number = Date.now()): string {
  const ms = new Date(deadlineIso).getTime() - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return 'closed';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `closes in ${d}d ${h}h`;
  if (h > 0) return `closes in ${h}h ${m}m`;
  return `closes in ${Math.max(m, 1)}m`;
}

export function fmtDeadline(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : iso;
}

function money(n: number | null, cur: string): string {
  if (n === null || n === undefined) return '—';
  return `${cur} ${Number(n).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
}

const STATUS_PILL: Record<string, string> = {
  'Submitted': 'success',
  'Not submitted': 'warn',
  'Tender closed': 'draft',
  'Won': 'success',
  'Not selected': 'draft',
};

// ─── Open Tenders ───────────────────────────────────────────────────────────

export function OpenTendersList({
  tenders, onBid, busyId, nowMs,
}: {
  tenders: OpenTender[];
  /** "Bid now": join the tender, then open the bid form. */
  onBid?: (rfqId: string) => void;
  busyId?: string | null;
  nowMs?: number;
}) {
  if (tenders.length === 0) {
    return (
      <div className="card">
        <div className="card-b empty-state" data-open-tenders-empty="">
          No open tenders in your categories right now. New tenders appear here as soon as
          they are posted.
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="card-b">
        <p className="text-sm text-mute" style={{ marginTop: 0 }}>
          Open tenders in the categories you are registered for. Any eligible vendor may bid,
          and bids are sealed: no vendor sees another vendor&apos;s bid or name. You can change
          your bid until the deadline.
        </p>
        <table className="t" data-open-tenders="">
          <thead>
            <tr>
              <th>Tender</th><th>Requirement</th><th>Deadline</th><th>Lines</th>
              <th style={{ textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {tenders.map(t => (
              <tr key={t.rfqId} data-tender={t.rfqId}>
                <td className="mono"><b>{t.rfqNumber}</b></td>
                <td>
                  <div>{t.title || '—'}</div>
                  {t.notes && (
                    <div className="text-sm text-mute" style={{ whiteSpace: 'pre-wrap' }}>{t.notes}</div>
                  )}
                </td>
                <td className="text-sm">
                  <div>{fmtDeadline(t.deadlineAt)}</div>
                  <span className="pill info">{closesIn(t.deadlineAt, nowMs)}</span>
                </td>
                <td>{t.lineCount}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="btn sm primary"
                    disabled={!onBid || busyId === t.rfqId}
                    onClick={() => onBid?.(t.rfqId)}
                    data-bid-now={t.rfqId}
                  >
                    {busyId === t.rfqId ? 'Opening…' : 'Bid now'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── My Bids ────────────────────────────────────────────────────────────────

export function MyBidsList({
  bids, onOpen, nowMs,
}: {
  bids: MyBid[];
  onOpen?: (invitationId: string) => void;
  nowMs?: number;
}) {
  if (bids.length === 0) {
    return (
      <div className="card">
        <div className="card-b empty-state" data-my-bids-empty="">
          You have not bid on any tender yet. Pick one from Open Tenders.
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="card-b">
        <table className="t" data-my-bids="">
          <thead>
            <tr>
              <th>Tender</th><th>Title</th><th>Deadline</th><th>My bid</th><th>Status</th>
              <th style={{ textAlign: 'right' }}></th>
            </tr>
          </thead>
          <tbody>
            {bids.map(b => (
              <tr key={b.invitationId} data-my-bid={b.rfqId}>
                <td className="mono"><b>{b.rfqNumber}</b></td>
                <td>{b.title || '—'}</td>
                <td className="text-sm">
                  <div>{fmtDeadline(b.deadlineAt)}</div>
                  {b.canBid && <span className="pill info">{closesIn(b.deadlineAt, nowMs)}</span>}
                </td>
                <td className="mono">
                  {b.myBid ? `V${b.myBid.version} · ${money(b.myBid.total, b.currency)}` : '—'}
                </td>
                <td>
                  <span className={`pill ${STATUS_PILL[b.status] ?? ''}`} data-bid-status="">{b.status}</span>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="btn sm"
                    disabled={!onOpen}
                    onClick={() => onOpen?.(b.invitationId)}
                    data-open-bid={b.invitationId}
                  >
                    {b.canBid ? (b.myBid ? 'Edit bid' : 'Bid now') : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
