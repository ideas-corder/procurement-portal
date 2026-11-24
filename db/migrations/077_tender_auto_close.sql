-- 077 · Open tenders close themselves at the deadline
-- ============================================================================
--
-- WHAT CHANGES
-- ------------
-- Bidding on an open tender already stops at deadline_at (the quote write path
-- refuses it, see QuotationService.appendVersion). This migration makes the
-- tender's own state follow: a tender past its deadline moves Open -> Closed,
-- an audit row records it, and every active procurement user gets a
-- notification so someone takes it to the comparative statement.
--
-- proc.fn_close_due_tenders() does all three in ONE statement. The API calls it
-- on a timer (TenderCloserService). DbService gives each statement its own
-- transaction, so keeping the close, the audit row and the notifications in a
-- single SQL call is what makes them succeed or fail together.
--
-- Closed is a state the RFQ already had (POST /pr/:id/ready-for-cs sets it), and
-- both ready-for-cs and the CS award accept a Closed RFQ, so the rest of the
-- flow continues unchanged.
--
-- Invited RFQs are never touched: their deadline is display-only.
--
-- FRESH-DATABASE SAFETY
-- ---------------------
-- The post-condition checks the vocabulary and that the function runs. Both
-- hold on an empty database.

BEGIN;

-- ── A · audit vocabulary gains 'tender_close' ───────────────────────────────
-- Body is 061's, unchanged, with one action appended to the canon. It unions
-- the canon with the actions the installed CHECK already permits, so it can
-- only ever widen the vocabulary.
CREATE OR REPLACE FUNCTION audit.fn_widen_audit_log_actions() RETURNS void AS $body$
DECLARE
  canon text[] := ARRAY[
    'create','update','delete','approve','reject','return','push','reassign',
    'login','logout','workflow_config_change','pack_freeze','pack_push',
    'sod_violation','dead_letter',
    'hold','unhold','category_change','vendor_update','d365_vendor_sync',
    'phone_negotiation','cs_line_award','cs_split_lock',
    'po_generate','po_issue','po_push','po_cancel',
    'd365_master_sync','d365_po_push',
    'category_enable','category_disable','category_unlink',
    'repair',
    'rfq_reissue',
    -- 077: an open tender reached its deadline and stopped taking bids.
    'tender_close'
  ];
  canon_literal text;
  def text;
  permitted text[];
  merged text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF def IS NULL THEN
    SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(canon) AS a;
    EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
            'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO permitted
    FROM regexp_matches(def, $q$'([^']+)'$q$, 'g') AS m;

  IF array_length(permitted, 1) IS NULL THEN
    RAISE EXCEPTION
      'fn_widen_audit_log_actions: could not read the permitted action list out of '
      'audit_log_action_check, so rebuilding it could NARROW the audit vocabulary. '
      'Refusing to run. Installed definition: %', def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM unnest(canon) a WHERE NOT (a = ANY(permitted))) THEN
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[])
    INTO merged
    FROM unnest(canon || permitted) AS x;

  SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(merged) AS a;

  EXECUTE 'ALTER TABLE audit.audit_log DROP CONSTRAINT audit_log_action_check';
  EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
          'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
END
$body$ LANGUAGE plpgsql;

SELECT audit.fn_widen_audit_log_actions();

-- ── B · the closer ──────────────────────────────────────────────────────────
-- Returns one row per tender it closed. Safe to call as often as you like: a
-- tender is closed exactly once, because only state = 'Open' rows match.
CREATE OR REPLACE FUNCTION proc.fn_close_due_tenders()
RETURNS TABLE (rfq_id uuid, rfq_number text, pr_id uuid, deadline_at timestamptz, bids int)
LANGUAGE sql AS $fn$
  WITH closed AS (
    UPDATE proc.rfq r
       SET state = 'Closed'
     WHERE r.sourcing_mode = 'open_tender'
       AND r.state = 'Open'
       AND r.deadline_at <= now()
    RETURNING r.id, r.rfq_number, r.pr_id, r.deadline_at
  ),
  counted AS (
    SELECT c.*,
           (SELECT count(DISTINCT q.vendor_id)::int
              FROM proc.quotations q
             WHERE q.rfq_id = c.id AND q.state = 'Submitted') AS bids
      FROM closed c
  ),
  audited AS (
    INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, before, after, reason)
    SELECT NULL, 'rfq', c.id::text, 'tender_close',
           jsonb_build_object('state', 'Open'),
           jsonb_build_object('state', 'Closed', 'bids', c.bids, 'deadline_at', c.deadline_at),
           'deadline reached'
      FROM counted c
    RETURNING 1
  ),
  notified AS (
    INSERT INTO core.notifications (user_id, kind, entity, entity_id, title, body, channels_sent)
    SELECT u.id, 'TENDER_CLOSED', 'rfq', c.id::text,
           'Tender ' || c.rfq_number || ' closed - ' || c.bids || ' bid' ||
             CASE WHEN c.bids = 1 THEN '' ELSE 's' END,
           CASE WHEN c.bids = 0
                THEN 'The deadline passed with no bids. Re-issue or cancel the tender.'
                ELSE 'The deadline passed. The bids are ready for the comparative statement.'
           END,
           ARRAY['bell']
      FROM counted c
     CROSS JOIN core.users u
     WHERE u.role = 'procurement' AND u.active
    RETURNING 1
  )
  SELECT c.id, c.rfq_number, c.pr_id, c.deadline_at, c.bids
    FROM counted c
   -- Referencing the side-effect CTEs keeps their row counts visible to the
   -- planner; data-modifying CTEs run regardless, this is belt and braces.
   WHERE (SELECT count(*) FROM audited) >= 0
     AND (SELECT count(*) FROM notified) >= 0;
$fn$;

COMMENT ON FUNCTION proc.fn_close_due_tenders() IS
  'Close every open tender past its deadline (Open -> Closed), write a tender_close audit row and notify procurement. Idempotent.';

-- ── post-condition ──────────────────────────────────────────────────────────
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;
  IF v_def IS NULL OR position('''tender_close''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'migration 077: audit_log_action_check does not permit tender_close';
  END IF;
  IF position('''rfq_reissue''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'migration 077: widening narrowed the audit vocabulary (rfq_reissue missing)';
  END IF;
  IF to_regprocedure('proc.fn_close_due_tenders()') IS NULL THEN
    RAISE EXCEPTION 'migration 077: proc.fn_close_due_tenders() missing';
  END IF;
END $$;

COMMIT;
