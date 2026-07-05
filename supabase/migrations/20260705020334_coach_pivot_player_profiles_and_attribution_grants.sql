-- Coach pivot Phase 1: server-side kid identity + attribution-keyed coach grants.
-- PII posture: display_name / handedness / coarse age_tier only — no birthdates,
-- no contact info. Owner CRUD + linked-coach SELECT; coaches get NO profiles grant.

create table public.player_profiles (
  id text primary key,                -- locally generated id (Date.now()+random), matches swings.player_profile_id
  user_id text not null references public.profiles(id) on delete cascade,
  display_name text not null,
  is_left_handed boolean not null default false,
  age_tier text check (age_tier in ('junior', 'youth', 'teen', 'adult')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_player_profiles_user_id on public.player_profiles (user_id);

alter table public.player_profiles enable row level security;

-- WITH CHECK (not just USING) so an INSERT/UPSERT claiming another account's
-- user_id is rejected even if the client fabricates a colliding id.
create policy player_profiles_owner_all on public.player_profiles
  for all to authenticated
  using ((auth.jwt() ->> 'sub') = user_id)
  with check ((auth.jwt() ->> 'sub') = user_id);

create policy player_profiles_coach_select on public.player_profiles
  for select to authenticated
  using (user_id in (
    select p.id from public.profiles p
    where p.referral_coach_id in (
      select c.id from public.coaches c
      where c.auth_user_id = (auth.jwt() ->> 'sub')
    )
  ));

-- Support the attribution joins below.
create index idx_profiles_referral_coach_id
  on public.profiles (referral_coach_id)
  where referral_coach_id is not null;

-- Replace the case-broken coach_name string match with the attribution join
-- (linkCoach maintains profiles.referral_coach_id; swings.coach_name stays
-- written but is no longer load-bearing).
drop policy if exists coaches_read_referral_swings on public.swings;
create policy coaches_read_referral_swings on public.swings
  for select to authenticated
  using (user_id in (
    select p.id from public.profiles p
    where p.referral_coach_id in (
      select c.id from public.coaches c
      where c.auth_user_id = (auth.jwt() ->> 'sub')
    )
  ));

-- Private swing-videos bucket: createSignedUrl enforces storage RLS, and only
-- swing_videos_select_own exists — grant coaches SELECT on linked accounts'
-- objects (key layout: {userId}/{swingId}.mov) so getSwingVideoSignedUrl works
-- unchanged for coach-granted swings.
create policy swing_videos_select_coach on storage.objects
  for select to authenticated
  using (
    bucket_id = 'swing-videos'
    and (storage.foldername(name))[1] in (
      select p.id from public.profiles p
      where p.referral_coach_id in (
        select c.id from public.coaches c
        where c.auth_user_id = (auth.jwt() ->> 'sub')
      )
    )
  );
