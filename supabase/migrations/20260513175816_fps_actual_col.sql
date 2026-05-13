-- #149: Add top-level fps_actual column. Parallel to swing_debug.fps_actual JSONB
-- workaround which stays in place until read-sites migrate. Nullable, no DEFAULT,
-- no NOT NULL constraint. Inherits existing public.swings RLS.
-- Pre-#149 rows: NULL. Post-deploy: frames.length / (durationMs / 1000) or NULL if duration_ms = 0.
ALTER TABLE public.swings
  ADD COLUMN fps_actual numeric;

COMMENT ON COLUMN public.swings.fps_actual IS
  'Analyzed pose frames per second (frame_count / (duration_ms / 1000.0)). NULL for historical rows and when duration_ms = 0.';
