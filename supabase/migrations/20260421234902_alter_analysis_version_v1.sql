-- SCR-0b-1: Tighten analysis_version to NOT NULL with DEFAULT 'v0'.
-- Applied to main Supabase project ~2026-04-29 08:25 EDT (single-instance setup; no dev/prod split).
-- No UPDATE backfill: table was empty pre-migration (swings cleared pre-launch per prior session decision).

ALTER TABLE public.swings ALTER COLUMN analysis_version SET DEFAULT 'v0';
ALTER TABLE public.swings ALTER COLUMN analysis_version SET NOT NULL;

COMMENT ON COLUMN public.swings.analysis_version IS 'Scoring algorithm version. v0 = pre-SCR-0b-1 (symmetric taper, null-50). v1 = SCR-0b-1+ (asymmetric, null-exclude). Bump on any scoring logic change.';
