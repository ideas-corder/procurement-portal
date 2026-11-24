// `/tenders/request` — New Tender Request (requester).
//
// A tender request is an ordinary purchase requisition marked
// sourcingPreference = 'tender' (migration 079): same HOD approval, same
// routing. The form is simpler than the PR form on purpose: what is needed,
// how many, in which category, and roughly what it costs.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Shell from '../../components/Shell';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { CategoryIcon, money } from '../../components/tenders/kit';

type Department = { id: string; code: string; name: string; hod_user_id: string | null };
type CostCenter = { id: string; code: string; name: string; department_id: string | null };
type Category = { code: string; name: string; description: string | null; vendor_count?: string | number };
type Uom = { code: string; name: string };
type Line = { description: string; category: string; qty: string; uom: string; unitPrice: string };

const fresh = (): Line => ({ description: '', category: '', qty: '1', uom: 'EA', unitPrice: '' });

export default function NewTenderRequest() {
  const router = useRouter();
  const { session, ready } = useSession();
  const [depts, setDepts] = useState<Department[]>([]);
  const [ccs, setCcs] = useState<CostCenter[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [uoms, setUoms] = useState<Uom[]>([]);
  const [title, setTitle] = useState('');
  const [deptId, setDeptId] = useState('');
  const [why, setWhy] = useState('');
  const [needBy, setNeedBy] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().slice(0, 10);
  });
  const [lines, setLines] = useState<Line[]>([fresh()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    Promise.all([
      api.get<Department[]>('/lookups/departments'),
      api.get<CostCenter[]>('/lookups/cost-centers'),
      api.get<Category[]>('/lookups/categories'),
      api.get<Uom[]>('/lookups/uoms'),
    ]).then(([d, c, k, u]) => {
      setDepts(d.data); setCcs(c.data); setCats(k.data); setUoms(u.data);
      // Default to the requester's own department when there is exactly one cost centre for it.
      const mineCc = c.data.find(x => (session.user.costCenterIds ?? []).includes(x.id));
      if (mineCc?.department_id) setDeptId(mineCc.department_id);
    }).catch(e => setErr(e.message));
  }, [ready, session]);

  const dept = depts.find(d => d.id === deptId);
  const cc = ccs.find(c => c.department_id === deptId);
  const total = useMemo(() => lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0), [lines]);
  const filled = lines.filter(l => l.description.trim());
  const problems = [
    !title.trim() && 'a title',
    !dept && 'the department',
    dept && !cc && 'a department with a cost centre',
    !why.trim() && 'a justification',
    filled.length === 0 && 'at least one item',
    filled.some(l => !l.category) && 'a category for every item',
    filled.some(l => !(Number(l.qty) > 0)) && 'a quantity for every item',
  ].filter(Boolean) as string[];

  const setLine = (i: number, patch: Partial<Line>) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit() {
    if (problems.length || !dept || !cc) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ id: string }>('/pr', {
        sourcingPreference: 'tender',
        title: title.trim(),
        scope: title.trim(),
        description: why.trim(),
        purpose: why.trim(),
        expenseType: 'OPEX',
        costCenterId: cc.id,
        departments: [{ departmentId: dept.id, hodUserId: dept.hod_user_id ?? undefined, suggested: true }],
        requiredByDate: needBy,
        urgency: 'routine',
        lines: filled.map(l => ({
          description: l.description.trim(),
          category: l.category,
          quantity: Number(l.qty),
          uom: l.uom,
          ...(l.unitPrice.trim() ? { unitPriceEst: Number(l.unitPrice) } : {}),
        })),
      });
      router.push(`/tenders/requests?created=${(r.data as any).id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready || !session) return null;

  return (
    <Shell title="New Tender Request" screenId="tender-request-new"
           subtitle="Ask procurement to buy through an open tender. Your HOD approves it first.">
      <p className="text-sm" style={{ marginBottom: 12 }}><Link href="/tenders/requests">&larr; My tender requests</Link></p>
      {err && <div className="alert danger">{err}</div>}

      <div className="tp-detail">
        <div className="card">
          <div className="card-b" data-tender-request-form="">
            <label className="field">
              <span className="lbl">What do you need? <span className="req">*</span></span>
              <input type="text" value={title} maxLength={200} onChange={e => setTitle(e.target.value)}
                     placeholder="e.g. 10 laptops for the new sales team" data-tr-title="" />
            </label>
            <div className="field-row">
              <label className="field">
                <span className="lbl">Department <span className="req">*</span></span>
                <select value={deptId} onChange={e => setDeptId(e.target.value)} data-tr-dept="">
                  <option value="">Choose…</option>
                  {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="lbl">Needed by</span>
                <input type="date" value={needBy} onChange={e => setNeedBy(e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span className="lbl">Why is it needed? <span className="req">*</span></span>
              <textarea rows={3} value={why} onChange={e => setWhy(e.target.value)} placeholder="Business reason for this purchase" data-tr-why="" />
            </label>

            <div className="lbl" style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.05em', margin: '6px 0 8px' }}>Items</div>
            {lines.map((l, i) => (
              <div key={i} className="tp-fact" style={{ marginBottom: 10, background: 'var(--surface)' }} data-tr-line={i}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <CategoryIcon code={l.category || null} size={34} />
                  <input type="text" value={l.description} placeholder="Item description, e.g. Dell Latitude 5550 laptop"
                         onChange={e => setLine(i, { description: e.target.value })} style={{ flex: 1 }} data-tr-desc={i} />
                  {lines.length > 1 && <button type="button" className="btn sm ghost" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))} title="Remove item">×</button>}
                </div>
                <div className="field-row">
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span className="lbl">Category *</span>
                    <select value={l.category} onChange={e => setLine(i, { category: e.target.value })} data-tr-cat={i}>
                      <option value="">Choose…</option>
                      {cats.map(c => (
                        <option key={c.code} value={c.code}>
                          {c.name}{c.vendor_count !== undefined ? ` (${c.vendor_count} supplier${Number(c.vendor_count) === 1 ? '' : 's'})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span className="lbl">Quantity *</span>
                    <input type="number" min={1} value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} data-tr-qty={i} />
                  </label>
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span className="lbl">Unit</span>
                    <select value={l.uom} onChange={e => setLine(i, { uom: e.target.value })}>
                      {uoms.map(u => <option key={u.code} value={u.code}>{u.code}</option>)}
                    </select>
                  </label>
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span className="lbl">Est. unit price</span>
                    <input type="number" min={0} value={l.unitPrice} placeholder="PKR" onChange={e => setLine(i, { unitPrice: e.target.value })} data-tr-price={i} />
                  </label>
                </div>
              </div>
            ))}
            <button type="button" className="btn sm" onClick={() => setLines(ls => [...ls, fresh()])} data-tr-add-line="">+ Add another item</button>
          </div>
        </div>

        <div className="tp-sticky">
          <div className="card">
            <div className="card-b">
              <div className="text-sm text-mute">Estimated total</div>
              <div className="tp-countdown" data-tr-total="">{money(total)}</div>
              <div className="text-sm text-mute" style={{ marginBottom: 12 }}>{filled.length} item{filled.length === 1 ? '' : 's'}{dept ? ` · ${dept.name}` : ''}</div>
              <ol className="text-sm" style={{ paddingLeft: 18, lineHeight: 1.8, marginBottom: 12 }}>
                <li>Your HOD approves the request</li>
                <li>Procurement publishes it as an open tender</li>
                <li>Registered suppliers bid until the deadline</li>
                <li>The best bid goes through CS and finance</li>
              </ol>
              {problems.length > 0 && <div className="text-sm text-mute" style={{ marginBottom: 8 }}>Still needed: {problems.join(', ')}.</div>}
              <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }}
                      onClick={submit} disabled={busy || problems.length > 0} data-tr-submit="">
                {busy ? 'Sending…' : 'Send for HOD approval'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
