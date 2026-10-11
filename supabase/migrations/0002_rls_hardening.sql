-- Daftar v1 · migration 0002 · fixes from the Opus review of 0001.
-- Paste the whole file into Supabase → SQL Editor and run it once, then re-run tests/rls.test.sql.
--
-- 1. Cross-account references: foreign keys bypass RLS, so a user could tag their entry with someone
--    else's tag or file it under someone else's track. Child rows now use composite keys (id, user_id),
--    so every reference must point at a row owned by the same user.
-- 2. Long entries: the search column failed with "string is too long for tsvector" above ~1 MB of
--    varied text, which would make the save fail. Search now indexes the first 200,000 characters;
--    the full text is still stored and exported.
-- 3. Future tables and functions are closed by default (Supabase otherwise grants them to anon).
-- 4. Policies use (select auth.uid()) so Postgres evaluates it once per query, not once per row.
-- 5. Photo bucket accepts only WebP up to 3 MB.
-- 6. Indexes on user_id for tables that lacked one.

-- ---------------------------------------------------------------------------
-- 1. Same-owner references
-- ---------------------------------------------------------------------------

alter table entries add constraint entries_id_user unique (id, user_id);
alter table tracks  add constraint tracks_id_user  unique (id, user_id);
alter table tags    add constraint tags_id_user    unique (id, user_id);

alter table entries drop constraint entries_track_id_fkey;
alter table entries add constraint entries_track_owner
  foreign key (track_id, user_id) references tracks (id, user_id);

alter table templates drop constraint templates_track_fk;
alter table templates add constraint templates_track_owner
  foreign key (track_id, user_id) references tracks (id, user_id);

alter table entry_tags drop constraint entry_tags_entry_id_fkey;
alter table entry_tags drop constraint entry_tags_tag_id_fkey;
alter table entry_tags add constraint entry_tags_entry_owner
  foreign key (entry_id, user_id) references entries (id, user_id) on delete cascade;
alter table entry_tags add constraint entry_tags_tag_owner
  foreign key (tag_id, user_id) references tags (id, user_id) on delete cascade;

alter table media drop constraint media_entry_id_fkey;
alter table media add constraint media_entry_owner
  foreign key (entry_id, user_id) references entries (id, user_id) on delete cascade;

alter table entry_versions drop constraint entry_versions_entry_id_fkey;
alter table entry_versions add constraint entry_versions_entry_owner
  foreign key (entry_id, user_id) references entries (id, user_id) on delete cascade;

-- tracks.default_template_id may point at a global template (user_id null), so it can't be a
-- composite key. The track policies below check it instead.

-- ---------------------------------------------------------------------------
-- 2. Search column that can never block a save
-- ---------------------------------------------------------------------------

drop index entries_search;
alter table entries drop column search;
alter table entries add column search tsvector generated always as (
  to_tsvector('simple'::regconfig, left(coalesce(title, '') || ' ' || body_text, 200000))
) stored;
create index entries_search on entries using gin (search);

-- ---------------------------------------------------------------------------
-- 3. Closed by default
-- ---------------------------------------------------------------------------

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies, rewritten
-- ---------------------------------------------------------------------------

drop policy profiles_read on profiles;
drop policy profiles_update on profiles;
create policy profiles_read   on profiles for select using (id = (select auth.uid()));
create policy profiles_update on profiles for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy licenses_read on licenses;
create policy licenses_read on licenses for select using (user_id = (select auth.uid()));

drop policy templates_read on templates;
drop policy templates_insert on templates;
drop policy templates_update on templates;
create policy templates_read   on templates for select using (user_id is null or user_id = (select auth.uid()));
create policy templates_insert on templates for insert with check (user_id = (select auth.uid()) and (select can_write()));
create policy templates_update on templates for update using (user_id = (select auth.uid()) and (select can_edit())) with check (user_id = (select auth.uid()));

-- The template sub-select runs under the caller's RLS, so it only sees global or own templates.
drop policy tracks_read on tracks;
drop policy tracks_insert on tracks;
drop policy tracks_update on tracks;
create policy tracks_read   on tracks for select using (user_id = (select auth.uid()));
create policy tracks_insert on tracks for insert with check (
  user_id = (select auth.uid()) and (select can_write())
  and (default_template_id is null or exists (select 1 from templates t where t.id = default_template_id))
);
create policy tracks_update on tracks for update using (user_id = (select auth.uid()) and (select can_edit())) with check (
  user_id = (select auth.uid())
  and (default_template_id is null or exists (select 1 from templates t where t.id = default_template_id))
);

drop policy tags_read on tags;
drop policy tags_insert on tags;
drop policy tags_update on tags;
create policy tags_read   on tags for select using (user_id = (select auth.uid()));
create policy tags_insert on tags for insert with check (user_id = (select auth.uid()) and (select can_write()));
create policy tags_update on tags for update using (user_id = (select auth.uid()) and (select can_edit())) with check (user_id = (select auth.uid()));

drop policy chapters_read on chapters;
drop policy chapters_insert on chapters;
drop policy chapters_update on chapters;
create policy chapters_read   on chapters for select using (user_id = (select auth.uid()));
create policy chapters_insert on chapters for insert with check (user_id = (select auth.uid()) and (select can_write()));
create policy chapters_update on chapters for update using (user_id = (select auth.uid()) and (select can_edit())) with check (user_id = (select auth.uid()));

drop policy entries_read on entries;
drop policy entries_insert on entries;
drop policy entries_update on entries;
create policy entries_read   on entries for select using (user_id = (select auth.uid()));
create policy entries_insert on entries for insert with check (user_id = (select auth.uid()) and (select can_write()));
create policy entries_update on entries for update using (user_id = (select auth.uid()) and (select can_edit())) with check (user_id = (select auth.uid()));

-- Ownership of the entry and tag is now enforced by the composite keys.
drop policy entry_tags_read on entry_tags;
drop policy entry_tags_insert on entry_tags;
drop policy entry_tags_update on entry_tags;
create policy entry_tags_read   on entry_tags for select using (user_id = (select auth.uid()));
create policy entry_tags_insert on entry_tags for insert with check (user_id = (select auth.uid()) and (select can_write()));
create policy entry_tags_update on entry_tags for update using (user_id = (select auth.uid()) and (select can_edit())) with check (user_id = (select auth.uid()));

drop policy media_read on media;
drop policy media_insert on media;
drop policy media_update on media;
create policy media_read   on media for select using (user_id = (select auth.uid()));
create policy media_insert on media for insert with check (user_id = (select auth.uid()) and (select can_write()));
create policy media_update on media for update using (user_id = (select auth.uid()) and (select can_edit())) with check (user_id = (select auth.uid()));

drop policy entry_versions_read on entry_versions;
drop policy entry_versions_insert on entry_versions;
create policy entry_versions_read   on entry_versions for select using (user_id = (select auth.uid()));
create policy entry_versions_insert on entry_versions for insert with check (user_id = (select auth.uid()) and (select can_edit()));

drop policy media_objects_read on storage.objects;
drop policy media_objects_insert on storage.objects;
create policy media_objects_read on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy media_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = (select auth.uid())::text and (select can_write()));

-- ---------------------------------------------------------------------------
-- 5. Bucket limits (compressed photos are ~150–300 KB; 3 MB leaves room for detailed images)
-- ---------------------------------------------------------------------------

update storage.buckets set file_size_limit = 3145728, allowed_mime_types = array['image/webp'] where id = 'media';

-- ---------------------------------------------------------------------------
-- 6. Indexes for the user_id = auth.uid() filter
-- ---------------------------------------------------------------------------

create index templates_user      on templates (user_id);
create index tags_user           on tags (user_id);
create index chapters_user       on chapters (user_id);
create index entry_versions_user on entry_versions (user_id);
