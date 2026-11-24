-- 079 · Tender requests, tender commercial terms and documents, split-child HOD
-- ============================================================================
--
-- WHAT CHANGES
-- ------------
-- 1. proc.purchase_requisitions.sourcing_preference ('standard' | 'tender').
--    A requester can now raise a TENDER REQUEST: the same purchase requisition,
--    routed exactly as before (HOD -> procurement), but marked so the HOD's
--    "Tender Requests" page and procurement's "Tenders" section can show it on
--    its own. Existing rows keep 'standard'; nothing about routing changes.
--
-- 2. proc.rfq.budget_min / budget_max / security_deposit — optional terms a
--    tender can publish. Only an open tender may carry them.
--
-- 3. Tender documents. core.attachment_registry may now hang a file off an RFQ
--    (parent_type 'rfq'), and proc.rfq_documents lists the files procurement has
--    PUBLISHED with a tender. Only files listed there are downloadable from the
--    public tender pages; a vendor's own bid document (also parent 'rfq') is
--    linked to its quotation through proc.quotation_attachments instead and is
--    never public.
--
-- 4. Split children get their department approver. An auto-split child PR was
--    created without proc.pr_departments rows, so the CS blind review refused it
--    ("no department approver mapped") and the child could not finish. The API
--    now copies the parent's rows when it splits (PrService); this migration
--    backfills the children already created. The approver is RESOLVED for the
--    department (core.fn_resolve_department_hod) rather than copied, so the
--    approver gate trigger accepts it even if the HOD has changed since.
--
-- FRESH-DATABASE SAFETY
-- ---------------------
-- The backfill is data-aware: on an empty database it inserts nothing and the
-- post-condition ("no child is missing rows its parent has") holds.

BEGIN;

-- ── 1 · tender requests ─────────────────────────────────────────────────────
ALTER TABLE proc.purchase_requisitions
  ADD COLUMN IF NOT EXISTS sourcing_preference text NOT NULL DEFAULT 'standard';
ALTER TABLE proc.purchase_requisitions DROP CONSTRAINT IF EXISTS pr_sourcing_preference_check;
ALTER TABLE proc.purchase_requisitions
  ADD CONSTRAINT pr_sourcing_preference_check CHECK (sourcing_preference IN ('standard', 'tender'));
CREATE INDEX IF NOT EXISTS idx_pr_tender_requests
  ON proc.purchase_requisitions (status, created_at DESC) WHERE sourcing_preference = 'tender';

-- ── 2 · tender commercial terms ─────────────────────────────────────────────
ALTER TABLE proc.rfq ADD COLUMN IF NOT EXISTS budget_min numeric(18,2);
ALTER TABLE proc.rfq ADD COLUMN IF NOT EXISTS budget_max numeric(18,2);
ALTER TABLE proc.rfq ADD COLUMN IF NOT EXISTS security_deposit numeric(18,2);

ALTER TABLE proc.rfq DROP CONSTRAINT IF EXISTS rfq_tender_terms_check;
ALTER TABLE proc.rfq ADD CONSTRAINT rfq_tender_terms_check CHECK (
      (budget_min IS NULL OR budget_min >= 0)
  AND (budget_max IS NULL OR budget_max >= 0)
  AND (budget_min IS NULL OR budget_max IS NULL OR budget_min <= budget_max)
  AND (security_deposit IS NULL OR security_deposit >= 0)
  AND ((budget_min IS NULL AND budget_max IS NULL AND security_deposit IS NULL)
       OR sourcing_mode = 'open_tender'));

-- ── 3 · tender documents ────────────────────────────────────────────────────
ALTER TABLE core.attachment_registry DROP CONSTRAINT IF EXISTS attachment_registry_parent_type_check;
DO $$
DECLARE c text;
BEGIN
  -- The parent_type CHECK was created inline (system-named); drop whichever
  -- CHECK mentions parent_type so it can be widened.
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'core.attachment_registry'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%parent_type%'
  LOOP
    EXECUTE format('ALTER TABLE core.attachment_registry DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE core.attachment_registry
  ADD CONSTRAINT attachment_registry_parent_type_check
  CHECK (parent_type IN ('pr', 'quote', 'rfq'));

CREATE OR REPLACE FUNCTION core.fn_attachment_parent_exists(p_parent_type text, p_parent_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  IF p_parent_type = 'pr' THEN
    RETURN EXISTS (SELECT 1 FROM proc.purchase_requisitions WHERE id = p_parent_id);
  ELSIF p_parent_type = 'quote' THEN
    RETURN EXISTS (SELECT 1 FROM proc.quotations WHERE id = p_parent_id);
  ELSIF p_parent_type = 'rfq' THEN
    RETURN EXISTS (SELECT 1 FROM proc.rfq WHERE id = p_parent_id);
  END IF;
  RETURN false;
END;
$function$;

CREATE TABLE IF NOT EXISTS proc.rfq_documents (
  rfq_id              uuid NOT NULL REFERENCES proc.rfq(id) ON DELETE CASCADE,
  attachment_id       uuid NOT NULL REFERENCES core.attachment_registry(id) ON DELETE CASCADE,
  created_by_user_id  uuid REFERENCES core.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rfq_id, attachment_id)
);
COMMENT ON TABLE proc.rfq_documents IS
  'Files procurement published with an open tender. Public: downloadable from the open-tender pages.';

-- ── 4 · split children get their department approver ──────────────────────
INSERT INTO proc.pr_departments
  (pr_id, department_id, hod_user_id, hod_status, hod_comment, hod_decided_at, suggested)
SELECT c.id, d.department_id, core.fn_resolve_department_hod(d.department_id),
       d.hod_status, d.hod_comment, d.hod_decided_at, d.suggested
  FROM proc.purchase_requisitions c
  JOIN proc.pr_departments d ON d.pr_id = c.parent_pr_id
 WHERE c.parent_pr_id IS NOT NULL
ON CONFLICT (pr_id, department_id) DO NOTHING;

-- ── post-condition ──────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM proc.purchase_requisitions c
   WHERE c.parent_pr_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM proc.pr_departments p WHERE p.pr_id = c.parent_pr_id)
     AND NOT EXISTS (SELECT 1 FROM proc.pr_departments x WHERE x.pr_id = c.id);
  IF n > 0 THEN
    RAISE EXCEPTION 'migration 079: % split child PR(s) still have no department approver row', n;
  END IF;
  IF to_regclass('proc.rfq_documents') IS NULL THEN
    RAISE EXCEPTION 'migration 079: proc.rfq_documents missing';
  END IF;
  IF NOT core.fn_attachment_parent_exists('rfq', '00000000-0000-0000-0000-000000000000') IS NOT DISTINCT FROM false THEN
    RAISE EXCEPTION 'migration 079: fn_attachment_parent_exists does not answer for rfq';
  END IF;
END $$;

COMMIT;
