-- T1-6 (SEC-1). Applied to prod 2026-07-08 via MCP by a prior session; this file
-- is the repo mirror (reconstructed from the live catalog — grants verified as
-- postgres+service_role only). Rollback: GRANT EXECUTE ON FUNCTION
-- public.rls_auto_enable() TO PUBLIC, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
