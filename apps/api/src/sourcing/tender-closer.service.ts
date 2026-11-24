import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RfqService } from './rfq.service';

/**
 * Closes open tenders when their deadline passes.
 *
 * Bids are already refused after the deadline at write time, so this timer is
 * not what enforces the deadline. It moves the tender's state to Closed, writes
 * the audit row and notifies procurement (proc.fn_close_due_tenders). A tick
 * that finds nothing due costs one query.
 *
 * Interval: TENDER_CLOSE_INTERVAL_MS (default 60000). Set it to 0 to switch the
 * timer off, e.g. when a second API instance already runs it; closing twice is
 * harmless either way because only Open tenders match.
 */
@Injectable()
export class TenderCloserService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TenderCloser');
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly rfqs: RfqService) {}

  onModuleInit() {
    const raw = process.env.TENDER_CLOSE_INTERVAL_MS;
    const every = raw === undefined || raw === '' ? 60_000 : Number(raw);
    if (!Number.isFinite(every) || every <= 0) {
      this.log.log('tender auto-close timer is off (TENDER_CLOSE_INTERVAL_MS <= 0)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), every);
    // Do not hold the process open just for this timer.
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    // One docker-exec query can outlast a short interval; never overlap ticks.
    if (this.running) return;
    this.running = true;
    try {
      const closed = await this.rfqs.closeDueTenders();
      for (const t of closed) {
        this.log.log(`closed ${t.rfqNumber}: deadline ${t.deadlineAt}, ${t.bids} bid(s)`);
      }
    } catch (e: any) {
      // A failed tick is retried on the next one; do not crash the API.
      this.log.error(`tender auto-close failed: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }
}
