-- SCR-INPUT-AUDIT prep: per-swing V85.3 Layer 2 category scores.
-- Nullable, no DEFAULT, no NOT NULL constraint. Inherits existing public.swings RLS.
-- Debug-only — not surfaced to users.
ALTER TABLE public.swings
  ADD COLUMN category_scores jsonb;

COMMENT ON COLUMN public.swings.category_scores IS
  'Debug-only. Category scores per swing. Not surfaced to users. Nullable. Shape: {posture, balance, tempo, rotationControl}.';
