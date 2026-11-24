// Shared building blocks for the tender screens (public, supplier, staff).
//
// Everything here is presentation: the shapes mirror apps/api/src/tenders
// (shapeTender) and nothing is computed that the API did not already decide,
// except display formatting and client-side filtering of a list already loaded.

import type { ReactNode } from 'react';

// ─── shapes ──────────────────────────────────────────────────────────────────

export type TenderLine = { lineNo: number; description: string | null; quantity: number | null; uom: string | null; category: string | null };
export type TenderDoc = { id: string; name: string; size: number | null; kind: string | null };
export type Tender = {
  id: string;
  rfqNumber: string;
  title: string;
  notes: string | null;
  state: string;
  status: 'Open' | 'Closed' | 'Awarded' | string;
  accepting: boolean;
  currency: string;
  deadlineAt: string;
  postedAt: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  securityDeposit: number | null;
  categories: string[];
  categoryNames: string[];
  department?: string | null;
  lines: TenderLine[];
  documents: TenderDoc[];
};

// ─── formatting ──────────────────────────────────────────────────────────────

export function money(n: number | null | undefined, cur = 'PKR'): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return `${cur} ${Number(n).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;
}

export function budgetText(t: Pick<Tender, 'budgetMin' | 'budgetMax' | 'currency'>): string {
  if (t.budgetMin !== null && t.budgetMax !== null) return `${money(t.budgetMin, t.currency)} – ${money(t.budgetMax, '').trim()}`;
  if (t.budgetMax !== null) return `Up to ${money(t.budgetMax, t.currency)}`;
  if (t.budgetMin !== null) return `From ${money(t.budgetMin, t.currency)}`;
  return 'Not stated';
}

export function fmtDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}

/** "2d 5h left" / "closed" — computed once per render, never a ticking timer. */
export function timeLeft(iso: string, nowMs: number = Date.now()): string {
  const ms = new Date(iso).getTime() - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return 'Closed';
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${Math.max(m, 1)}m left`;
}

export function fileSize(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── status ──────────────────────────────────────────────────────────────────

export type StatusKey = 'open' | 'soon' | 'closed' | 'awarded';
export function statusOf(t: Pick<Tender, 'accepting' | 'status' | 'deadlineAt'>, nowMs = Date.now()): { key: StatusKey; label: string } {
  if (t.accepting) {
    const soon = new Date(t.deadlineAt).getTime() - nowMs < 3 * 86400e3;
    return soon ? { key: 'soon', label: 'Closing soon' } : { key: 'open', label: 'Open' };
  }
  if (t.status === 'Awarded') return { key: 'awarded', label: 'Awarded' };
  return { key: 'closed', label: 'Closed' };
}

export function StatusBadge({ cls, children }: { cls: string; children: ReactNode }) {
  return <span className={`tp-status ${cls}`}>{children}</span>;
}

// ─── icons ───────────────────────────────────────────────────────────────────

const CAT_STYLE: Record<string, { bg: string; fg: string; path: ReactNode }> = {
  IT_HARDWARE: { bg: '#E0F2FE', fg: '#0369A1', path: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></> },
  IT_SOFTWARE: { bg: '#EDE9FE', fg: '#6D28D9', path: <><path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" /></> },
  OFFICE_SUPPLIES: { bg: '#FEF3C7', fg: '#B45309', path: <><path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" /><path d="M14 6l3 3" /></> },
  FACILITIES: { bg: '#DCFCE7', fg: '#15803D', path: <><path d="M4 21V8l8-5 8 5v13" /><path d="M9 21v-6h6v6" /></> },
  MACHINERY: { bg: '#FFE4E6', fg: '#BE123C', path: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></> },
  MARKETING: { bg: '#FCE7F3', fg: '#BE185D', path: <><path d="M3 11v2l13 5V6L3 11z" /><path d="M16 9a3 3 0 010 6M7 14l1 5h3l-1-4" /></> },
  PROFESSIONAL_SERVICES: { bg: '#E0E7FF', fg: '#4338CA', path: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M3 13h18" /></> },
  WAREHOUSE_ACCESSORY: { bg: '#FFEDD5', fg: '#C2410C', path: <><path d="M3 7l9-4 9 4v10l-9 4-9-4V7z" /><path d="M3 7l9 4 9-4M12 11v10" /></> },
  OTHER: { bg: '#F1F5F9', fg: '#475569', path: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2" /></> },
};

export function CategoryIcon({ code, size = 44 }: { code?: string | null; size?: number }) {
  const s = CAT_STYLE[code ?? 'OTHER'] ?? CAT_STYLE.OTHER;
  return (
    <span className="tp-cat" style={{ background: s.bg, width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke={s.fg} strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round">{s.path}</svg>
    </span>
  );
}

export function Icon({ name, size = 18, color = 'currentColor' }: { name: 'search' | 'doc' | 'clock' | 'wallet' | 'shield' | 'tag' | 'users' | 'trophy' | 'inbox' | 'upload' | 'check' | 'alert' | 'download'; size?: number; color?: string }) {
  const p: Record<string, ReactNode> = {
    search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
    doc: <><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    wallet: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M16 13h2M3 10h18" /></>,
    shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></>,
    tag: <><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1.5" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a3 3 0 100-6M21 20c0-2.5-1.5-4.6-3.6-5.5" /></>,
    trophy: <><path d="M8 4h8v5a4 4 0 01-8 0V4zM8 6H4a3 3 0 003 4M16 6h4a3 3 0 01-3 4M12 13v4M8 21h8M9 17h6" /></>,
    inbox: <><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></>,
    upload: <><path d="M12 16V4M7 9l5-5 5 5M4 20h16" /></>,
    check: <><path d="M5 12l5 5 9-10" /></>,
    alert: <><path d="M12 3l10 18H2z" /><path d="M12 10v4M12 18h.01" /></>,
    download: <><path d="M12 4v12M7 11l5 5 5-5M4 20h16" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p[name]}</svg>
  );
}

/** Hero illustration: a tender document, a stamp and bid cards. Pure SVG. */
export function HeroArt() {
  return (
    <svg className="tp-hero-art" viewBox="0 0 340 220" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="tpg1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".95" />
          <stop offset="1" stopColor="#dbeafe" stopOpacity=".9" />
        </linearGradient>
      </defs>
      <circle cx="270" cy="40" r="60" fill="#ffffff" opacity=".06" />
      <circle cx="40" cy="190" r="50" fill="#ffffff" opacity=".05" />
      <rect x="70" y="22" width="150" height="178" rx="14" fill="url(#tpg1)" />
      <rect x="90" y="46" width="80" height="10" rx="5" fill="#1F3A5F" opacity=".8" />
      <rect x="90" y="66" width="110" height="7" rx="3.5" fill="#94a3b8" opacity=".7" />
      <rect x="90" y="80" width="96" height="7" rx="3.5" fill="#94a3b8" opacity=".7" />
      <rect x="90" y="94" width="104" height="7" rx="3.5" fill="#94a3b8" opacity=".7" />
      <rect x="90" y="118" width="50" height="8" rx="4" fill="#2E86C1" />
      <rect x="90" y="134" width="70" height="8" rx="4" fill="#cbd5e1" />
      <circle cx="186" cy="166" r="20" fill="#16A34A" opacity=".9" />
      <path d="M177 166l6 6 11-12" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <g transform="translate(206 70) rotate(8)">
        <rect width="104" height="58" rx="10" fill="#ffffff" />
        <rect x="12" y="12" width="44" height="8" rx="4" fill="#1F3A5F" opacity=".75" />
        <rect x="12" y="28" width="80" height="7" rx="3.5" fill="#cbd5e1" />
        <rect x="12" y="40" width="56" height="7" rx="3.5" fill="#86efac" />
      </g>
      <g transform="translate(24 116) rotate(-10)">
        <rect width="88" height="52" rx="10" fill="#ffffff" />
        <rect x="10" y="12" width="40" height="8" rx="4" fill="#1F3A5F" opacity=".75" />
        <rect x="10" y="28" width="66" height="7" rx="3.5" fill="#cbd5e1" />
        <rect x="10" y="38" width="44" height="6" rx="3" fill="#fde68a" />
      </g>
    </svg>
  );
}

export function EmptyArt({ size = 72 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <rect x="14" y="10" width="44" height="52" rx="8" fill="#EFF6FF" stroke="#BFDBFE" strokeWidth="2" />
      <path d="M24 26h24M24 34h18M24 42h22" stroke="#93C5FD" strokeWidth="3" strokeLinecap="round" />
      <circle cx="52" cy="50" r="10" fill="#fff" stroke="#2E86C1" strokeWidth="3" />
      <path d="M59 57l6 6" stroke="#2E86C1" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ─── cards ───────────────────────────────────────────────────────────────────

export function TenderCard({ t, onOpen, badge, footerRight, children, testId }: {
  t: Tender;
  onOpen?: () => void;
  /** Overrides the status badge (e.g. "Won" on My Tenders). */
  badge?: ReactNode;
  footerRight?: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  const st = statusOf(t);
  return (
    <button type="button" className="tp-card" onClick={onOpen} data-tender-card={testId ?? t.id}>
      <div className="tp-card-top">
        <CategoryIcon code={t.categories[0]} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="tp-card-title">{t.title}</div>
          <div className="tp-card-ref">{t.rfqNumber}{t.categoryNames.length ? ` · ${t.categoryNames.join(', ')}` : ''}</div>
        </div>
        {badge ?? <StatusBadge cls={st.key}>{st.label}</StatusBadge>}
      </div>
      {t.notes && <div className="tp-card-notes">{t.notes}</div>}
      <div className="tp-card-meta">
        <span title="Budget"><Icon name="wallet" size={13} /> <b>{budgetText(t)}</b></span>
        {t.securityDeposit !== null && <span title="Security deposit"><Icon name="shield" size={13} /> Deposit <b>{money(t.securityDeposit, t.currency)}</b></span>}
        <span title="Items"><Icon name="tag" size={13} /> {t.lines.length} item{t.lines.length === 1 ? '' : 's'}</span>
        {t.documents.length > 0 && <span title="Documents"><Icon name="doc" size={13} /> {t.documents.length} doc{t.documents.length === 1 ? '' : 's'}</span>}
      </div>
      {children}
      <div className="tp-card-foot">
        <span className="text-sm" title={fmtDate(t.deadlineAt)}>
          <Icon name="clock" size={13} /> {t.accepting ? timeLeft(t.deadlineAt) : `Closed ${fmtDate(t.deadlineAt, false)}`}
        </span>
        {footerRight}
      </div>
    </button>
  );
}

export function StatTile({ icon, tone, n, label, active, onClick, testId }: {
  icon: Parameters<typeof Icon>[0]['name']; tone: [string, string]; n: number | string; label: string;
  active?: boolean; onClick?: () => void; testId?: string;
}) {
  const Tag: any = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`tp-stat${onClick ? ' clickable' : ''}${active ? ' active' : ''}`}
         onClick={onClick} data-stat={testId}>
      <span className="tp-stat-icon" style={{ background: tone[0] }}><Icon name={icon} color={tone[1]} /></span>
      <span>
        <div className="tp-stat-n">{n}</div>
        <div className="tp-stat-l">{label}</div>
      </span>
    </Tag>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="tp-empty">
      <EmptyArt />
      <div style={{ fontWeight: 700, color: 'var(--text-2)', marginBottom: 4 }}>{title}</div>
      {children && <div className="text-sm">{children}</div>}
    </div>
  );
}

// ─── filtering ───────────────────────────────────────────────────────────────

export type TenderFilter = { q: string; category: string; closing: 'any' | '3d' | '7d'; budgetMax: string };
export const EMPTY_FILTER: TenderFilter = { q: '', category: '', closing: 'any', budgetMax: '' };

export function applyFilter<T extends Tender>(list: T[], f: TenderFilter, nowMs = Date.now()): T[] {
  const q = f.q.trim().toLowerCase();
  const cap = f.budgetMax ? Number(f.budgetMax) : null;
  return list.filter(t => {
    if (q && !`${t.title} ${t.rfqNumber} ${t.notes ?? ''} ${t.lines.map(l => l.description).join(' ')} ${t.categoryNames.join(' ')}`
      .toLowerCase().includes(q)) return false;
    if (f.category && !t.categories.includes(f.category)) return false;
    if (f.closing !== 'any') {
      const lim = (f.closing === '3d' ? 3 : 7) * 86400e3;
      const left = new Date(t.deadlineAt).getTime() - nowMs;
      if (!(t.accepting && left > 0 && left <= lim)) return false;
    }
    if (cap !== null && Number.isFinite(cap)) {
      const lo = t.budgetMin ?? t.budgetMax;
      if (lo !== null && lo > cap) return false;
    }
    return true;
  });
}

export function FilterBar({ f, set, categories, extra }: {
  f: TenderFilter; set: (f: TenderFilter) => void;
  categories: Array<{ code: string; name: string }>;
  extra?: ReactNode;
}) {
  return (
    <div className="tp-filters" data-tender-filters="">
      <div className="tp-search">
        <Icon name="search" size={16} />
        <input type="text" placeholder="Search tenders, items, reference…" value={f.q}
               onChange={e => set({ ...f, q: e.target.value })} data-filter-q="" />
      </div>
      <select value={f.category} onChange={e => set({ ...f, category: e.target.value })} data-filter-category="">
        <option value="">All categories</option>
        {categories.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      <select value={f.closing} onChange={e => set({ ...f, closing: e.target.value as TenderFilter['closing'] })} data-filter-closing="">
        <option value="any">Any deadline</option>
        <option value="3d">Closing in 3 days</option>
        <option value="7d">Closing in 7 days</option>
      </select>
      <input type="number" min={0} placeholder="Max budget (PKR)" value={f.budgetMax}
             onChange={e => set({ ...f, budgetMax: e.target.value })} style={{ width: 170 }} data-filter-budget="" />
      {extra}
      {(f.q || f.category || f.closing !== 'any' || f.budgetMax) && (
        <button type="button" className="btn sm ghost" onClick={() => set(EMPTY_FILTER)}>Clear</button>
      )}
    </div>
  );
}

/** The categories present in a list, for the filter dropdown. */
export function categoriesOf(list: Tender[]): Array<{ code: string; name: string }> {
  const m = new Map<string, string>();
  for (const t of list) t.categories.forEach((c, i) => m.set(c, t.categoryNames[i] ?? c));
  return [...m.entries()].map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}
