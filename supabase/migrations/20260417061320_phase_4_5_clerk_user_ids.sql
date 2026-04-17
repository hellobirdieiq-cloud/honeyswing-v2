-- Phase 4.5 — Clerk user-id migration
-- Converts user-ID-bearing columns from uuid -> text, severs dangling FKs into auth.users
-- (Clerk users never land there), and rewrites every RLS policy from auth.uid() to
-- auth.jwt() ->> 'sub'. Storage policies for swing-videos and grip-photos are replaced
-- with explicit, bucket-scoped, Clerk-aware variants.
--
-- Safe on prod (project xutbbirehugrrbkauhnl): all four user-keyed public tables are
-- empty (profiles=0, swings=0, coaches=0, grip_analyses=0) and auth.users=0.
--
-- Take an on-demand Supabase backup before running this. All DDL is wrapped in a
-- single transaction so any mid-migration failure auto-rolls back.

BEGIN;

-- 1. Drop all public-schema RLS policies that reference auth.uid().
DROP POLICY IF EXISTS "Users can delete own profile"         ON public.profiles;
DROP POLICY IF EXISTS "Users can delete own swings"          ON public.swings;
DROP POLICY IF EXISTS "Users can insert own profile"         ON public.profiles;
DROP POLICY IF EXISTS "Users can insert own swings"          ON public.swings;
DROP POLICY IF EXISTS "Users can read own grip analyses"     ON public.grip_analyses;
DROP POLICY IF EXISTS "Users can read their own profile"     ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile"         ON public.profiles;
DROP POLICY IF EXISTS "Users can update own swings"          ON public.swings;
DROP POLICY IF EXISTS "Users can view own swings"            ON public.swings;
DROP POLICY IF EXISTS "coaches_own_row"                      ON public.coaches;
DROP POLICY IF EXISTS "coaches_read_referral_swings"         ON public.swings;
DROP POLICY IF EXISTS "users_lookup_coaches_by_code"         ON public.coaches;
DROP POLICY IF EXISTS "users_update_own_referral"            ON public.profiles;

-- 2. Drop all storage.objects policies that reference auth.uid().
-- Intentionally removing bucket-agnostic xuww7b_* policies; new policies are explicitly scoped to swing-videos and grip-photos
DROP POLICY IF EXISTS "Users can delete own videos"                     ON storage.objects;
DROP POLICY IF EXISTS "Users can read own videos"                       ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own videos xuww7b_0"        ON storage.objects;
DROP POLICY IF EXISTS "Users can read their own videos xuww7b_1"        ON storage.objects;
DROP POLICY IF EXISTS "Users can upload own videos"                     ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own videos xuww7b_0"      ON storage.objects;
DROP POLICY IF EXISTS "Users can upload their own videos xuww7b_1"      ON storage.objects;

-- 3. Drop foreign keys.
ALTER TABLE public.coaches       DROP CONSTRAINT IF EXISTS coaches_auth_user_id_fkey;      -- was -> auth.users(id); SEVERED PERMANENTLY
ALTER TABLE public.grip_analyses DROP CONSTRAINT IF EXISTS grip_analyses_user_id_fkey;     -- was -> auth.users(id) CASCADE; SEVERED PERMANENTLY
ALTER TABLE public.profiles      DROP CONSTRAINT IF EXISTS profiles_id_fkey;               -- was -> auth.users(id) CASCADE; SEVERED PERMANENTLY
ALTER TABLE public.profiles      DROP CONSTRAINT IF EXISTS profiles_referral_coach_id_fkey; -- will be recreated unchanged
ALTER TABLE public.swings        DROP CONSTRAINT IF EXISTS swings_user_id_fkey;            -- will be recreated as text->text

-- 4. Drop the now-incompatible default on profiles.id.
-- App always supplies id at app/onboarding.tsx:64; auth.uid() default returned NULL under Clerk JWT anyway
ALTER TABLE public.profiles ALTER COLUMN id DROP DEFAULT;

-- 5. Change user-ID column types uuid -> text.
ALTER TABLE public.profiles       ALTER COLUMN id           TYPE text USING id::text;
ALTER TABLE public.swings         ALTER COLUMN user_id      TYPE text USING user_id::text;
ALTER TABLE public.coaches        ALTER COLUMN auth_user_id TYPE text USING auth_user_id::text;
ALTER TABLE public.grip_analyses  ALTER COLUMN user_id      TYPE text USING user_id::text;

-- 6. Recreate the two internal FKs.
ALTER TABLE public.swings
  ADD CONSTRAINT swings_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_referral_coach_id_fkey
  FOREIGN KEY (referral_coach_id) REFERENCES public.coaches(id);

-- 7. Recreate public-schema RLS policies using Clerk JWT sub.
CREATE POLICY "Users can delete own profile" ON public.profiles
  FOR DELETE USING ((auth.jwt() ->> 'sub') = id);

CREATE POLICY "Users can delete own swings" ON public.swings
  FOR DELETE USING ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY "Users can insert own profile" ON public.profiles
  FOR INSERT WITH CHECK ((auth.jwt() ->> 'sub') = id);

CREATE POLICY "Users can insert own swings" ON public.swings
  FOR INSERT WITH CHECK ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY "Users can read own grip analyses" ON public.grip_analyses
  FOR SELECT USING ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY "Users can read their own profile" ON public.profiles
  FOR SELECT USING (id = (auth.jwt() ->> 'sub'));

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING ((auth.jwt() ->> 'sub') = id);

CREATE POLICY "Users can update own swings" ON public.swings
  FOR UPDATE USING ((auth.jwt() ->> 'sub') = user_id)
  WITH CHECK ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY "Users can view own swings" ON public.swings
  FOR SELECT USING ((auth.jwt() ->> 'sub') = user_id);

CREATE POLICY coaches_own_row ON public.coaches
  FOR SELECT USING ((auth.jwt() ->> 'sub') = auth_user_id);

CREATE POLICY coaches_read_referral_swings ON public.swings
  FOR SELECT USING (coach_name IN (
    SELECT coaches.name FROM public.coaches
     WHERE coaches.auth_user_id = (auth.jwt() ->> 'sub')
  ));

CREATE POLICY users_lookup_coaches_by_code ON public.coaches
  FOR SELECT TO authenticated USING (true);

CREATE POLICY users_update_own_referral ON public.profiles
  FOR UPDATE
  USING (((auth.jwt() ->> 'sub') = id) AND (referral_coach_id IS NULL))
  WITH CHECK ((auth.jwt() ->> 'sub') = id);

-- 8. Recreate storage.objects policies (bucket-scoped, Clerk-aware).
-- swing-videos: full CRUD for authenticated owner.
CREATE POLICY "swing_videos_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'swing-videos' AND (storage.foldername(name))[1] = (auth.jwt() ->> 'sub'));

CREATE POLICY "swing_videos_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'swing-videos' AND (storage.foldername(name))[1] = (auth.jwt() ->> 'sub'));

CREATE POLICY "swing_videos_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'swing-videos' AND (storage.foldername(name))[1] = (auth.jwt() ->> 'sub'))
  WITH CHECK (bucket_id = 'swing-videos' AND (storage.foldername(name))[1] = (auth.jwt() ->> 'sub'));

CREATE POLICY "swing_videos_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'swing-videos' AND (storage.foldername(name))[1] = (auth.jwt() ->> 'sub'));

-- grip-photos: authenticated SELECT only; writes remain service-role from the classify-grip edge fn.
CREATE POLICY "grip_photos_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'grip-photos' AND (storage.foldername(name))[1] = (auth.jwt() ->> 'sub'));

-- 9. Housekeeping: drop dormant handle_new_user trigger + function (auth.users no longer receives app users).
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

COMMIT;
