ALTER TABLE public.swings
  ADD COLUMN IF NOT EXISTS player_profile_id text;
