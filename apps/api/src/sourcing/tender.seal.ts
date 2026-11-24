// tender.seal.ts — sealed bidding for open tenders.
//
// Until an open tender's deadline passes, NOBODY on the buying side may see a
// bid's price or commercial terms: not procurement, not CS, not an admin. They
// may see that a vendor joined and that a bid exists, nothing more. When the
// deadline passes (or the tender is closed) the bids open for everyone at once.
//
// This stops the classic leak: a buyer reads vendor A's price and tips off
// vendor B, who still has time to revise and undercut it. Vendors can revise
// until the deadline, so the leak would be real.
//
// The rule is applied on the SERVER, to every payload that carries bid money,
// with maskBids(). The UI only renders what it is sent.
//
// Invited RFQs are untouched: their quotes stay visible as before.

/** SQL: this RFQ row (alias `rf`) is an open tender still before its deadline. */
export const SEALED_RFQ_SQL = `(rf.sourcing_mode = 'open_tender' AND rf.state = 'Open' AND rf.deadline_at > now())`;

/** The same rule over an RFQ row already read (needs sourcing_mode, state, deadline_at). */
export function isSealed(rfq: { sourcing_mode?: string | null; state?: string | null; deadline_at?: string | Date | null } | null | undefined): boolean {
  if (!rfq || rfq.sourcing_mode !== 'open_tender' || rfq.state !== 'Open' || !rfq.deadline_at) return false;
  return new Date(rfq.deadline_at as any).getTime() > Date.now();
}

/**
 * Every key that carries a bid's price or commercial terms, in any of the
 * shapes the sourcing payloads use (quotation rows, live quotes, version chains,
 * per-line prices, rfq-list rollups).
 */
const SEALED_KEYS = new Set<string>([
  'total', 'total_amount', 'totalAmount', 'normalized_total_pkr', 'fx_rate',
  'unit_price', 'unitPrice', 'line_total', 'lineTotal', 'amount',
  'lowest_bid', 'lowestBid',
  'lead_time_days', 'leadTimeDays', 'warranty_months', 'warrantyMonths',
  'line_warranty_min', 'line_warranty_max',
  'validity_days', 'valid_until', 'valid_until_days', 'validUntil',
  'payment_terms', 'paymentTerms', 'notes', 'remarks',
  'tax_breakdown', 'taxes_included',
]);

/**
 * Deep copy of `x` with every bid price / term set to null and every
 * `attachments` list emptied (the vendor's own document shows the prices).
 * Identity fields (vendor name, version, state, submitted_at) are kept, so the
 * buyer can still see who has bid.
 */
export function maskBids<T>(x: T): T {
  if (Array.isArray(x)) return x.map((v) => maskBids(v)) as any;
  if (x === null || typeof x !== 'object' || x instanceof Date) return x;
  const out: any = {};
  for (const [k, v] of Object.entries(x as any)) {
    if (SEALED_KEYS.has(k)) out[k] = null;
    else if (k === 'attachments') out[k] = [];
    else out[k] = maskBids(v);
  }
  out.sealed = true;
  return out;
}

/** The note the UI shows in place of the prices. */
export function sealedNote(deadline: string | Date | null | undefined): string {
  const when = deadline ? new Date(deadline as any).toISOString() : 'the deadline';
  return `Sealed tender: bid prices and terms stay hidden from everyone until ${when}.`;
}
