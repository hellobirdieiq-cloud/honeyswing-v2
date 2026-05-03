-- SCR-0b-2: per-metric confidence persistence (decomposed visibility + camera).
-- Nullable, no DEFAULT, no NOT NULL constraint. Inherits existing public.swings RLS (F7).
-- Pre-SCR-0b-2 rows: NULL. Post-deploy fallback-path rows: {}. Heuristic-path rows: populated.
ALTER TABLE public.swings
  ADD COLUMN metric_confidences jsonb;

COMMENT ON COLUMN public.swings.metric_confidences IS
  'SCR-0b-2: Decomposed per-metric confidence map. Shape: Record<metric, {visibilityConfidence:number, cameraConfidence:number}>. NULL = pre-deploy or unwritten; {} = mid_frame_fallback path; populated = heuristic phase-detection path. Combination formula at read time: Math.min(vis, cam).';
