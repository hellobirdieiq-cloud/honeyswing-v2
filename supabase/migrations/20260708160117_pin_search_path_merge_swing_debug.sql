-- T3-25. Applied to prod 2026-07-08 via MCP by a prior session; repo mirror
-- (live proconfig verified: search_path=""). Rollback: ALTER FUNCTION
-- public.merge_swing_debug(uuid, jsonb) RESET search_path;
alter function public.merge_swing_debug(swing_id uuid, patch jsonb) set search_path = '';
