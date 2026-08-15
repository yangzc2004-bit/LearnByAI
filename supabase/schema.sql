create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  model_config jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- User profile additions (display name, bio, public avatar). Kept as nullable
-- columns so applying this migration to an existing database is a no-op schema
-- change with zero data backfill required.
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

create table if not exists courses (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  topic text not null,
  goal text not null,
  payload jsonb not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists chapters (
  id uuid primary key,
  course_id uuid not null references courses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  status text not null,
  order_index integer not null default 0,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists sections (
  id uuid primary key,
  chapter_id uuid not null references chapters(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  status text not null,
  order_index integer not null default 0,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists annotations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid references courses(id) on delete cascade,
  chapter_id uuid not null references chapters(id) on delete cascade,
  section_id uuid,
  selected_text text,
  scope text,
  title text,
  summary text,
  question text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists annotation_messages (
  id uuid primary key,
  annotation_id uuid not null references annotations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists revisions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid references courses(id) on delete cascade,
  chapter_id uuid not null references chapters(id) on delete cascade,
  section_id uuid,
  mode text not null,
  scope text not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- Idempotent migrations for databases created before these columns existed.
alter table annotations alter column selected_text drop not null;
alter table annotations add column if not exists scope text;
alter table annotations add column if not exists title text;
alter table annotations add column if not exists summary text;
-- Cross-process CAS anchor: the SHA-256 fingerprint of the chapter body at
-- last write. apply_chapter_update_guarded refuses to overwrite a chapter
-- whose body_hash no longer matches the writer's expectation.
alter table chapters add column if not exists body_hash text;
-- Course-level optimistic lock for whole-course writes. Every course/chapter
-- mutation (save_course_guarded, apply_chapter_update_guarded) increments this
-- version; stale whole-course snapshots are refused before they can clobber a
-- fresher chapter payload or body_hash.
alter table public.courses add column if not exists version integer not null default 1;

-- Backfill body_hash for chapters persisted before the column existed (runs
-- idempotently on every schema apply). Must mirror hashChapterContent in
-- src/lib/chapterContent.ts: sha256(content), or sha256(sections joined by
-- "\n\n" in array order), or sha256("") when neither exists.
create extension if not exists pgcrypto;
update public.chapters
set body_hash = encode(digest(
      coalesce(
        payload->>'content',
        (
          select string_agg(section->>'content', E'\n\n' order by pos)
          from jsonb_array_elements(payload->'sections') with ordinality as arr(section, pos)
        ),
        ''
      ),
      'sha256'
    ), 'hex')
where body_hash is null;

create table if not exists generation_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid references courses(id) on delete cascade,
  chapter_id uuid references chapters(id) on delete cascade,
  type text not null,
  status text not null,
  locked_by text,
  locked_until timestamptz,
  attempts integer not null default 0,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists quality_reports (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null,
  target_id uuid not null,
  score integer not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists exports (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  format text not null,
  status text not null,
  file_name text,
  storage_path text,
  storage_provider text,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists usage_events (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

create table if not exists chapter_lecture_progress (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  chapter_id uuid not null references chapters(id) on delete cascade,
  completed boolean not null default false,
  quiz_score integer,
  quiz_total integer,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  constraint chapter_lecture_progress_user_chapter_key unique (user_id, chapter_id)
);

-- Companion-guide progress (AI 伴学指南): new canonical table. The legacy
-- chapter_lecture_progress table is kept for one release cycle; reads prefer
-- this table and fall back to the legacy one.
create table if not exists chapter_companion_progress (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id uuid not null references courses(id) on delete cascade,
  chapter_id uuid not null references chapters(id) on delete cascade,
  completed boolean not null default false,
  quiz_score integer,
  quiz_total integer,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  constraint chapter_companion_progress_user_chapter_key unique (user_id, chapter_id)
);

-- One-time backfill: carry every legacy progress row into the new table.
-- Idempotent (on conflict do nothing), safe to run on every schema apply.
insert into chapter_companion_progress (id, user_id, course_id, chapter_id, completed, quiz_score, quiz_total, payload, updated_at)
select id, user_id, course_id, chapter_id, completed, quiz_score, quiz_total, payload, updated_at
from chapter_lecture_progress
on conflict (user_id, chapter_id) do nothing;

create table if not exists quota_reservations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists admin_audit_logs (
  id uuid primary key,
  admin_username text not null,
  action text not null,
  target_type text not null,
  target_id text,
  summary text not null,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
alter table courses enable row level security;
alter table chapters enable row level security;
alter table sections enable row level security;
alter table annotations enable row level security;
alter table annotation_messages enable row level security;
alter table revisions enable row level security;
alter table generation_jobs enable row level security;
alter table quality_reports enable row level security;
alter table exports enable row level security;
alter table usage_events enable row level security;
alter table chapter_lecture_progress enable row level security;
alter table chapter_companion_progress enable row level security;
alter table quota_reservations enable row level security;
alter table app_settings enable row level security;
alter table admin_audit_logs enable row level security;

drop policy if exists "Users can read own profile" on profiles;
create policy "Users can read own profile" on profiles for select using (auth.uid() = id);
drop policy if exists "Users can insert own profile" on profiles;
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = id);
drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile" on profiles for update using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists "Users can read own courses" on courses;
create policy "Users can read own courses" on courses for select using (auth.uid() = user_id);
drop policy if exists "Users can read own chapters" on chapters;
create policy "Users can read own chapters" on chapters for select using (auth.uid() = user_id);
drop policy if exists "Users can read own sections" on sections;
create policy "Users can read own sections" on sections for select using (auth.uid() = user_id);
drop policy if exists "Users can read own annotations" on annotations;
create policy "Users can read own annotations" on annotations for select using (auth.uid() = user_id);
drop policy if exists "Users can read own annotation messages" on annotation_messages;
create policy "Users can read own annotation messages" on annotation_messages for select using (auth.uid() = user_id);
drop policy if exists "Users can read own revisions" on revisions;
create policy "Users can read own revisions" on revisions for select using (auth.uid() = user_id);
drop policy if exists "Users can read own jobs" on generation_jobs;
create policy "Users can read own jobs" on generation_jobs for select using (auth.uid() = user_id);
drop policy if exists "Users can read own quality reports" on quality_reports;
create policy "Users can read own quality reports" on quality_reports for select using (auth.uid() = user_id);
drop policy if exists "Users can read own exports" on exports;
create policy "Users can read own exports" on exports for select using (auth.uid() = user_id);
drop policy if exists "Users can read own usage" on usage_events;
create policy "Users can read own usage" on usage_events for select using (auth.uid() = user_id);
drop policy if exists "Users can read own lecture progress" on chapter_lecture_progress;
create policy "Users can read own lecture progress" on chapter_lecture_progress for select using (auth.uid() = user_id);
drop policy if exists "Users can read own companion progress" on chapter_companion_progress;
create policy "Users can read own companion progress" on chapter_companion_progress for select using (auth.uid() = user_id);
drop policy if exists "Users can read own quota reservations" on quota_reservations;
create policy "Users can read own quota reservations" on quota_reservations for select using (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  initial_display_name text;
begin
  initial_display_name := nullif(
    trim(coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name',
      ''
    )),
    ''
  );

  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, initial_display_name)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create or replace function public.set_profile_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_profile_updated_at();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop function if exists public.claim_generation_job(uuid, text, integer);

create or replace function public.claim_generation_job(
  target_job_id uuid,
  worker_id text,
  lease_ms integer,
  max_course_chapter_jobs integer default 2,
  max_user_courses integer default 3
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_course_id uuid;
  target_type text;
  target_user_id uuid;
begin
  select gj.course_id, gj.type, gj.user_id
  into target_course_id, target_type, target_user_id
  from public.generation_jobs gj
  where gj.id = claim_generation_job.target_job_id;

  if target_type = 'chapter' and target_course_id is not null then
    perform pg_advisory_xact_lock(hashtext(target_course_id::text)::bigint);
  end if;

  return query
  update public.generation_jobs as gj
  set
    status = 'running',
    locked_by = claim_generation_job.worker_id,
    locked_until = now() + (claim_generation_job.lease_ms * interval '1 millisecond'),
    attempts = gj.attempts + 1,
    payload = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(gj.payload, '{status}', to_jsonb('running'::text), true),
          '{lockedBy}',
          to_jsonb(claim_generation_job.worker_id),
          true
        ),
        '{lockedUntil}',
        to_jsonb((now() + (claim_generation_job.lease_ms * interval '1 millisecond'))::text),
        true
      ),
      '{attempts}',
      to_jsonb(gj.attempts + 1),
      true
    ),
    updated_at = now()
  where gj.id = claim_generation_job.target_job_id
    and gj.status in ('pending', 'queued', 'retrying')
    and (gj.locked_until is null or gj.locked_until <= now())
    and (
      gj.type <> 'chapter'
      or claim_generation_job.max_course_chapter_jobs <= 0
      or (
        select count(*)
        from public.generation_jobs active
        where active.course_id = gj.course_id
          and active.type = 'chapter'
          and active.id <> gj.id
          and active.status = 'running'
          and active.locked_until > now()
      ) < claim_generation_job.max_course_chapter_jobs
    )
    and (
      claim_generation_job.max_user_courses <= 0
      or (
        select count(distinct active.course_id)
        from public.generation_jobs active
        where active.user_id = target_user_id
          and active.course_id is not null
          and active.status in ('pending', 'queued', 'running', 'retrying')
          and active.id <> claim_generation_job.target_job_id
      ) < claim_generation_job.max_user_courses
    )
  returning gj.payload;
end;
$$;

create or replace function public.reserve_usage_quota(
  target_user_id uuid,
  target_action text,
  quota_limit integer,
  since_iso timestamptz,
  reservation_id uuid,
  reservation_ttl_ms integer default 600000
)
returns table(allowed boolean, used_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  perform pg_advisory_xact_lock(hashtext(target_user_id::text || ':' || target_action)::bigint);

  delete from public.quota_reservations
  where expires_at <= now();

  select
    (
      select count(*)
      from public.usage_events
      where user_id = target_user_id
        and action = target_action
        and created_at >= since_iso
    ) + (
      select count(*)
      from public.quota_reservations
      where user_id = target_user_id
        and action = target_action
        and created_at >= since_iso
    )
  into current_count;

  if current_count >= quota_limit then
    return query select false, current_count;
    return;
  end if;

  insert into public.quota_reservations (id, user_id, action, created_at, expires_at)
  values (
    reservation_id,
    target_user_id,
    target_action,
    now(),
    now() + (reservation_ttl_ms * interval '1 millisecond')
  );

  return query select true, current_count + 1;
end;
$$;

create or replace function public.commit_usage_quota_reservation(
  reservation_id uuid
)
returns table(id uuid, user_id uuid, action text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  reserved record;
begin
  select *
  into reserved
  from public.quota_reservations
  where quota_reservations.id = reservation_id
  for update;

  if not found then
    return;
  end if;

  delete from public.quota_reservations
  where quota_reservations.id = reservation_id;

  return query
  insert into public.usage_events (id, user_id, action, created_at)
  values (reserved.id, reserved.user_id, reserved.action, now())
  returning usage_events.id, usage_events.user_id, usage_events.action, usage_events.created_at;
end;
$$;

create or replace function public.release_usage_quota_reservation(
  reservation_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.quota_reservations
  where quota_reservations.id = reservation_id;

  get diagnostics deleted_count = row_count;
  return deleted_count > 0;
end;
$$;

create or replace function public.learnbyai_schema_version()
returns text
language sql
stable
as $$
  select 'learnbyai-beta-2026-06-23-03'::text;
$$;

-- Defensive JSON coercion helpers used by the guarded RPCs. Invalid ids/numbers
-- turn into null instead of aborting a transaction with a cast error.
create or replace function public.try_uuid(value text)
returns uuid
language sql
immutable
as $$
  select case
    when value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then value::uuid
    else null
  end;
$$;

create or replace function public.try_int(value text)
returns integer
language sql
immutable
as $$
  select case
    when value ~ '^-?[0-9]+$' then value::integer
    else null
  end;
$$;

create or replace function public.try_timestamptz(value text)
returns timestamptz
language sql
immutable
as $$
  select case
    when value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then value::timestamptz
    else null
  end;
$$;

-- Whole-course write CAS. Replaces the old blind courses.upsert + chapter
-- mirror rewrite, which could clobber a fresher chapter written by another
-- process. Runs in one transaction:
--   1. inserts a new course (version 1) or refuses an existing course when
--      expected_version does not match the current version;
--   2. increments courses.version;
--   3. synchronizes chapters/sections mirrors and chapter quality reports
--      from the course payload, so no mirror write happens after the CAS.
create or replace function public.save_course_guarded(
  target_course_id uuid,
  target_user_id uuid,
  expected_version integer,
  course_payload jsonb,
  new_topic text,
  new_goal text,
  new_created_at timestamptz,
  new_updated_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  current_version integer;
  next_version integer;
  incoming_chapters jsonb := coalesce(course_payload->'chapters', '[]'::jsonb);
begin
  perform pg_advisory_xact_lock(hashtext(target_course_id::text)::bigint);

  select c.version
  into current_version
  from public.courses c
  where c.id = target_course_id
  for update;

  if current_version is null then
    next_version := 1;
    insert into public.courses (
      id, user_id, topic, goal, payload, version, created_at, updated_at
    )
    values (
      target_course_id,
      target_user_id,
      new_topic,
      new_goal,
      course_payload,
      next_version,
      new_created_at,
      new_updated_at
    );
  elsif expected_version is null or current_version <> expected_version then
    return -1;
  else
    next_version := current_version + 1;
    update public.courses
    set topic = new_topic,
        goal = new_goal,
        payload = course_payload,
        version = next_version,
        updated_at = new_updated_at
    where id = target_course_id
      and user_id = target_user_id;

    if not found then
      return -1;
    end if;
  end if;

  -- Exact chapters mirror. body_hash is computed in SQL with the same
  -- semantics as hashChapterContent/getChapterBody in the application.
  with incoming as (
    select
      public.try_uuid(ch.val->>'id') as chapter_id,
      coalesce(ch.val->>'title', '') as title,
      coalesce(ch.val->>'status', 'pending') as status,
      ch.ord - 1 as order_index,
      ch.val as payload,
      encode(digest(
        coalesce(
          ch.val->>'content',
          (
            select string_agg(section->>'content', E'\n\n' order by pos)
            from jsonb_array_elements(ch.val->'sections') with ordinality as arr(section, pos)
          ),
          ''
        ),
        'sha256'
      ), 'hex') as body_hash
    from jsonb_array_elements(incoming_chapters) with ordinality as ch(val, ord)
    where public.try_uuid(ch.val->>'id') is not null
  )
  insert into public.chapters (
    id, course_id, user_id, title, status, order_index, payload, body_hash, updated_at
  )
  select
    chapter_id,
    target_course_id,
    target_user_id,
    title,
    status,
    order_index,
    payload,
    body_hash,
    new_updated_at
  from incoming
  on conflict (id) do update set
    course_id = excluded.course_id,
    user_id = excluded.user_id,
    title = excluded.title,
    status = excluded.status,
    order_index = excluded.order_index,
    payload = excluded.payload,
    body_hash = excluded.body_hash,
    updated_at = excluded.updated_at
  where public.chapters.course_id = target_course_id;

  delete from public.chapters c
  where c.course_id = target_course_id
    and not exists (
      select 1
      from jsonb_array_elements(incoming_chapters) with ordinality as ch(val, ord)
      where public.try_uuid(ch.val->>'id') = c.id
    );

  -- Exact sections mirror, derived from the chapters array.
  with incoming_sections as (
    select
      public.try_uuid(ch.val->>'id') as chapter_id,
      public.try_uuid(section.val->>'id') as section_id,
      coalesce(section.val->>'title', '') as title,
      coalesce(section.val->>'status', 'pending') as status,
      coalesce(public.try_int(section.val->>'order'), section.ord - 1) as order_index,
      section.val as payload
    from jsonb_array_elements(incoming_chapters) with ordinality as ch(val, ch_ord)
    cross join lateral jsonb_array_elements(
      coalesce(ch.val->'sections', '[]'::jsonb)
    ) with ordinality as section(val, ord)
    where public.try_uuid(ch.val->>'id') is not null
      and public.try_uuid(section.val->>'id') is not null
  )
  insert into public.sections (
    id, chapter_id, course_id, user_id, title, status, order_index, payload, updated_at
  )
  select
    section_id,
    chapter_id,
    target_course_id,
    target_user_id,
    title,
    status,
    order_index,
    payload,
    new_updated_at
  from incoming_sections
  on conflict (id) do update set
    chapter_id = excluded.chapter_id,
    course_id = excluded.course_id,
    user_id = excluded.user_id,
    title = excluded.title,
    status = excluded.status,
    order_index = excluded.order_index,
    payload = excluded.payload,
    updated_at = excluded.updated_at
  where public.sections.course_id = target_course_id;

  delete from public.sections s
  where s.course_id = target_course_id
    and not exists (
      select 1
      from jsonb_array_elements(incoming_chapters) with ordinality as ch(val, ch_ord)
      cross join lateral jsonb_array_elements(
        coalesce(ch.val->'sections', '[]'::jsonb)
      ) with ordinality as section(val, ord)
      where public.try_uuid(section.val->>'id') = s.id
    );

  -- Chapter quality reports carried inside the payload.
  with incoming_reports as (
    select
      public.try_uuid(ch.val->'qualityReport'->>'id') as report_id,
      coalesce(ch.val->'qualityReport'->>'targetType', 'chapter') as target_type,
      coalesce(
        public.try_uuid(ch.val->'qualityReport'->>'targetId'),
        public.try_uuid(ch.val->>'id')
      ) as target_id,
      coalesce(public.try_int(ch.val->'qualityReport'->>'score'), 0) as score,
      coalesce(ch.val->'qualityReport'->>'status', 'pending') as status,
      ch.val->'qualityReport' as payload,
      coalesce(
        public.try_timestamptz(ch.val->'qualityReport'->>'createdAt'),
        new_updated_at
      ) as created_at
    from jsonb_array_elements(incoming_chapters) as ch(val)
    where public.try_uuid(ch.val->'qualityReport'->>'id') is not null
  )
  insert into public.quality_reports (
    id, user_id, target_type, target_id, score, status, payload, created_at
  )
  select
    report_id,
    target_user_id,
    target_type,
    target_id,
    score,
    status,
    payload,
    created_at
  from incoming_reports
  on conflict (id) do update set
    user_id = excluded.user_id,
    target_type = excluded.target_type,
    target_id = excluded.target_id,
    score = excluded.score,
    status = excluded.status,
    payload = excluded.payload,
    created_at = excluded.created_at
  where public.quality_reports.user_id = target_user_id;

  return next_version;
end;
$$;

-- Cross-process chapter-write CAS. Runs in one transaction:
--   1. refuses when the chapter does not belong to the course, the chapter is
--      missing from the course payload, or chapters.body_hash differs from the
--      writer's expectation (stale companion/answers writes are superseded);
--   2. updates the chapter row (payload, body_hash AND title/status/order);
--   3. surgically replaces ONLY that chapter's element inside the course
--      payload, increments courses.version, and syncs the chapter's sections
--      mirror + quality report in the same transaction.
create or replace function public.apply_chapter_update_guarded(
  target_course_id uuid,
  target_chapter_id uuid,
  expected_body_hash text,
  new_body_hash text,
  chapter_payload jsonb,
  new_updated_at timestamptz,
  new_title text,
  new_status text,
  new_order_index integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  current_hash text;
  chapter_user_id uuid;
  chapter_index bigint;
  current_version integer;
  quality_report_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(target_chapter_id::text)::bigint);

  select c.version
  into current_version
  from public.courses c
  where c.id = target_course_id
  for update;

  if current_version is null then
    return -1;
  end if;

  select body_hash, user_id
  into current_hash, chapter_user_id
  from public.chapters
  where id = target_chapter_id
    and course_id = target_course_id;

  if not found then
    return -1;
  end if;

  if current_hash is not null
     and expected_body_hash is not null
     and current_hash <> expected_body_hash then
    return -1;
  end if;

  select pos - 1
  into chapter_index
  from public.courses c,
       jsonb_array_elements(c.payload->'chapters') with ordinality as arr(ch, pos)
  where c.id = target_course_id
    and arr.ch->>'id' = target_chapter_id::text
  limit 1;

  if chapter_index is null then
    return -1;
  end if;

  quality_report_id := public.try_uuid(chapter_payload->'qualityReport'->>'id');
  if chapter_payload->'qualityReport' is not null and quality_report_id is null then
    return -1;
  end if;

  update public.chapters
  set title = coalesce(new_title, title),
      status = coalesce(new_status, status),
      order_index = coalesce(new_order_index, order_index),
      payload = chapter_payload,
      body_hash = new_body_hash,
      updated_at = new_updated_at
  where id = target_chapter_id
    and course_id = target_course_id;

  if not found then
    return -1;
  end if;

  update public.courses
  set payload = jsonb_set(
        payload,
        array['chapters', chapter_index::text],
        chapter_payload
      ),
      version = current_version + 1,
      updated_at = new_updated_at
  where id = target_course_id;

  if not found then
    return -1;
  end if;

  -- Section mirror for exactly this chapter (delete first: regeneration must
  -- never leave stale reader anchors behind).
  delete from public.sections
  where chapter_id = target_chapter_id
    and course_id = target_course_id;

  with incoming_sections as (
    select
      public.try_uuid(section.val->>'id') as section_id,
      coalesce(section.val->>'title', '') as title,
      coalesce(section.val->>'status', 'pending') as status,
      coalesce(public.try_int(section.val->>'order'), section.ord - 1) as order_index,
      section.val as payload
    from jsonb_array_elements(
      coalesce(chapter_payload->'sections', '[]'::jsonb)
    ) with ordinality as section(val, ord)
    where public.try_uuid(section.val->>'id') is not null
  )
  insert into public.sections (
    id, chapter_id, course_id, user_id, title, status, order_index, payload, updated_at
  )
  select
    section_id,
    target_chapter_id,
    target_course_id,
    chapter_user_id,
    title,
    status,
    order_index,
    payload,
    new_updated_at
  from incoming_sections;

  -- Chapter quality report carried inside the payload.
  if quality_report_id is not null then
    insert into public.quality_reports (
      id, user_id, target_type, target_id, score, status, payload, created_at
    )
    select
      quality_report_id,
      chapter_user_id,
      coalesce(chapter_payload->'qualityReport'->>'targetType', 'chapter'),
      coalesce(
        public.try_uuid(chapter_payload->'qualityReport'->>'targetId'),
        target_chapter_id
      ),
      coalesce(public.try_int(chapter_payload->'qualityReport'->>'score'), 0),
      coalesce(chapter_payload->'qualityReport'->>'status', 'pending'),
      chapter_payload->'qualityReport',
      coalesce(
        public.try_timestamptz(chapter_payload->'qualityReport'->>'createdAt'),
        new_updated_at
      )
    on conflict (id) do update set
      user_id = excluded.user_id,
      target_type = excluded.target_type,
      target_id = excluded.target_id,
      score = excluded.score,
      status = excluded.status,
      payload = excluded.payload,
      created_at = excluded.created_at
    where public.quality_reports.user_id = chapter_user_id;
  end if;

  return current_version + 1;
end;
$$;

revoke execute on function public.claim_generation_job(uuid, text, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.reserve_usage_quota(uuid, text, integer, timestamptz, uuid, integer) from public, anon, authenticated;
revoke execute on function public.commit_usage_quota_reservation(uuid) from public, anon, authenticated;
revoke execute on function public.release_usage_quota_reservation(uuid) from public, anon, authenticated;
revoke execute on function public.save_course_guarded(uuid, uuid, integer, jsonb, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.apply_chapter_update_guarded(uuid, uuid, text, text, jsonb, timestamptz, text, text, integer) from public, anon, authenticated;

grant execute on function public.claim_generation_job(uuid, text, integer, integer, integer) to service_role;
grant execute on function public.reserve_usage_quota(uuid, text, integer, timestamptz, uuid, integer) to service_role;
grant execute on function public.commit_usage_quota_reservation(uuid) to service_role;
grant execute on function public.release_usage_quota_reservation(uuid) to service_role;
grant execute on function public.save_course_guarded(uuid, uuid, integer, jsonb, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.apply_chapter_update_guarded(uuid, uuid, text, text, jsonb, timestamptz, text, text, integer) to service_role;

create index if not exists generation_jobs_runnable_idx
  on generation_jobs (status, locked_until, created_at);

create unique index if not exists generation_jobs_active_course_idx
  on generation_jobs (course_id)
  where course_id is not null and type = 'course' and status in ('pending', 'queued', 'retrying', 'running');

create unique index if not exists generation_jobs_active_chapter_idx
  on generation_jobs (chapter_id)
  where chapter_id is not null and type = 'chapter' and status in ('pending', 'queued', 'retrying', 'running');

-- One active companion-guide job per chapter (legacy `lecture` type included):
-- two racing tabs cannot create two guide jobs / burn quota twice. The API's
-- 23505 recovery reads the existing job and returns it instead.
create unique index if not exists generation_jobs_active_guide_idx
  on generation_jobs (chapter_id)
  where chapter_id is not null and type in ('companion-guide', 'lecture') and status in ('pending', 'queued', 'retrying', 'running');

create index if not exists courses_user_created_idx
  on courses (user_id, created_at desc);

create index if not exists chapters_course_order_idx
  on chapters (course_id, order_index);

create index if not exists sections_chapter_order_idx
  on sections (chapter_id, order_index);

create index if not exists annotations_user_chapter_created_idx
  on annotations (user_id, chapter_id, created_at);

create index if not exists annotation_messages_annotation_created_idx
  on annotation_messages (annotation_id, created_at);

create index if not exists revisions_user_chapter_created_idx
  on revisions (user_id, chapter_id, created_at desc);

create index if not exists exports_user_course_created_idx
  on exports (user_id, course_id, created_at desc);

create index if not exists usage_events_user_action_created_idx
  on usage_events (user_id, action, created_at desc);

create index if not exists chapter_lecture_progress_user_course_idx
  on chapter_lecture_progress (user_id, course_id);

create index if not exists chapter_lecture_progress_chapter_idx
  on chapter_lecture_progress (chapter_id, updated_at desc);

create index if not exists chapter_companion_progress_user_course_idx
  on chapter_companion_progress (user_id, course_id);

create index if not exists chapter_companion_progress_chapter_idx
  on chapter_companion_progress (chapter_id, updated_at desc);

create index if not exists quota_reservations_user_action_expires_idx
  on quota_reservations (user_id, action, expires_at);

create index if not exists quality_reports_user_target_idx
  on quality_reports (user_id, target_type, target_id);

create index if not exists admin_audit_logs_created_idx
  on admin_audit_logs (created_at desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'learnbyai-exports',
  'learnbyai-exports',
  false,
  52428800,
  array['application/pdf', 'application/x-tex', 'text/plain', 'application/octet-stream']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read own export objects" on storage.objects;
create policy "Users can read own export objects"
  on storage.objects for select
  using (
    bucket_id = 'learnbyai-exports'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'learnbyai-avatars',
  'learnbyai-avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Avatar objects live under {userId}/avatar-*. Service-role routes perform the
-- upload, but keep these defensive RLS policies so an authenticated client can
-- never write into another user's avatar folder.
drop policy if exists "Users can upload own avatar" on storage.objects;
create policy "Users can upload own avatar"
  on storage.objects for insert
  with check (
    bucket_id = 'learnbyai-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can update own avatar" on storage.objects;
create policy "Users can update own avatar"
  on storage.objects for update
  using (
    bucket_id = 'learnbyai-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete own avatar" on storage.objects;
create policy "Users can delete own avatar"
  on storage.objects for delete
  using (
    bucket_id = 'learnbyai-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
