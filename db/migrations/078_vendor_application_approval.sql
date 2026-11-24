-- 078 · Approving a vendor application creates the vendor and its login
-- ============================================================================
--
-- WHAT CHANGES
-- ------------
-- The public onboarding form has always written core.vendor_applications, but
-- nothing could act on an application: no approve, no reject, and so no path
-- from "a company applied" to "a vendor that can bid". This migration adds the
-- three things that path needs in the database:
--
--   1. core.fn_next_vendor_code() — the next free V-NNNNN code. There was no
--      generator; the existing codes were written by the seed. The function
--      skips any code already taken, so it is safe whether it runs before or
--      after the seed on a fresh database.
--
--   2. vendor_applications.vendor_id / login_user_id — which vendor record and
--      which supplier login an approval produced, so the decision is traceable
--      from the application.
--
--   3. core.password_set_tokens — one-time links a new supplier uses to set its
--      password. Only the SHA-256 of the token is stored (the raw token is shown
--      once, like RFQ invitation tokens). A token expires and can be used once.
--
-- FRESH-DATABASE SAFETY
-- ---------------------
-- Nothing here reads seeded rows. The post-condition checks shape only.

BEGIN;

-- ── 1 · vendor codes ────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS core.vendor_code_seq START 1;

CREATE OR REPLACE FUNCTION core.fn_next_vendor_code()
RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
  n bigint;
  code text;
BEGIN
  -- Start above the highest numeric code already present, then skip any code
  -- that is taken. The loop is what makes a seed that runs later (V-00081 …)
  -- harmless.
  PERFORM setval('core.vendor_code_seq',
                 GREATEST((SELECT last_value FROM core.vendor_code_seq),
                          COALESCE((SELECT max(substring(vendor_code FROM '^V-(\d+)$')::bigint)
                                      FROM core.vendors
                                     WHERE vendor_code ~ '^V-\d+$'), 0)),
                 true);
  LOOP
    n := nextval('core.vendor_code_seq');
    code := 'V-' || lpad(n::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM core.vendors WHERE vendor_code = code);
  END LOOP;
  RETURN code;
END
$fn$;

COMMENT ON FUNCTION core.fn_next_vendor_code() IS
  'Next free vendor code V-NNNNN (above the highest existing numeric code). Used when an onboarding application is approved.';

-- ── 2 · what an approval produced ───────────────────────────────────────────
ALTER TABLE core.vendor_applications
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES core.vendors(id);
ALTER TABLE core.vendor_applications
  ADD COLUMN IF NOT EXISTS login_user_id uuid REFERENCES core.users(id);

ALTER TABLE core.vendor_applications DROP CONSTRAINT IF EXISTS vendor_applications_approved_links;
ALTER TABLE core.vendor_applications
  ADD CONSTRAINT vendor_applications_approved_links
  CHECK (vendor_id IS NULL OR state = 'Approved');

-- ── 3 · one-time password links ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.password_set_tokens (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES core.users(id),
  token_hash          text NOT NULL UNIQUE,
  purpose             text NOT NULL DEFAULT 'supplier_set_password'
                        CHECK (purpose IN ('supplier_set_password')),
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  created_by_user_id  uuid REFERENCES core.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_password_set_tokens_user
  ON core.password_set_tokens (user_id, created_at DESC);

COMMENT ON TABLE core.password_set_tokens IS
  'One-time links for a supplier login to set its password. Stores sha256(token) only; single use; expires.';

-- ── post-condition ──────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regprocedure('core.fn_next_vendor_code()') IS NULL THEN
    RAISE EXCEPTION 'migration 078: core.fn_next_vendor_code() missing';
  END IF;
  IF core.fn_next_vendor_code() !~ '^V-\d{5,}$' THEN
    RAISE EXCEPTION 'migration 078: fn_next_vendor_code() returned a malformed code';
  END IF;
  IF to_regclass('core.password_set_tokens') IS NULL THEN
    RAISE EXCEPTION 'migration 078: core.password_set_tokens missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'core' AND table_name = 'vendor_applications'
                    AND column_name = 'login_user_id') THEN
    RAISE EXCEPTION 'migration 078: vendor_applications.login_user_id missing';
  END IF;
END $$;

COMMIT;
