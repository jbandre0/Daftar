-- Daftar v1 · migration 0001 · schema, licensing functions, RLS, storage policy, signup trigger.
-- Paste the whole file into Supabase → SQL Editor and run it once.
-- Safe to read top to bottom: tables, helpers, triggers, grants, RLS, storage.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table profiles (
  id                 uuid primary key references auth.users on delete cascade,
  display_name       text,
  timezone           text not null default 'UTC',
  default_language   text not null default 'en',
  last_export_at     timestamptz,
  storage_bytes_used bigint not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Licensing lives in its own table. Only the service role (Edge Functions) can write it.
create table licenses (
  user_id           uuid primary key references auth.users on delete cascade,
  trial_started_at  timestamptz not null default now(),
  trial_ends_at     timestamptz not null default now() + interval '21 days',
  status            text not null default 'trial' check (status in ('trial', 'unlocked', 'refunded')),
  unlocked_at       timestamptz,
  provider          text,
  provider_order_id text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index licenses_order_unique on licenses (provider, provider_order_id)
  where provider_order_id is not null;

create table templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users on delete cascade, -- null = global built-in, read-only
  name       text not null,
  track_id   uuid,
  body_rich  jsonb not null default '{}',
  is_builtin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table tracks (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  name                text not null,
  slug                text not null,
  color_token         text not null default 'flame',
  default_template_id uuid references templates(id),
  sort_order          int not null default 0,
  is_builtin          boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  unique (user_id, slug)
);

alter table templates add constraint templates_track_fk foreign key (track_id) references tracks(id);

create table tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index tags_user_name on tags (user_id, lower(name)) where deleted_at is null;

create table chapters (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  name        text not null,
  description text not null default '',
  start_date  date not null,
  end_date    date, -- null = ongoing
  color_token text not null default 'olive',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  check (end_date is null or end_date >= start_date)
);

-- Entry IDs are generated on the client so autosave, offline drafts and merge-by-ID are safe.
create table entries (
  id          uuid primary key,
  user_id     uuid not null references auth.users on delete cascade,
  track_id    uuid references tracks(id),
  title       text,
  entry_date  date not null,
  body_rich   jsonb not null default '{}',
  body_text   text not null default '',
  language    text not null default 'en',
  word_count  int not null default 0,
  fields      jsonb not null default '{}',
  is_letter   boolean not null default false,
  letter_to   text,
  sealed      boolean not null default false,
  unlock_at   timestamptz,
  revision    int not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  search      tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || body_text)
  ) stored,
  constraint sealed_needs_date check (not sealed or unlock_at is not null)
);
create index entries_user_date on entries (user_id, entry_date desc) where deleted_at is null;
create index entries_search on entries using gin (search);
create index entries_trgm on entries using gin (body_text extensions.gin_trgm_ops);
create index entries_lang on entries (user_id, language);

-- user_id is duplicated here so RLS stays a single equality check.
create table entry_tags (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references entries(id) on delete cascade,
  tag_id     uuid not null references tags(id) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (entry_id, tag_id)
);
create index entry_tags_user on entry_tags (user_id);

create table media (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  entry_id     uuid not null references entries(id) on delete cascade,
  storage_path text not null,
  mime         text not null,
  bytes        int not null check (bytes >= 0),
  width        int,
  height       int,
  sha256       text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create index media_user_sha on media (user_id, sha256);
create index media_entry on media (entry_id);

-- Copies of rows that a restore or a concurrent edit replaced. Pruned after 90 days.
create table entry_versions (
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references entries(id) on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  snapshot   jsonb not null,
  reason     text not null check (reason in ('restore_overwrite', 'concurrent_edit')),
  created_at timestamptz not null default now()
);
create index entry_versions_entry on entry_versions (entry_id, created_at desc);

create table prompts (
  id          uuid primary key default gen_random_uuid(),
  text        text not null,
  depth       text not null check (depth in ('light', 'medium', 'deep')),
  mood        text,
  time_of_day text,
  track_hint  text,
  language    text not null default 'en',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Licensing functions. The server is the only judge of who can write.
-- ---------------------------------------------------------------------------

-- Create new entries, upload photos: trial still running, or unlocked.
create function can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from licenses
    where user_id = auth.uid()
      and (status = 'unlocked' or (status = 'trial' and trial_ends_at > now()))
  );
$$;

-- Edit existing entries: same, plus a 48-hour grace window so in-progress text can land.
create function can_edit() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from licenses
    where user_id = auth.uid()
      and (status = 'unlocked' or (status = 'trial' and trial_ends_at + interval '48 hours' > now()))
  );
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- updated_at is set by the server, never trusted from the client. Merge compares it.
create function set_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch       before insert or update on profiles       for each row execute function set_updated_at();
create trigger licenses_touch       before insert or update on licenses       for each row execute function set_updated_at();
create trigger templates_touch      before insert or update on templates      for each row execute function set_updated_at();
create trigger tracks_touch         before insert or update on tracks         for each row execute function set_updated_at();
create trigger tags_touch           before insert or update on tags           for each row execute function set_updated_at();
create trigger chapters_touch       before insert or update on chapters       for each row execute function set_updated_at();
create trigger entries_touch        before insert or update on entries        for each row execute function set_updated_at();
create trigger entry_tags_touch     before insert or update on entry_tags     for each row execute function set_updated_at();
create trigger media_touch          before insert or update on media          for each row execute function set_updated_at();

-- Signup: one profile, one trial licence (server time, 21 days), and the built-in tracks.
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id) values (new.id);
  insert into licenses (user_id) values (new.id);
  insert into tracks (user_id, name, slug, color_token, sort_order, is_builtin) values
    (new.id, 'Daily',     'daily',     'flame', 1, true),
    (new.id, 'Spiritual', 'spiritual', 'olive', 2, true),
    (new.id, 'Letters',   'letters',   'seal',  3, true),
    (new.id, 'Dreams',    'dreams',    'ash-soft', 4, true);
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- Grants. Start from nothing, then add exactly what the client may do.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function can_write(), can_edit() to authenticated;

grant select on profiles, licenses, templates, tracks, tags, chapters, entries, entry_tags, media, entry_versions to authenticated;
grant select on prompts to anon, authenticated;

-- Hard deletes never come from the client. Only account deletion (service role) removes rows.
grant insert, update on templates, tracks, tags, chapters, entries, entry_tags, media to authenticated;
grant insert on entry_versions to authenticated;

-- Profiles are created by the signup trigger. The client may edit only these columns;
-- storage_bytes_used is maintained by a trigger and licenses are service-role only.
grant update (display_name, timezone, default_language, last_export_at) on profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;
alter table licenses enable row level security;
alter table templates enable row level security;
alter table tracks enable row level security;
alter table tags enable row level security;
alter table chapters enable row level security;
alter table entries enable row level security;
alter table entry_tags enable row level security;
alter table media enable row level security;
alter table entry_versions enable row level security;
alter table prompts enable row level security;

-- Reading is free forever: read policies never check the licence.
create policy profiles_read   on profiles for select using (id = auth.uid());
create policy profiles_update on profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- No insert/update/delete policies on licenses: only the service role writes here.
create policy licenses_read on licenses for select using (user_id = auth.uid());

create policy prompts_read on prompts for select using (true);

create policy templates_read   on templates for select using (user_id is null or user_id = auth.uid());
create policy templates_insert on templates for insert with check (user_id = auth.uid() and can_write());
create policy templates_update on templates for update using (user_id = auth.uid() and can_edit()) with check (user_id = auth.uid());

create policy tracks_read   on tracks for select using (user_id = auth.uid());
create policy tracks_insert on tracks for insert with check (user_id = auth.uid() and can_write());
create policy tracks_update on tracks for update using (user_id = auth.uid() and can_edit()) with check (user_id = auth.uid());

create policy tags_read   on tags for select using (user_id = auth.uid());
create policy tags_insert on tags for insert with check (user_id = auth.uid() and can_write());
create policy tags_update on tags for update using (user_id = auth.uid() and can_edit()) with check (user_id = auth.uid());

create policy chapters_read   on chapters for select using (user_id = auth.uid());
create policy chapters_insert on chapters for insert with check (user_id = auth.uid() and can_write());
create policy chapters_update on chapters for update using (user_id = auth.uid() and can_edit()) with check (user_id = auth.uid());

create policy entries_read   on entries for select using (user_id = auth.uid());
create policy entries_insert on entries for insert with check (user_id = auth.uid() and can_write());
create policy entries_update on entries for update using (user_id = auth.uid() and can_edit()) with check (user_id = auth.uid());
-- No delete policy: deletes are soft (update deleted_at).

-- Child rows must point at an entry the caller owns (the sub-select runs under the caller's RLS).
create policy entry_tags_read   on entry_tags for select using (user_id = auth.uid());
create policy entry_tags_insert on entry_tags for insert with check (
  user_id = auth.uid() and can_write()
  and exists (select 1 from entries e where e.id = entry_id and e.user_id = auth.uid())
);
create policy entry_tags_update on entry_tags for update using (user_id = auth.uid() and can_edit()) with check (user_id = auth.uid());

create policy media_read   on media for select using (user_id = auth.uid());
create policy media_insert on media for insert with check (
  user_id = auth.uid() and can_write()
  and exists (select 1 from entries e where e.id = entry_id and e.user_id = auth.uid())
);
create policy media_update on media for update using (user_id = auth.uid() and can_edit()) with check (user_id = auth.uid());

-- Versions are append-only. A concurrent-edit save during the grace window must still be able to log one.
create policy entry_versions_read   on entry_versions for select using (user_id = auth.uid());
create policy entry_versions_insert on entry_versions for insert with check (
  user_id = auth.uid() and can_edit()
  and exists (select 1 from entries e where e.id = entry_id and e.user_id = auth.uid())
);

-- ---------------------------------------------------------------------------
-- Storage: one private bucket. Paths are {user_id}/{entry_id}/{media_id}.webp
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

create policy media_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

create policy media_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text and can_write());
-- No client update/delete on objects: the nightly job (service role) removes soft-deleted photos.
