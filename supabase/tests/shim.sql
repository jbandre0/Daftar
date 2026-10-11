-- Local-only stand-ins for the parts of Supabase the migration depends on.
-- Used by app/scripts/db-test.mjs against in-memory Postgres. Never run this on Supabase.
create schema extensions;
create schema auth;
create schema storage;

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create table auth.users (
  id uuid primary key,
  aud text, role text, email text,
  created_at timestamptz default now()
);

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create table storage.buckets (id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;

-- Supabase grants usage on the extensions schema (pg_trgm lives there) to these roles by default.
grant usage on schema public, storage, auth, extensions to anon, authenticated;
grant select, insert on storage.objects to authenticated;
-- Supabase grants everything on new public tables to these roles by default; the migration must tighten it.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
