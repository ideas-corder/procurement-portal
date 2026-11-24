import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import * as bcrypt from 'bcryptjs';
import { DbService } from '../db/db.service';

/**
 * Supplier passwords (core.users.supplier_password_hash, which existed since
 * migration 002 but was never written or read).
 *
 * A supplier created by approving an onboarding application gets a ONE-TIME
 * link to set its password (core.password_set_tokens, migration 078). The raw
 * token is returned once, shown to procurement to pass on, and queued as an
 * email in core.email_outbox + an .eml file, exactly as RFQ invitations are.
 * No SMTP is wired, so nothing is "sent" here.
 *
 * LOGIN RULE (see AuthService.login):
 *   - a vendor login WITH a password hash must present that password;
 *   - a vendor login created from an application WITHOUT a hash yet cannot sign
 *     in at all until it sets one (otherwise anyone knowing the email could);
 *   - the two seeded demo vendors, and all staff, keep the dev "any password"
 *     behaviour until real staff sign-in exists. That is unchanged on purpose.
 */
export const PASSWORD_MIN = 8;
const LINK_HOURS_DEFAULT = 168; // 7 days

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(pw: string): string | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > 128) return 'The password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'The password must contain at least one letter and one number.';
  return null;
}

@Injectable()
export class SupplierAccountService {
  private readonly log = new Logger('SupplierAccount');

  constructor(private readonly db: DbService) {}

  private static linkHours(): number {
    const n = Number(process.env.SUPPLIER_PASSWORD_LINK_HOURS);
    return Number.isFinite(n) && n > 0 ? n : LINK_HOURS_DEFAULT;
  }

  private static portalBase(): string {
    return (process.env.PUBLIC_WEB_URL || 'http://localhost:33002').replace(/\/+$/, '');
  }

  /**
   * Mint a set-password link for a supplier login, retire any earlier unused
   * link for it, and queue the email. Returns the link ONCE.
   */
  async issueSetPasswordLink(userId: string, createdBy: string) {
    const ctx = { userId: createdBy, bypassRls: true };
    const u = await this.db.query<any>(
      `SELECT u.id, u.email, u.display_name, u.role, u.vendor_id, v.vendor_code, v.legal_name
         FROM core.users u LEFT JOIN core.vendors v ON v.id = u.vendor_id
        WHERE u.id = $1::uuid AND u.active`,
      [userId], ctx,
    );
    if (u.rows.length === 0) throw new NotFoundException('login not found');
    const user = u.rows[0];
    if (user.role !== 'vendor') throw new BadRequestException('Password links are for supplier logins only.');

    // One live link per login: an older link is a second credential.
    await this.db.query(
      `UPDATE core.password_set_tokens SET used_at = now()
        WHERE user_id = $1::uuid AND used_at IS NULL
      RETURNING id`,
      [userId], ctx,
    );

    const raw = randomBytes(32).toString('base64url');
    const hours = SupplierAccountService.linkHours();
    const t = await this.db.query<any>(
      `INSERT INTO core.password_set_tokens (user_id, token_hash, expires_at, created_by_user_id)
       VALUES ($1::uuid, $2, now() + ($3::int || ' hours')::interval, $4::uuid)
       RETURNING id, expires_at`,
      [userId, hashToken(raw), hours, createdBy], ctx,
    );
    const expiresAt = t.rows[0].expires_at;
    const link = `${SupplierAccountService.portalBase()}/set-password/${raw}`;

    const subject = 'Your PakBoxes supplier portal account';
    const bodyText = [
      `Dear ${user.legal_name ?? user.display_name},`,
      '',
      'Your application to supply PakBoxes has been approved, and a supplier portal account has been created for you.',
      `Sign-in email: ${user.email}`,
      '',
      `Set your password here (the link works once and expires ${expiresAt}):`,
      link,
      '',
      'After that, sign in to see open tenders in your categories and submit bids.',
    ].join('\n');
    const bodyHtml =
      `<p>Dear ${user.legal_name ?? user.display_name},</p>` +
      `<p>Your application to supply PakBoxes has been approved. Sign-in email: <strong>${user.email}</strong></p>` +
      `<p><a href="${link}">Set your password</a> (works once, expires ${expiresAt}).</p>`;

    let outboxId: string | null = null;
    try {
      const ob = await this.db.query<any>(
        `INSERT INTO core.email_outbox
           (to_vendor_id, to_email, subject, body_text, body_html, template, payload, state, created_by_user_id)
         VALUES ($1::uuid, $2, $3, $4, $5, 'supplier_set_password', $6::jsonb, 'pending', $7::uuid)
         RETURNING id`,
        [user.vendor_id, user.email, subject, bodyText, bodyHtml,
         JSON.stringify({ user_id: userId, expires_at: expiresAt }), createdBy],
        ctx,
      );
      outboxId = String(ob.rows[0]?.id ?? '');
      const dir = await this.outboxDir();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${outboxId}-${user.vendor_code ?? 'supplier'}-password.eml`), [
        'From: procurement@pakboxes.pk', `To: ${user.email}`, `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`, 'Content-Type: text/plain; charset=utf-8', '', bodyText,
      ].join('\r\n'));
    } catch (e: any) {
      // The link is still valid and is returned to procurement to pass on.
      this.log.warn(`could not queue the set-password email for ${user.email}: ${e?.message ?? e}`);
    }

    return { link, expiresAt, email: user.email, outboxId };
  }

  /** GET /auth/set-password/:token — what the page shows before the form. */
  async describe(raw: string) {
    const r = await this.db.query<any>(
      `SELECT t.expires_at, t.used_at, u.email, u.display_name, (t.expires_at <= now()) AS expired
         FROM core.password_set_tokens t JOIN core.users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND u.active`,
      [hashToken(String(raw ?? ''))], { bypassRls: true },
    );
    if (r.rows.length === 0) return { valid: false, reason: 'This link is not valid.' };
    const t = r.rows[0];
    if (t.used_at) return { valid: false, reason: 'This link has already been used. Ask Procurement for a new one if you need to reset your password.' };
    if (t.expired === true) return { valid: false, reason: 'This link has expired. Ask Procurement for a new one.' };
    return { valid: true, email: t.email, displayName: t.display_name, expiresAt: t.expires_at };
  }

  /** POST /auth/set-password — consume the link and store the bcrypt hash. */
  async setPassword(raw: string, password: string) {
    const problem = passwordProblem(password);
    if (problem) throw new BadRequestException(problem);
    const d = await this.describe(raw);
    if (!d.valid) throw new BadRequestException(d.reason);

    // Consume FIRST, guarded on used_at IS NULL, so two submissions of the same
    // link cannot both succeed.
    const used = await this.db.query<any>(
      `UPDATE core.password_set_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
      [hashToken(raw)], { bypassRls: true },
    );
    if (used.rows.length === 0) throw new BadRequestException('This link has already been used.');
    const hash = await bcrypt.hash(password, 10);
    await this.db.query(
      `UPDATE core.users SET supplier_password_hash = $2, supplier_locked_until = NULL, updated_at = now()
        WHERE id = $1::uuid AND role = 'vendor'
      RETURNING id`,
      [used.rows[0].user_id, hash], { bypassRls: true },
    );
    return { ok: true, email: d.email, message: 'Password set. You can now sign in.' };
  }

  /**
   * The vendor half of the login rule. Returns null when the password is
   * acceptable, or the refusal message.
   */
  async checkVendorPassword(userId: string, password: string | undefined): Promise<string | null> {
    const r = await this.db.query<any>(
      `SELECT u.supplier_password_hash AS hash,
              EXISTS (SELECT 1 FROM core.vendor_applications a WHERE a.login_user_id = u.id) AS from_application
         FROM core.users u WHERE u.id = $1::uuid`,
      [userId], { bypassRls: true },
    );
    const row = r.rows[0];
    if (!row) return 'invalid credentials';
    if (row.hash) {
      const ok = await bcrypt.compare(String(password ?? ''), String(row.hash));
      return ok ? null : 'invalid credentials';
    }
    if (row.from_application === true) {
      return 'This supplier account has no password yet. Use the set-password link Procurement sent you.';
    }
    return null; // seeded demo supplier: dev behaviour, unchanged
  }

  private async outboxDir(): Promise<string> {
    const configured = process.env.OUTBOX_ROOT;
    if (configured && configured.trim()) return resolve(configured.trim());
    let dir = __dirname;
    for (let hop = 0; hop < 8; hop++) {
      if (existsSync(join(dir, 'apps')) && existsSync(join(dir, 'db')) && existsSync(join(dir, 'package.json'))) {
        return resolve(dir, 'var', 'outbox');
      }
      const up = resolve(dir, '..');
      if (up === dir) break;
      dir = up;
    }
    return resolve(__dirname, '..', '..', 'var', 'outbox');
  }
}
