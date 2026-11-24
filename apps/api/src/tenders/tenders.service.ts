import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { roleAllowed } from '@procurement/roles';
import { DbService } from '../db/db.service';
import { pgArray } from '../db/pg-array';
import { AttachmentsService } from '../attachments/attachments.service';
import { isSealed, maskBids } from '../sourcing/tender.seal';

/**
 * The tender-management read model and the tender document paths.
 *
 * This adds NO new workflow. A tender is still an RFQ with
 * sourcing_mode = 'open_tender' behind a PR that went HOD -> procurement; bids
 * are still quotations; CS, finance and D365 are unchanged. What lives here is
 * the separate tender UI's view of that same data:
 *
 *   - procurement's overview: tender requests ready to publish + every tender
 *     with its bid count (prices sealed until the deadline),
 *   - the tender requests list for requesters and HODs,
 *   - the public open-tender listing (no login),
 *   - a supplier's view of one tender, and
 *   - tender documents: published by procurement (public), and a supplier's
 *     own bid document (private to the bid).
 */

const STAFF_TENDER_ROLES = 'procurement,cs,hod,requester,finance,cfo,mc,audit';
const MANAGE_ROLES = 'procurement,cs';

/** The shared tender columns, read the same way for every audience. */
const TENDER_SELECT = `
  SELECT rf.id, rf.rfq_number, rf.title, rf.tender_notes, rf.state, rf.currency,
         rf.deadline_at, rf.issued_at, rf.budget_min, rf.budget_max, rf.security_deposit,
         rf.sourcing_mode, rf.pr_id,
         (rf.state = 'Open' AND rf.deadline_at > now()) AS accepting,
         pr.pr_number, pr.status AS pr_status, pr.title AS pr_title, pr.estimated_amount,
         d.name AS department,
         (SELECT array_agg(DISTINCT pl.category ORDER BY pl.category)
            FROM proc.rfq_lines rl JOIN proc.pr_lines pl ON pl.id = rl.pr_line_id
           WHERE rl.rfq_id = rf.id AND pl.category IS NOT NULL) AS categories,
         (SELECT array_agg(DISTINCT c.name ORDER BY c.name)
            FROM proc.rfq_lines rl JOIN proc.pr_lines pl ON pl.id = rl.pr_line_id
            JOIN core.categories c ON c.code = pl.category
           WHERE rl.rfq_id = rf.id) AS category_names,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'line_no', rl.line_no, 'description', rl.description,
                     'quantity', rl.quantity, 'uom', rl.uom, 'category', pl.category)
                   ORDER BY rl.line_no)
                     FROM proc.rfq_lines rl LEFT JOIN proc.pr_lines pl ON pl.id = rl.pr_line_id
                    WHERE rl.rfq_id = rf.id), '[]'::jsonb) AS lines,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'id', a.id, 'name', a.name, 'size', a.size_bytes, 'kind', a.kind)
                   ORDER BY dd.created_at)
                     FROM proc.rfq_documents dd
                     JOIN core.attachment_registry a ON a.id = dd.attachment_id
                    WHERE dd.rfq_id = rf.id AND a.status <> 'VOID'), '[]'::jsonb) AS documents,
         (SELECT count(*)::int FROM proc.rfq_invitations i WHERE i.rfq_id = rf.id) AS bidders_joined,
         (SELECT count(DISTINCT q.vendor_id)::int FROM proc.quotations q
           WHERE q.rfq_id = rf.id AND q.state IN ('Submitted','Awarded','Rejected')) AS bids
    FROM proc.rfq rf
    JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
    LEFT JOIN core.departments d ON d.id = pr.department_id
   WHERE rf.sourcing_mode = 'open_tender' AND rf.state <> 'Cancelled'`;

const json = (v: any) => {
  if (v === null || v === undefined) return [];
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return []; }
};
const num = (v: any) => (v === null || v === undefined || v === '' ? null : Number(v));

/** One tender, shaped once for every screen. */
function shapeTender(r: any) {
  const accepting = r.accepting === true;
  return {
    id: r.id,
    rfqNumber: r.rfq_number,
    title: r.title || r.pr_title || r.rfq_number,
    notes: r.tender_notes ?? null,
    state: r.state,
    // The word every tender screen shows.
    status: accepting ? 'Open' : r.state === 'Awarded' ? 'Awarded' : 'Closed',
    accepting,
    currency: r.currency || 'PKR',
    deadlineAt: r.deadline_at,
    postedAt: r.issued_at,
    budgetMin: num(r.budget_min),
    budgetMax: num(r.budget_max),
    securityDeposit: num(r.security_deposit),
    categories: pgArray(r.categories),
    categoryNames: pgArray(r.category_names),
    department: r.department ?? null,
    lines: json(r.lines).map((l: any) => ({
      lineNo: Number(l.line_no), description: l.description, quantity: num(l.quantity), uom: l.uom, category: l.category ?? null,
    })),
    documents: json(r.documents).map((d: any) => ({ id: d.id, name: d.name, size: num(d.size), kind: d.kind })),
  };
}

@Injectable()
export class TendersService {
  constructor(
    private readonly db: DbService,
    private readonly attachments: AttachmentsService,
  ) {}

  // ── procurement: GET /tenders/overview ─────────────────────────────────────
  async overview(user: { id: string; role: string; costCenterIds: string[] }) {
    if (!roleAllowed(user.role, MANAGE_ROLES)) {
      throw new ForbiddenException('Tender management is for Procurement and CS.');
    }
    const ctx = { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true };
    const [ready, tenders] = await Promise.all([
      this.db.query<any>(
        `SELECT pr.id, pr.pr_number, pr.title, pr.estimated_amount, pr.created_at, pr.required_by_date,
                u.display_name AS requester, d.name AS department,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('line_no', pl.line_no,
                            'description', COALESCE(pl.description, it.name), 'quantity', pl.quantity,
                            'uom', pl.uom, 'category', pl.category) ORDER BY pl.line_no)
                            FROM proc.pr_lines pl LEFT JOIN core.items it ON it.id = pl.item_id
                           WHERE pl.pr_id = pr.id AND pl.rejected = false), '[]'::jsonb) AS lines
           FROM proc.purchase_requisitions pr
           JOIN core.users u ON u.id = pr.requester_user_id
           LEFT JOIN core.departments d ON d.id = pr.department_id
          WHERE pr.sourcing_preference = 'tender'
            AND pr.status = 'IN_PROCUREMENT_REVIEW'
            AND NOT EXISTS (SELECT 1 FROM proc.rfq r WHERE r.pr_id = pr.id AND r.state <> 'Cancelled')
          ORDER BY pr.created_at`,
        [], ctx,
      ),
      this.db.query<any>(
        `SELECT t.*,
                -- The lowest bid is a price: NULL while sealed.
                CASE WHEN t.accepting THEN NULL ELSE
                  (SELECT min(q.total_amount) FROM proc.quotations q
                    WHERE q.rfq_id = t.id AND q.state IN ('Submitted','Awarded','Rejected')) END AS lowest_bid,
                (SELECT v.legal_name FROM proc.quotations q JOIN core.vendors v ON v.id = q.vendor_id
                  WHERE q.rfq_id = t.id AND q.state = 'Awarded' LIMIT 1) AS awarded_to,
                (SELECT v.legal_name FROM proc.comparative_statements cs
                   JOIN proc.cs_line_awards a ON a.cs_id = cs.id AND a.superseded_at IS NULL
                   JOIN core.vendors v ON v.id = a.vendor_id
                  WHERE cs.pr_id = t.pr_id ORDER BY cs.cs_round DESC LIMIT 1) AS line_award_to
           FROM (${TENDER_SELECT}) t
          ORDER BY t.accepting DESC, t.deadline_at DESC
          LIMIT 300`,
        [], ctx,
      ),
    ]);

    return {
      readyToPublish: ready.rows.map((r: any) => ({
        prId: r.id,
        prNumber: r.pr_number,
        title: r.title,
        estimatedAmount: num(r.estimated_amount),
        requester: r.requester,
        department: r.department,
        createdAt: r.created_at,
        requiredBy: r.required_by_date,
        lines: json(r.lines).map((l: any) => ({
          lineNo: Number(l.line_no), description: l.description, quantity: num(l.quantity), uom: l.uom, category: l.category ?? null,
        })),
      })),
      tenders: tenders.rows.map((r: any) => ({
        ...shapeTender(r),
        prId: r.pr_id,
        prNumber: r.pr_number,
        prStage: r.pr_status,
        estimatedAmount: num(r.estimated_amount),
        biddersJoined: Number(r.bidders_joined ?? 0),
        bids: Number(r.bids ?? 0),
        lowestBid: num(r.lowest_bid),
        awardedTo: r.awarded_to ?? r.line_award_to ?? null,
      })),
    };
  }

  // ── procurement: GET /tenders/:rfqId ───────────────────────────────────────
  async detail(rfqId: string, user: { id: string; role: string; costCenterIds: string[] }) {
    if (!roleAllowed(user.role, MANAGE_ROLES)) {
      throw new ForbiddenException('Tender management is for Procurement and CS.');
    }
    const ctx = { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true };
    const t = await this.db.query<any>(`${TENDER_SELECT} AND rf.id = $1::uuid`, [rfqId], ctx);
    if (t.rows.length === 0) throw new NotFoundException('tender not found');
    const row = t.rows[0];
    const sealed = isSealed({ sourcing_mode: 'open_tender', state: row.state, deadline_at: row.deadline_at });

    const bids = await this.db.query<any>(
      `SELECT v.id AS vendor_id, v.vendor_code, v.legal_name, i.invited_at AS joined_at,
              q.id AS quotation_id, q.version, q.state, q.total_amount, q.currency,
              q.lead_time_days, q.warranty_months, q.payment_terms, q.notes, q.submitted_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name))
                          FROM proc.quotation_attachments qa
                          JOIN core.attachment_registry a ON a.id = qa.attachment_id
                         WHERE qa.quotation_id = q.id AND a.status <> 'VOID'), '[]'::jsonb) AS attachments
         FROM proc.rfq_invitations i
         JOIN core.vendors v ON v.id = i.vendor_id
         LEFT JOIN LATERAL (
           SELECT * FROM proc.quotations qq
            WHERE qq.rfq_id = i.rfq_id AND qq.vendor_id = i.vendor_id
              AND qq.state IN ('Submitted','Awarded','Rejected')
            ORDER BY qq.version DESC LIMIT 1) q ON true
        WHERE i.rfq_id = $1::uuid
        ORDER BY q.submitted_at NULLS LAST, v.legal_name`,
      [rfqId], ctx,
    );
    const shaped = bids.rows.map((b: any) => ({
      vendorId: b.vendor_id,
      vendorCode: b.vendor_code,
      vendorName: b.legal_name,
      joinedAt: b.joined_at,
      submitted: Boolean(b.quotation_id),
      submittedAt: b.submitted_at ?? null,
      state: b.state ?? null,
      total: num(b.total_amount),
      currency: b.currency ?? row.currency,
      leadTimeDays: num(b.lead_time_days),
      warrantyMonths: num(b.warranty_months),
      paymentTerms: b.payment_terms ?? null,
      notes: b.notes ?? null,
      attachments: json(b.attachments),
    }));
    const cs = await this.db.query<any>(
      `SELECT id, cs_number, state FROM proc.comparative_statements WHERE pr_id = $1::uuid ORDER BY cs_round DESC LIMIT 1`,
      [row.pr_id], ctx,
    );

    return {
      tender: {
        ...shapeTender(row),
        prId: row.pr_id,
        prNumber: row.pr_number,
        prStage: row.pr_status,
        estimatedAmount: num(row.estimated_amount),
        sealed,
      },
      // Sealed until the deadline: who has bid is visible, prices are not.
      bids: sealed ? maskBids(shaped) : shaped,
      cs: cs.rows[0] ? { id: cs.rows[0].id, csNumber: cs.rows[0].cs_number, state: cs.rows[0].state } : null,
    };
  }

  // ── requesters and HODs: GET /tenders/requests ─────────────────────────────
  async requests(user: { id: string; role: string; costCenterIds: string[] }) {
    if (!roleAllowed(user.role, STAFF_TENDER_ROLES)) {
      throw new ForbiddenException('not permitted');
    }
    // Normal session context: RLS decides which requests this user may see,
    // exactly as it does for the PR lists.
    const r = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.status, pr.estimated_amount, pr.created_at,
              pr.required_by_date, pr.requester_user_id, u.display_name AS requester, d.name AS department,
              EXISTS (SELECT 1 FROM proc.pr_departments pd
                       WHERE pd.pr_id = pr.id AND pd.hod_user_id = $1::uuid AND pd.hod_status = 'pending') AS awaiting_me,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('line_no', pl.line_no,
                          'description', COALESCE(pl.description, it.name), 'quantity', pl.quantity,
                          'uom', pl.uom, 'category', pl.category, 'unit_price_est', pl.unit_price_est)
                          ORDER BY pl.line_no)
                          FROM proc.pr_lines pl LEFT JOIN core.items it ON it.id = pl.item_id
                         WHERE pl.pr_id = pr.id), '[]'::jsonb) AS lines,
              (SELECT jsonb_build_object('id', rf.id, 'rfq_number', rf.rfq_number, 'state', rf.state,
                                         'deadline_at', rf.deadline_at,
                                         'accepting', (rf.state = 'Open' AND rf.deadline_at > now()))
                 FROM proc.rfq rf WHERE rf.pr_id = pr.id AND rf.state <> 'Cancelled'
                ORDER BY rf.created_at DESC LIMIT 1) AS tender
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         LEFT JOIN core.departments d ON d.id = pr.department_id
        WHERE pr.sourcing_preference = 'tender'
        ORDER BY pr.created_at DESC
        LIMIT 300`,
      [user.id],
      { userId: user.id, role: user.role, costCenterIds: user.costCenterIds },
    );
    return {
      requests: r.rows.map((x: any) => {
        const t = x.tender ? (typeof x.tender === 'string' ? JSON.parse(x.tender) : x.tender) : null;
        return {
          prId: x.id,
          prNumber: x.pr_number,
          title: x.title,
          stage: x.status,
          estimatedAmount: num(x.estimated_amount),
          createdAt: x.created_at,
          requiredBy: x.required_by_date,
          requester: x.requester,
          mine: x.requester_user_id === user.id,
          awaitingMe: x.awaiting_me === true || (user.role === 'hod' && x.status === 'IN_HOD_REVIEW' && x.awaiting_me === true),
          department: x.department,
          lines: json(x.lines).map((l: any) => ({
            lineNo: Number(l.line_no), description: l.description, quantity: num(l.quantity),
            uom: l.uom, category: l.category ?? null, unitPriceEst: num(l.unit_price_est),
          })),
          tender: t ? { id: t.id, rfqNumber: t.rfq_number, state: t.state, deadlineAt: t.deadline_at, accepting: t.accepting === true } : null,
        };
      }),
    };
  }

  // ── procurement: tender documents ──────────────────────────────────────────
  async uploadDocument(
    rfqId: string, user: { id: string; role: string; costCenterIds: string[] },
    req: any, fileName: string, contentType: string,
  ) {
    if (!roleAllowed(user.role, MANAGE_ROLES)) {
      throw new ForbiddenException('Only Procurement or CS may publish tender documents.');
    }
    const t = await this.db.query<any>(
      `SELECT id, rfq_number, state, (deadline_at > now()) AS before_deadline
         FROM proc.rfq WHERE id = $1::uuid AND sourcing_mode = 'open_tender'`,
      [rfqId], { bypassRls: true },
    );
    if (t.rows.length === 0) throw new NotFoundException('tender not found');
    if (t.rows[0].state !== 'Open' || t.rows[0].before_deadline !== true) {
      req.resume?.();
      throw new ConflictException(`Tender ${t.rows[0].rfq_number} is closed; documents can no longer be added.`);
    }
    const up = await this.attachments.uploadToParent('rfq', rfqId, user.id, user.role, user.costCenterIds, req, fileName, contentType);
    await this.db.query(
      `INSERT INTO proc.rfq_documents (rfq_id, attachment_id, created_by_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid) ON CONFLICT DO NOTHING RETURNING rfq_id`,
      [rfqId, up.attachment_id, user.id], { bypassRls: true },
    );
    return { id: up.attachment_id, name: up.name, size: up.size_bytes, kind: up.kind };
  }

  async removeDocument(rfqId: string, attachmentId: string, user: { id: string; role: string }) {
    if (!roleAllowed(user.role, MANAGE_ROLES)) {
      throw new ForbiddenException('Only Procurement or CS may change tender documents.');
    }
    const t = await this.db.query<any>(
      `SELECT state, (deadline_at > now()) AS before_deadline FROM proc.rfq WHERE id = $1::uuid AND sourcing_mode = 'open_tender'`,
      [rfqId], { bypassRls: true },
    );
    if (t.rows.length === 0) throw new NotFoundException('tender not found');
    if (t.rows[0].state !== 'Open' || t.rows[0].before_deadline !== true) {
      throw new ConflictException('The tender is closed; its documents are part of the record now.');
    }
    const r = await this.db.query<any>(
      `DELETE FROM proc.rfq_documents WHERE rfq_id = $1::uuid AND attachment_id = $2::uuid RETURNING attachment_id`,
      [rfqId, attachmentId], { bypassRls: true },
    );
    if (r.rows.length === 0) throw new NotFoundException('document not found on this tender');
    return { removed: attachmentId };
  }

  // ── public: GET /public/tenders, /public/tenders/:id ──────────────────────
  async publicList(status?: string) {
    const which = status === 'closed' ? 'closed' : status === 'all' ? 'all' : 'open';
    const filter = which === 'open'
      ? `AND rf.state = 'Open' AND rf.deadline_at > now()`
      : which === 'closed'
        ? `AND NOT (rf.state = 'Open' AND rf.deadline_at > now()) AND rf.deadline_at > now() - interval '90 days'`
        : `AND rf.deadline_at > now() - interval '90 days'`;
    const r = await this.db.query<any>(
      `${TENDER_SELECT} ${filter} ORDER BY (rf.state = 'Open' AND rf.deadline_at > now()) DESC, rf.deadline_at ASC LIMIT 200`,
      [], { bypassRls: true },
    );
    const rows = r.rows.map((x: any) => PUBLIC(shapeTender(x)));
    const stats = await this.db.query<any>(
      `SELECT count(*) FILTER (WHERE rf.state = 'Open' AND rf.deadline_at > now())::int AS open,
              count(*) FILTER (WHERE rf.state = 'Open' AND rf.deadline_at > now()
                                 AND rf.deadline_at < now() + interval '3 days')::int AS closing_soon,
              (SELECT count(*)::int FROM core.vendors WHERE state IN ('Active','Approved')) AS suppliers
         FROM proc.rfq rf WHERE rf.sourcing_mode = 'open_tender' AND rf.state <> 'Cancelled'`,
      [], { bypassRls: true },
    );
    const s = stats.rows[0] ?? {};
    return {
      tenders: rows,
      stats: { open: Number(s.open ?? 0), closingSoon: Number(s.closing_soon ?? 0), suppliers: Number(s.suppliers ?? 0) },
    };
  }

  async publicDetail(rfqId: string) {
    const r = await this.db.query<any>(`${TENDER_SELECT} AND rf.id = $1::uuid`, [rfqId], { bypassRls: true });
    if (r.rows.length === 0) throw new NotFoundException('tender not found');
    return PUBLIC(shapeTender(r.rows[0]));
  }

  // ── supplier: GET /supplier/tenders/:rfqId ─────────────────────────────────
  async supplierDetail(rfqId: string, user: { id: string; role: string; costCenterIds: string[]; vendorId: string }) {
    const ctx = { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true };
    const r = await this.db.query<any>(
      `${TENDER_SELECT} AND rf.id = $1::uuid`, [rfqId], ctx,
    );
    if (r.rows.length === 0) throw new NotFoundException('tender not found');
    const t = shapeTender(r.rows[0]);

    const me = await this.db.query<any>(
      `SELECT i.id AS invitation_id,
              EXISTS (SELECT 1 FROM proc.rfq_lines rl
                        JOIN proc.pr_lines pl ON pl.id = rl.pr_line_id
                        JOIN core.categories c ON c.code = pl.category
                        JOIN core.vendor_categories vc ON vc.category_id = c.id AND vc.is_active
                       WHERE rl.rfq_id = $1::uuid AND vc.vendor_id = $2::uuid) AS in_category,
              q.version, q.total_amount, q.submitted_at, q.state AS quote_state, q.lead_time_days,
              q.warranty_months, q.payment_terms, q.notes,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('lineNo', ql.rfq_line_no, 'unitPrice', ql.unit_price) ORDER BY ql.rfq_line_no)
                          FROM proc.quotation_lines ql WHERE ql.quotation_id = q.id), '[]'::jsonb) AS bid_lines,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name))
                          FROM proc.quotation_attachments qa JOIN core.attachment_registry a ON a.id = qa.attachment_id
                         WHERE qa.quotation_id = q.id), '[]'::jsonb) AS bid_docs
         FROM (SELECT 1) one
         LEFT JOIN proc.rfq_invitations i ON i.rfq_id = $1::uuid AND i.vendor_id = $2::uuid
         LEFT JOIN LATERAL (
           SELECT * FROM proc.quotations qq
            WHERE qq.rfq_id = $1::uuid AND qq.vendor_id = $2::uuid AND qq.state IN ('Submitted','Awarded','Rejected')
            ORDER BY qq.version DESC LIMIT 1) q ON true`,
      [rfqId, user.vendorId], ctx,
    );
    const m = me.rows[0] ?? {};
    const hasBid = m.version !== null && m.version !== undefined;
    // A tender outside this supplier's categories is not theirs to see — unless
    // they already joined it (then it stays in My Tenders).
    if (!m.invitation_id && m.in_category !== true) throw new NotFoundException('tender not found');

    return {
      tender: t,
      invitationId: m.invitation_id ?? null,
      eligible: m.in_category === true,
      canBid: t.accepting && !hasBid && m.in_category === true,
      myBid: hasBid
        ? {
            version: Number(m.version),
            total: num(m.total_amount),
            submittedAt: m.submitted_at,
            state: m.quote_state,
            leadTimeDays: num(m.lead_time_days),
            warrantyMonths: num(m.warranty_months),
            paymentTerms: m.payment_terms ?? null,
            remarks: m.notes ?? null,
            lines: json(m.bid_lines).map((l: any) => ({ lineNo: Number(l.lineNo), unitPrice: num(l.unitPrice) })),
            documents: json(m.bid_docs),
          }
        : null,
    };
  }

  // ── supplier: POST /supplier/tenders/:rfqId/documents ──────────────────────
  async supplierUpload(
    rfqId: string, user: { id: string; role: string; costCenterIds: string[]; vendorId: string },
    req: any, fileName: string, contentType: string,
  ) {
    const ok = await this.db.query<any>(
      `SELECT rf.rfq_number, (rf.state = 'Open' AND rf.deadline_at > now()) AS accepting,
              EXISTS (SELECT 1 FROM proc.rfq_invitations i WHERE i.rfq_id = rf.id AND i.vendor_id = $2::uuid) AS joined
         FROM proc.rfq rf WHERE rf.id = $1::uuid AND rf.sourcing_mode = 'open_tender'`,
      [rfqId, user.vendorId], { bypassRls: true },
    );
    if (ok.rows.length === 0) { req.resume?.(); throw new NotFoundException('tender not found'); }
    const t = ok.rows[0];
    if (t.joined !== true) { req.resume?.(); throw new BadRequestException('Open the tender to bid before uploading a document.'); }
    if (t.accepting !== true) { req.resume?.(); throw new ConflictException(`Tender ${t.rfq_number} is closed for bidding.`); }
    // Prefix the supplier's code: every bid document hangs off the same RFQ, and
    // the registry allows one ACTIVE file per (parent, name) — two suppliers both
    // sending "quote.pdf" would otherwise collide and the second upload fail.
    const code = await this.db.query<any>(`SELECT vendor_code FROM core.vendors WHERE id = $1::uuid`, [user.vendorId], { bypassRls: true });
    const stored = `${code.rows[0]?.vendor_code ?? 'supplier'}__${fileName}`;
    const up = await this.attachments.uploadToParent('rfq', rfqId, user.id, user.role, user.costCenterIds, req, stored, contentType);
    return { id: up.attachment_id, name: up.name, size: up.size_bytes, kind: up.kind };
  }

  async documentFile(rfqId: string, attachmentId: string) {
    return this.attachments.openTenderDocument(rfqId, attachmentId);
  }
}

/** What the public pages may see: everything published, nothing internal. */
function PUBLIC(t: ReturnType<typeof shapeTender>) {
  const { department, ...rest } = t;
  return { ...rest, department: department ?? null };
}
