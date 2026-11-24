import { useState } from 'react';
import { api } from '../../lib/api';

/**
 * "Post Tender" — the open-tender alternative to "Issue RFQ".
 *
 * No vendor roster: every eligible vendor in the PR's line categories can see
 * the tender and bid until the deadline (POST /pr/:id/tender). The deadline is
 * required because it is what closes bidding, and the server refuses one less
 * than 24 hours away, so the picker starts there.
 */

const MIN_HOURS = 24;
const DEFAULT_DAYS = 7;

/** `YYYY-MM-DDTHH:mm` in LOCAL time, the format <input type="datetime-local"> uses. */
function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PostTenderModal({
  prId,
  prNumber,
  prTitle,
  onClose,
  onPosted,
}: {
  prId: string;
  prNumber: string;
  prTitle?: string | null;
  onClose: () => void;
  /** Called with a one-line summary once the tender is live. */
  onPosted: (message: string) => void;
}) {
  const now = Date.now();
  const [deadline, setDeadline] = useState(localInputValue(new Date(now + DEFAULT_DAYS * 86400e3)));
  const [title, setTitle] = useState(prTitle || '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const minValue = localInputValue(new Date(now + MIN_HOURS * 3600e3 + 60e3));
  const deadlineMs = deadline ? new Date(deadline).getTime() : NaN;
  const tooSoon = !Number.isFinite(deadlineMs) || deadlineMs < Date.now() + MIN_HOURS * 3600e3;

  async function post() {
    if (tooSoon) {
      setErr(`The deadline must be at least ${MIN_HOURS} hours from now.`);
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await api.post<any>(`/pr/${prId}/tender`, {
        deadlineAt: new Date(deadline).toISOString(),
        title: title.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      const n = Number(r.data?.eligible_vendor_count ?? 0);
      onPosted(
        `Tender ${r.data?.rfq?.rfq_number ?? ''} posted. ${n} eligible vendor${n === 1 ? '' : 's'} ` +
        `can bid until ${new Date(r.data?.rfq?.deadline_at ?? deadline).toLocaleString()}.`,
      );
    } catch (e: any) {
      setErr(e.message || 'Could not post the tender.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Post tender — ${prNumber}`}
      data-tender-dialog=""
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
      }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="card" style={{ width: 620, maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto' }}>
        <div className="card-h">
          <h3>Post tender — {prNumber}</h3>
        </div>
        <div className="card-b">
          <div className="alert info" style={{ marginBottom: 12 }}>
            An open tender has no invite list. Every eligible vendor registered in this
            request&apos;s line categories can see it and bid until the deadline. Bids are
            sealed: vendors never see each other. After the deadline the tender closes by
            itself and you are notified.
          </div>
          {err && <div className="alert danger" style={{ marginBottom: 12 }}>{err}</div>}

          <label className="field">
            <span className="lbl">Bidding closes at *</span>
            <input
              type="datetime-local"
              value={deadline}
              min={minValue}
              onChange={e => setDeadline(e.target.value)}
              disabled={busy}
              data-tender-deadline=""
            />
            {tooSoon && (
              <span className="text-sm" style={{ color: 'var(--danger)' }}>
                Must be at least {MIN_HOURS} hours from now.
              </span>
            )}
          </label>

          <label className="field">
            <span className="lbl">Title</span>
            <input
              type="text"
              value={title}
              maxLength={300}
              onChange={e => setTitle(e.target.value)}
              disabled={busy}
              placeholder={prNumber}
            />
          </label>

          <label className="field">
            <span className="lbl">Requirement / terms shown to bidders</span>
            <textarea
              value={notes}
              maxLength={4000}
              rows={5}
              onChange={e => setNotes(e.target.value)}
              disabled={busy}
              placeholder="e.g. Delivery to Karachi plant within 14 days. Prices inclusive of GST."
              data-tender-notes=""
            />
            <span className="text-sm text-mute">{notes.length} / 4000</span>
          </label>

          <div className="btn-row">
            <button className="btn primary" onClick={post} disabled={busy || tooSoon} data-tender-post="">
              {busy ? 'Posting…' : 'Post tender'}
            </button>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
