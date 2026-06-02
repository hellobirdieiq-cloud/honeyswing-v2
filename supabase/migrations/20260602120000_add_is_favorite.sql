-- FAV: per-swing favorite/heart flag for the Swing Art gallery.
-- NOT NULL DEFAULT false backfills existing rows to "not favorited" instantly
-- (boolean default is a cheap metadata-only change, no table rewrite). Inherits
-- public.swings RLS, so users can only toggle their own swings.
ALTER TABLE public.swings
  ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.swings.is_favorite IS
  'FAV: true if the user hearted this swing in the Swing Art gallery. Defaults false; never null.';
