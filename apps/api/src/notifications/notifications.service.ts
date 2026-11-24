import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * The signed-in user's own notifications (core.notifications, migration 005).
 *
 * Every query is filtered by the session's user id, never by an id from the
 * request, so a user can only read and mark their own rows.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService) {}

  async mine(userId: string, limit = 20) {
    const ctx = { userId, bypassRls: true };
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const [rows, unread] = await Promise.all([
      this.db.query<any>(
        `SELECT id, kind, entity, entity_id, title, body, read_at, created_at
           FROM core.notifications
          WHERE user_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT $2::int`,
        [userId, n],
        ctx,
      ),
      this.db.query<any>(
        `SELECT count(*)::int AS n FROM core.notifications
          WHERE user_id = $1::uuid AND read_at IS NULL`,
        [userId],
        ctx,
      ),
    ]);
    return {
      unread: Number(unread.rows[0]?.n ?? 0),
      items: rows.rows.map((r: any) => ({
        id: r.id,
        kind: r.kind,
        entity: r.entity,
        entityId: r.entity_id,
        title: r.title,
        body: r.body,
        read: r.read_at !== null,
        createdAt: r.created_at,
      })),
    };
  }

  async markRead(userId: string, id: string) {
    const r = await this.db.query<any>(
      `UPDATE core.notifications SET read_at = COALESCE(read_at, now())
        WHERE id = $1::uuid AND user_id = $2::uuid
      RETURNING id`,
      [id, userId],
      { userId, bypassRls: true },
    );
    // 404 for someone else's id too, so ids cannot be probed.
    if (r.rows.length === 0) throw new NotFoundException('notification not found');
    return { id, read: true };
  }

  async markAllRead(userId: string) {
    const r = await this.db.query<any>(
      `UPDATE core.notifications SET read_at = now()
        WHERE user_id = $1::uuid AND read_at IS NULL
      RETURNING id`,
      [userId],
      { userId, bypassRls: true },
    );
    return { marked: r.rows.length };
  }
}
