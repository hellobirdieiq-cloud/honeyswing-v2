-- T3-23: covering index for swings_user_id_fkey (advisor lint 0001) — the
-- hottest history filter. 85 rows at creation → plain CREATE INDEX (millisecond
-- lock); CONCURRENTLY unnecessary. Rollback: DROP INDEX public.idx_swings_user_id;
create index idx_swings_user_id on public.swings using btree (user_id);
