-- Migration: create public.events
-- Purpose: backing store for EVB, the Event Emission Framework (v9 seq 56).
-- Consumed by LVM, achievement badges (#62), PostHog (#75), Sentry (#74), FCT (seq 58).
--
-- Operator: run the pre-flight check below before applying.
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name ILIKE '%event%';
-- Expected output: empty. If any row is returned, STOP and investigate.
--
-- Notes:
--  * `user_id` is text (not uuid) because auth is Clerk — Clerk user IDs are strings
--    like `user_XXX`. Matches post-migration `public.swings.user_id` type
--    (see 20260417061320_phase_4_5_clerk_user_ids.sql).
--  * `idempotency_key` is unique to support client-side retry: drain uses
--    upsert(onConflict='idempotency_key', ignoreDuplicates=true), so retried
--    events are deduped server-side.
--  * Append-only: no UPDATE or DELETE policies.
--  * RLS uses `auth.jwt() ->> 'sub'` to match Clerk JWT sub claim, consistent
--    with existing swings/profiles/coaches RLS.
--  * `TO authenticated` qualifier is INTENTIONALLY STRICTER than existing
--    public.swings policies (which omit it). Rationale: per-user behavioral
--    telemetry should never be touchable by anon clients.

BEGIN;

CREATE TABLE public.events (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text         NOT NULL UNIQUE,
  user_id         text         NOT NULL,
  type            text         NOT NULL,
  payload         jsonb        NOT NULL,
  session_id      text,
  app_version     text,
  emitted_at      timestamptz  NOT NULL,
  received_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX events_user_id_emitted_at_idx
  ON public.events (user_id, emitted_at DESC);

CREATE INDEX events_type_idx
  ON public.events (type);

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_insert_own_events"
  ON public.events
  FOR INSERT
  TO authenticated
  WITH CHECK ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY "users_select_own_events"
  ON public.events
  FOR SELECT
  TO authenticated
  USING ((auth.jwt() ->> 'sub') = user_id);

COMMIT;
