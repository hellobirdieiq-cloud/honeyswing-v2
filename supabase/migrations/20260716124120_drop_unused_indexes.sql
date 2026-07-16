-- T3-28: drop 3 never-used indexes (idx_scan = 0 since DB creation 2026-03-02,
-- stats never reset; advisor lint 0005). Rollback = recreate verbatim:
--   CREATE INDEX events_type_idx ON public.events USING btree (type);
--   CREATE INDEX idx_player_profiles_user_id ON public.player_profiles USING btree (user_id);
--   CREATE INDEX idx_profiles_referral_coach_id ON public.profiles USING btree (referral_coach_id) WHERE (referral_coach_id IS NOT NULL);
drop index public.events_type_idx;
drop index public.idx_player_profiles_user_id;
drop index public.idx_profiles_referral_coach_id;
