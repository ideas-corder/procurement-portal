-- 076 · Open tenders — an RFQ that any eligible vendor may bid on
-- ============================================================================
--
-- WHAT CHANGES
-- ------------
-- Until now every RFQ was INVITE-ONLY: procurement picks up to 12 vendors and
-- only those vendors can quote. The new sourcing route is an OPEN TENDER:
-- procurement posts the requirement with a deadline, and every eligible
-- registered vendor can see it and bid.
--
-- WHY A MODE ON proc.rfq AND NOT A NEW TABLE
-- ------------------------------------------
-- Everything downstream of sourcing hangs off `proc.rfq.id`:
--
--     proc.quotations.rfq_id              (the bids themselves)
--     proc.quotation_lines -> rfq_lines   (per-line pricing, FK enforced)
--     proc.comparative_statements.rfq_id  (the CS)
--     award / dispatch / D365             (via the CS and the quotations)
--
-- A separate `tenders` table would need a parallel copy of every one of
-- those. Making the tender an RFQ with `sourcing_mode = 'open_tender'` means a
-- bid IS a quotation, and the comparative statement, award and approval chain
-- run unchanged. The only difference is WHO may join: for an open tender a
-- vendor enrols itself (the API creates its `rfq_invitations` row when it
-- opens the tender), instead of procurement naming it.
--
-- Existing RFQs are all invite-only, so the default is 'invited' and no
-- existing row changes meaning.
--
-- `tender_notes` carries the requirement text / terms shown to bidders. An
-- invited RFQ has no use for it, so it stays NULL there.
--
-- FRESH-DATABASE SAFETY
-- ---------------------
-- The post-condition asserts only the schema shape and that no row is left
-- without a mode. It holds on an empty table, so this migration passes on a
-- brand-new database (see BACKLOG.md B-1 for why that matters).

BEGIN;

ALTER TABLE proc.rfq
  ADD COLUMN IF NOT EXISTS sourcing_mode text NOT NULL DEFAULT 'invited';

ALTER TABLE proc.rfq
  ADD COLUMN IF NOT EXISTS tender_notes text;

ALTER TABLE proc.rfq DROP CONSTRAINT IF EXISTS rfq_sourcing_mode_check;
ALTER TABLE proc.rfq
  ADD CONSTRAINT rfq_sourcing_mode_check
  CHECK (sourcing_mode IN ('invited', 'open_tender'));

ALTER TABLE proc.rfq DROP CONSTRAINT IF EXISTS rfq_tender_notes_only_on_tenders;
ALTER TABLE proc.rfq
  ADD CONSTRAINT rfq_tender_notes_only_on_tenders
  CHECK (tender_notes IS NULL OR sourcing_mode = 'open_tender');

ALTER TABLE proc.rfq DROP CONSTRAINT IF EXISTS rfq_tender_notes_length;
ALTER TABLE proc.rfq
  ADD CONSTRAINT rfq_tender_notes_length
  CHECK (tender_notes IS NULL OR length(tender_notes) <= 4000);

-- The vendor-side "Open Tenders" list reads exactly this set.
CREATE INDEX IF NOT EXISTS idx_rfq_open_tenders
  ON proc.rfq (deadline_at)
  WHERE sourcing_mode = 'open_tender' AND state = 'Open';

COMMENT ON COLUMN proc.rfq.sourcing_mode IS
  'invited = only vendors procurement named may quote; open_tender = any eligible vendor may bid until deadline_at.';
COMMENT ON COLUMN proc.rfq.tender_notes IS
  'Requirement / terms text shown to bidders on an open tender. NULL on invited RFQs.';

-- ── post-condition ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_default text;
  v_missing int;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'proc' AND table_name = 'rfq' AND column_name = 'sourcing_mode';
  IF v_default IS NULL OR v_default NOT LIKE '%invited%' THEN
    RAISE EXCEPTION 'migration 076: proc.rfq.sourcing_mode missing or not defaulted to invited (got %)', v_default;
  END IF;

  SELECT count(*) INTO v_missing
    FROM proc.rfq WHERE sourcing_mode NOT IN ('invited', 'open_tender');
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'migration 076: % RFQ row(s) carry no valid sourcing_mode', v_missing;
  END IF;
END $$;

COMMIT;
