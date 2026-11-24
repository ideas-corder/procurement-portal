import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { api } from '../lib/api';

/**
 * Header bell: the signed-in user's notifications (GET /notifications).
 * Polls once a minute; the first notifications here are "tender closed" ones.
 */

type Item = {
  id: string;
  kind: string;
  entity: string | null;
  entityId: string | null;
  title: string;
  body: string | null;
  read: boolean;
  createdAt: string;
};

const POLL_MS = 60_000;

/** Where a notification's link points, by the entity it is about. */
function hrefFor(it: Item): string | null {
  if (it.entity === 'rfq' && it.entityId) return `/rfq/${it.entityId}`;
  if (it.entity === 'pr' && it.entityId) return `/pr/${it.entityId}`;
  return null;
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ unread: number; items: Item[] }>('/notifications?limit=20');
      setUnread(Number(r.data?.unread ?? 0));
      setItems(r.data?.items ?? []);
      setErr(null);
    } catch (e: any) {
      // The bell must never break the page around it.
      setErr(e.message || 'Could not load notifications.');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function openItem(it: Item) {
    if (!it.read) {
      try { await api.post(`/notifications/${it.id}/read`); } catch { /* still navigate */ }
    }
    setOpen(false);
    load();
    const href = hrefFor(it);
    if (href) router.push(href);
  }

  async function readAll() {
    try { await api.post('/notifications/read-all'); } finally { load(); }
  }

  return (
    <div ref={box} style={{ position: 'relative' }} data-notification-bell="">
      <button
        className="btn sm ghost"
        aria-label={unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}
        aria-expanded={open}
        onClick={() => { setOpen(o => !o); if (!open) load(); }}
        style={{ position: 'relative' }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            data-notification-count=""
            style={{
              position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, padding: '0 4px',
              borderRadius: 8, background: 'var(--danger)', color: '#fff', fontSize: 10,
              lineHeight: '16px', textAlign: 'center', fontWeight: 600,
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        // Deliberately NOT the house `.card` / `.card-h` pattern: CardCollapse
        // puts a collapse chevron on every `.card-h`, which makes no sense on a
        // dropdown.
        <div
          role="menu"
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 340, maxHeight: 420,
            overflow: 'auto', zIndex: 70, background: 'var(--surface)', border: '1px solid var(--line)',
            borderRadius: 10, boxShadow: '0 10px 30px rgba(15,23,42,.18)',
          }}
        >
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 12px', borderBottom: '1px solid var(--line)',
          }}>
            <b>Notifications</b>
            {unread > 0 && <button className="btn sm ghost" onClick={readAll}>Mark all read</button>}
          </div>
          <div>
            {err && <div className="alert danger" style={{ margin: 8 }}>{err}</div>}
            {!err && items.length === 0 && (
              <div className="text-sm text-mute" style={{ padding: 12 }}>No notifications yet.</div>
            )}
            {items.map(it => (
              <button
                key={it.id}
                role="menuitem"
                onClick={() => openItem(it)}
                data-notification-item=""
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                  border: 0, borderBottom: '1px solid var(--line-soft)', cursor: 'pointer',
                  background: it.read ? 'transparent' : 'var(--accent-soft)',
                }}
              >
                <div style={{ fontWeight: it.read ? 400 : 600 }}>{it.title}</div>
                {it.body && <div className="text-sm text-mute">{it.body}</div>}
                <div className="text-sm text-mute">{new Date(it.createdAt).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
