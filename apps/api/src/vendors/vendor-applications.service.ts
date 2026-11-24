import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { roleAllowed } from '@procurement/roles';
import { DbService } from '../db/db.service';
import { VendorGovernanceService } from './vendor-governance.service';
import { SupplierAccountService } from '../auth/supplier-account.service';

/**
 * Approve or reject a public onboarding application (core.vendor_applications).
 *
 * APPROVE turns an application into a working supplier, in this order:
 *   1. a core.vendors row (state Approved, a fresh V-NNNNN code),
 *   2. its line category, through VendorGovernanceService.setCategories() so the
 *      mapping is written by the one audited path that owns it,
 *   3. a supplier login (core.users, role vendor, linked to the vendor),
 *   4. the application marked Approved and linked to both, plus an audit row.
 *
 * Every check runs BEFORE the first write. DbService commits each statement on
 * its own, so a refusal raised after a write would leave half an approval behind.
 *
 * REJECT marks the application Rejected with a required reason. Nothing else
 * is created.
 *
 * Who: Procurement or the Committee Secretary, the same roles that govern
 * vendor holds and categories.
 */
@Injectable()
export class VendorApplicationsService {
  constructor(
    private readonly db: DbService,
    private readonly gov: VendorGovernanceService,
    private readonly accounts: SupplierAccountService,
  ) {}

  private assertCanDecide(role: string) {
    if (!roleAllowed(role, 'procurement,cs')) {
      throw new ForbiddenException('Only Procurement or the Committee Secretary may decide vendor applications.');
    }
  }

  private static looksLikeEmail(s: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  private async load(id: string, ctx: any) {
    const r = await this.db.query<any>(
      `SELECT id, reference, legal_name, ntn, contact_name, contact_email, categories, state
         FROM core.vendor_applications WHERE id = $1::uuid`,
      [id],
      ctx,
    );
    if (r.rows.length === 0) throw new NotFoundException('application not found');
    const a = r.rows[0];
    if (!['Submitted', 'Under_Review'].includes(a.state)) {
      throw new ConflictException(`Application ${a.reference} is already ${a.state}.`);
    }
    return a;
  }

  // ── POST /vendors/applications/:id/approve ────────────────────────────────
  async approve(
    id: string,
    user: { id: string; role: string; costCenterIds: string[] },
    body: { contactEmail?: string; categories?: string[]; note?: string },
  ) {
    this.assertCanDecide(user.role);
    const ctx = { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true };
    const app = await this.load(id, ctx);

    // ── checks, all before any write ──────────────────────────────────────
    const email = String(body?.contactEmail ?? app.contact_email ?? '').trim();
    if (!email) {
      throw new BadRequestException(
        `Application ${app.reference} has no contact email, and the supplier login needs one. ` +
        'Pass contactEmail to approve it.',
      );
    }
    if (!VendorApplicationsService.looksLikeEmail(email)) {
      throw new BadRequestException(`"${email}" is not a valid email address.`);
    }
    const taken = await this.db.query<any>(
      `SELECT role FROM core.users WHERE email = $1 LIMIT 1`, [email], ctx,
    );
    if (taken.rows.length > 0) {
      throw new ConflictException(
        `A login already exists for ${email}. Use a different contact email for this supplier.`,
      );
    }
    const dupNtn = await this.db.query<any>(
      `SELECT vendor_code, legal_name FROM core.vendors
        WHERE ntn = $1 AND state NOT IN ('Rejected','Deactivated') LIMIT 1`,
      [app.ntn], ctx,
    );
    if (dupNtn.rows.length > 0) {
      throw new ConflictException(
        `NTN ${app.ntn} already belongs to vendor ${dupNtn.rows[0].vendor_code} ` +
        `(${dupNtn.rows[0].legal_name}). Reject this application as a duplicate instead.`,
      );
    }

    const requested = (Array.isArray(body?.categories) && body.categories.length
      ? body.categories
      : String(app.categories ?? '').split(','))
      .map((c) => String(c).trim()).filter(Boolean);
    if (requested.length === 0) {
      throw new BadRequestException(
        `Application ${app.reference} names no category. Pass categories to approve it: ` +
        'a vendor with no category is never offered an RFQ or a tender.',
      );
    }
    const known = await this.db.query<any>(
      `SELECT code FROM core.categories WHERE active AND (upper(code) = ANY($1::text[]) OR upper(name) = ANY($1::text[]))`,
      [`{${requested.map((c) => `"${c.toUpperCase().replace(/"/g, '')}"`).join(',')}}`],
      ctx,
    );
    if (known.rows.length === 0) {
      throw new BadRequestException(`None of ${requested.join(', ')} is an active line category.`);
    }

    const note = String(body?.note ?? '').trim() || null;

    // ── 1. the vendor ─────────────────────────────────────────────────────
    const v = await this.db.query<any>(
      `INSERT INTO core.vendors
         (vendor_code, legal_name, ntn, contact_name, contact_email, contacts, state,
          created_by_user_id, approved_by_user_id, approved_at)
       VALUES (core.fn_next_vendor_code(), $1, $2, $3, $4,
               jsonb_build_array(jsonb_build_object('name', $3::text, 'email', $4::text)),
               'Approved', $5::uuid, $5::uuid, now())
       RETURNING id, vendor_code, legal_name, state`,
      [app.legal_name, app.ntn, app.contact_name ?? null, email, user.id],
      ctx,
    );
    const vendor = v.rows[0];

    // ── 2. its category, through the audited governance path ─────────────
    await this.gov.setCategories(
      vendor.id, user.id, user.role, user.costCenterIds,
      requested, `Approved from onboarding application ${app.reference}`,
    );

    // ── 3. the supplier login ─────────────────────────────────────────────
    const u = await this.db.query<any>(
      `INSERT INTO core.users (email, display_name, role, vendor_id, active)
       VALUES ($1, $2, 'vendor', $3::uuid, true)
       RETURNING id, email`,
      [email, app.legal_name, vendor.id],
      ctx,
    );
    const login = u.rows[0];

    // ── 4. the application, and the decision on record ───────────────────
    await this.db.query(
      `UPDATE core.vendor_applications
          SET state = 'Approved', reviewed_by_user_id = $2::uuid, reviewed_at = now(),
              decision_note = $3, vendor_id = $4::uuid, login_user_id = $5::uuid
        WHERE id = $1::uuid
      RETURNING id`,
      [id, user.id, note, vendor.id, login.id],
      ctx,
    );
    await this.db.query(
      `INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, before, after, reason)
       VALUES ($1::uuid, 'core.vendor_applications', $2::text, 'approve',
               jsonb_build_object('state', $3::text),
               jsonb_build_object('state', 'Approved', 'vendor_id', $4::text,
                                  'vendor_code', $5::text, 'login_email', $6::text),
               $7)`,
      [user.id, id, app.state, vendor.id, vendor.vendor_code, email, note],
      ctx,
    );

    // ── 5. the one-time set-password link (shown once, also queued as email) ─
    const link = await this.accounts.issueSetPasswordLink(login.id, user.id);

    return {
      application: { id, reference: app.reference, state: 'Approved' },
      vendor: { id: vendor.id, vendorCode: vendor.vendor_code, legalName: vendor.legal_name, state: vendor.state },
      login: { userId: login.id, email: login.email },
      categories: known.rows.map((r: any) => r.code),
      // DELIVERED ONCE: only sha256 of the token is stored.
      passwordLink: { url: link.link, expiresAt: link.expiresAt, emailQueued: Boolean(link.outboxId) },
    };
  }

  // ── POST /vendors/applications/:id/password-link ──────────────────────────
  /** A fresh set-password link for an approved application's login (old one retired). */
  async newPasswordLink(id: string, user: { id: string; role: string; costCenterIds: string[] }) {
    this.assertCanDecide(user.role);
    const r = await this.db.query<any>(
      `SELECT reference, state, login_user_id FROM core.vendor_applications WHERE id = $1::uuid`,
      [id], { userId: user.id, role: user.role, bypassRls: true },
    );
    if (r.rows.length === 0) throw new NotFoundException('application not found');
    const a = r.rows[0];
    if (a.state !== 'Approved' || !a.login_user_id) {
      throw new ConflictException(`Application ${a.reference} has no supplier login to send a link for.`);
    }
    const link = await this.accounts.issueSetPasswordLink(a.login_user_id, user.id);
    return { reference: a.reference, passwordLink: { url: link.link, expiresAt: link.expiresAt, emailQueued: Boolean(link.outboxId) } };
  }

  // ── POST /vendors/applications/:id/reject ─────────────────────────────────
  async reject(
    id: string,
    user: { id: string; role: string; costCenterIds: string[] },
    reason?: string,
  ) {
    this.assertCanDecide(user.role);
    const why = String(reason ?? '').trim();
    if (!why) throw new BadRequestException('A reason is required to reject an application.');
    const ctx = { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true };
    const app = await this.load(id, ctx);

    await this.db.query(
      `UPDATE core.vendor_applications
          SET state = 'Rejected', reviewed_by_user_id = $2::uuid, reviewed_at = now(), decision_note = $3
        WHERE id = $1::uuid
      RETURNING id`,
      [id, user.id, why],
      ctx,
    );
    await this.db.query(
      `INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, before, after, reason)
       VALUES ($1::uuid, 'core.vendor_applications', $2::text, 'reject',
               jsonb_build_object('state', $3::text), jsonb_build_object('state', 'Rejected'), $4)`,
      [user.id, id, app.state, why],
      ctx,
    );
    return { application: { id, reference: app.reference, state: 'Rejected' }, reason: why };
  }
}
