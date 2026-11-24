import type { ReactNode } from 'react';
import { API_BASE } from '../../lib/portal';
import {
  type Tender, CategoryIcon, Icon, StatusBadge, budgetText, fileSize, fmtDate, money, statusOf, timeLeft,
} from './kit';

/** Facts, items and documents of one tender: the same block on every screen. */
export function TenderInfo({ t, docHref, docActions, children }: {
  t: Tender;
  /** URL for a published document (public download by default). */
  docHref?: (docId: string) => string;
  /** Extra control per document (e.g. Remove, for procurement). */
  docActions?: (docId: string) => ReactNode;
  children?: ReactNode;
}) {
  const st = statusOf(t);
  const href = docHref ?? ((id: string) => `${API_BASE}/public/tenders/${t.id}/documents/${id}`);
  return (
    <div className="card" data-tender-info="">
      <div className="card-b">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 14 }}>
          <CategoryIcon code={t.categories[0]} size={52} />
          <div style={{ flex: 1 }}>
            <div className="text-sm text-mute mono">{t.rfqNumber}{t.department ? ` · ${t.department}` : ''}</div>
            <h2 style={{ fontSize: 20, fontWeight: 800, color: 'var(--navy)', margin: '2px 0 6px' }}>{t.title}</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <StatusBadge cls={st.key}>{st.label}</StatusBadge>
              {t.categoryNames.map(c => <span key={c} className="pill info">{c}</span>)}
            </div>
          </div>
        </div>

        <div className="tp-facts" style={{ marginBottom: 14 }}>
          <div className="tp-fact"><div className="tp-fact-l">Budget</div><div className="tp-fact-v">{budgetText(t)}</div></div>
          <div className="tp-fact"><div className="tp-fact-l">Security deposit</div><div className="tp-fact-v">{t.securityDeposit !== null ? money(t.securityDeposit, t.currency) : 'Not required'}</div></div>
          <div className="tp-fact"><div className="tp-fact-l">Bidding closes</div><div className="tp-fact-v">{fmtDate(t.deadlineAt)}</div></div>
          <div className="tp-fact"><div className="tp-fact-l">Time left</div><div className="tp-fact-v">{t.accepting ? timeLeft(t.deadlineAt) : 'Closed'}</div></div>
        </div>

        {t.notes && (
          <>
            <div className="lbl" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 4 }}>Requirement and terms</div>
            <p style={{ whiteSpace: 'pre-wrap', marginBottom: 14 }}>{t.notes}</p>
          </>
        )}

        <div className="lbl" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Items</div>
        <table className="tp-table" style={{ marginBottom: 14 }}>
          <thead><tr><th>#</th><th>Description</th><th style={{ textAlign: 'right' }}>Quantity</th></tr></thead>
          <tbody>
            {t.lines.map(l => (
              <tr key={l.lineNo}>
                <td>{l.lineNo}</td>
                <td>{l.description ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>{l.quantity ?? '—'} {l.uom ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="lbl" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Tender documents</div>
        {t.documents.length === 0 ? (
          <div className="text-sm text-mute">No documents attached to this tender.</div>
        ) : t.documents.map(d => (
          <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <a className="tp-doc" href={href(d.id)} style={{ flex: 1 }} data-tender-doc={d.name}>
              <Icon name="doc" color="var(--accent)" />
              <span style={{ flex: 1 }}><span className="tp-doc-name">{d.name}</span> <span className="text-sm text-mute">{fileSize(d.size)}</span></span>
              <Icon name="download" size={16} color="var(--text-mute)" />
            </a>
            {docActions?.(d.id)}
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}
