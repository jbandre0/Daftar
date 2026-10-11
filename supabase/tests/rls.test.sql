-- Daftar · RLS and licensing test. Run in Supabase → SQL Editor (or locally via `npm run db:test`).
-- It creates two throw-away users, tries to break every rule, deletes them again, and prints one row per check.
-- Every row in the result must say PASS.

drop table if exists pg_temp.rls_results;
create temp table rls_results (n serial, passed boolean, test text, detail text);

-- Start clean in case an earlier run stopped half-way.
delete from auth.users where email like 'rlstest-%@example.test';
delete from templates where id = '00000000-0000-0000-0000-00000000e000';
delete from prompts where text = 'Test prompt';

-- Runs one statement as a given user/role and reports 'ok:<rows touched>' or 'err:<sqlstate>'.
create or replace function pg_temp.run_as(uid uuid, role_name text, stmt text) returns text
language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', role_name)::text, true);
  execute format('set local role %I', role_name);
  execute stmt;
  get diagnostics n = row_count;
  reset role;
  return 'ok:' || n;
exception when others then
  reset role;
  return 'err:' || sqlstate;
end $$;

-- Records PASS if the outcome matches the regex.
create or replace function pg_temp.t(test text, expect text, uid uuid, role_name text, stmt text) returns void
language plpgsql as $$
declare r text := pg_temp.run_as(uid, role_name, stmt);
begin
  insert into rls_results (passed, test, detail) values (r ~ expect, test, 'got ' || r || ', wanted ' || expect);
end $$;

create or replace function pg_temp.check_(test text, ok boolean, detail text default '') returns void
language plpgsql as $$
begin
  insert into rls_results (passed, test, detail) values (coalesce(ok, false), test, detail);
end $$;

-- ---- Setup (as the owner, which bypasses RLS) --------------------------------------------------
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'rlstest-a@example.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'authenticated', 'authenticated', 'rlstest-b@example.test');

insert into entries (id, user_id, entry_date, title, body_text) values
  ('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000a1', '2026-10-01', 'A first', 'alpha'),
  ('00000000-0000-0000-0000-00000000bbb1', '00000000-0000-0000-0000-0000000000b2', '2026-10-01', 'B secret', 'beta');
insert into prompts (text, depth) values ('Test prompt', 'light');
insert into tags (id, user_id, name) values ('00000000-0000-0000-0000-0000000007b2', '00000000-0000-0000-0000-0000000000b2', 'b-private');
insert into templates (id, user_id, name) values
  ('00000000-0000-0000-0000-00000000e0b2', '00000000-0000-0000-0000-0000000000b2', 'B private template'),
  ('00000000-0000-0000-0000-00000000e000', null, 'rlstest global template');

-- ---- 1. Signup trigger -------------------------------------------------------------------------
select pg_temp.check_('signup creates a profile', (select count(*) = 1 from profiles where id = '00000000-0000-0000-0000-0000000000a1'));
select pg_temp.check_('signup starts a 21-day trial', (select trial_ends_at - trial_started_at = interval '21 days' and status = 'trial' from licenses where user_id = '00000000-0000-0000-0000-0000000000a1'));
select pg_temp.check_('signup copies the four built-in tracks', (select count(*) = 4 from tracks where user_id = '00000000-0000-0000-0000-0000000000a1' and is_builtin));

-- ---- 2. User A cannot see or touch user B -------------------------------------------------------
select pg_temp.t('A reads own entries',                 '^ok:1$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from entries$q$);
select pg_temp.t('A cannot read B''s entries',          '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from entries where user_id = '00000000-0000-0000-0000-0000000000b2'$q$);
select pg_temp.t('A cannot read B''s profile',          '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from profiles where id = '00000000-0000-0000-0000-0000000000b2'$q$);
select pg_temp.t('A cannot read B''s licence',          '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from licenses where user_id = '00000000-0000-0000-0000-0000000000b2'$q$);
select pg_temp.t('A cannot read B''s tracks',           '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from tracks where user_id = '00000000-0000-0000-0000-0000000000b2'$q$);
select pg_temp.t('A cannot insert an entry as B',       '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000b2', '2026-10-02')$q$);
select pg_temp.t('A cannot update B''s entry',          '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set title = 'hacked' where id = '00000000-0000-0000-0000-00000000bbb1'$q$);
select pg_temp.check_('B''s entry is untouched', (select title = 'B secret' from entries where id = '00000000-0000-0000-0000-00000000bbb1'));
select pg_temp.t('A cannot move own entry to B',        '^(ok:0|err:42501)$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set user_id = '00000000-0000-0000-0000-0000000000b2' where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('A cannot tag B''s entry',             '^err:(42501|23503)$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entry_tags (entry_id, tag_id, user_id) values ('00000000-0000-0000-0000-00000000bbb1', gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.t('A cannot attach media to B''s entry', '^err:(42501|23503)$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into media (user_id, entry_id, storage_path, mime, bytes, sha256) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000bbb1', 'x', 'image/webp', 1, 'abc')$q$);
select pg_temp.t('A cannot version B''s entry',         '^err:(42501|23503)$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entry_versions (entry_id, user_id, snapshot, reason) values ('00000000-0000-0000-0000-00000000bbb1', '00000000-0000-0000-0000-0000000000a1', '{}', 'concurrent_edit')$q$);

select pg_temp.t('A cannot tag own entry with B''s tag', '^err:(42501|23503)$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entry_tags (entry_id, tag_id, user_id) values ('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000007b2', '00000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.t('A cannot file own entry under B''s track', '^err:(42501|23503)$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', format($q$update entries set track_id = %L where id = '00000000-0000-0000-0000-00000000aaa1'$q$, (select id from tracks where user_id = '00000000-0000-0000-0000-0000000000b2' limit 1)));
select pg_temp.t('A cannot point a track at B''s template', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update tracks set default_template_id = '00000000-0000-0000-0000-00000000e0b2' where user_id = '00000000-0000-0000-0000-0000000000a1' and slug = 'daily'$q$);
select pg_temp.t('A can point a track at a global template', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update tracks set default_template_id = '00000000-0000-0000-0000-00000000e000' where user_id = '00000000-0000-0000-0000-0000000000a1' and slug = 'daily'$q$);
select pg_temp.t('A can file own entry under own track', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', format($q$update entries set track_id = %L where id = '00000000-0000-0000-0000-00000000aaa1'$q$, (select id from tracks where user_id = '00000000-0000-0000-0000-0000000000a1' and slug = 'daily')));

-- ---- 3. Nothing is ever hard-deleted from the client; anon sees nothing ---------------------------
select pg_temp.t('A cannot hard-delete own entry',      '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$delete from entries where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('A can soft-delete own entry',         '^ok:1$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set deleted_at = now() where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('A can undo the soft delete',          '^ok:1$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set deleted_at = null where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('signed-out visitor cannot read entries', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'anon', $q$select * from entries$q$);
select pg_temp.t('signed-out visitor can read prompts', '^ok:1$',  '00000000-0000-0000-0000-0000000000a1', 'anon', $q$select * from prompts$q$);
select pg_temp.t('A cannot write prompts',              '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into prompts (text, depth) values ('x', 'light')$q$);

-- ---- 4. Licences cannot be written from the client ------------------------------------------------
select pg_temp.t('A reads own licence',                 '^ok:1$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from licenses$q$);
select pg_temp.t('A cannot unlock themselves',          '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update licenses set status = 'unlocked' where user_id = '00000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.t('A cannot extend own trial',           '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update licenses set trial_ends_at = now() + interval '10 years' where user_id = '00000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.t('A cannot insert a licence',           '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into licenses (user_id, status) values ('00000000-0000-0000-0000-0000000000a1', 'unlocked')$q$);
select pg_temp.t('A cannot delete a licence',           '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$delete from licenses$q$);
select pg_temp.t('A can rename own profile',            '^ok:1$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update profiles set display_name = 'Ada' where id = '00000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.t('A cannot edit storage_bytes_used',    '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update profiles set storage_bytes_used = 0 where id = '00000000-0000-0000-0000-0000000000a1'$q$);

-- ---- 5. Server-side clock: updated_at and sealed letters ---------------------------------------------
select pg_temp.t('A inserts a normal entry (trial running)', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date, title, updated_at) values ('00000000-0000-0000-0000-00000000aaa2', '00000000-0000-0000-0000-0000000000a1', '2026-10-02', 'forged clock', '2000-01-01')$q$);
select pg_temp.check_('updated_at ignores the client value', (select updated_at > now() - interval '1 minute' from entries where id = '00000000-0000-0000-0000-00000000aaa2'));
select pg_temp.t('a 2.6 MB entry still saves', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date, body_text) select '00000000-0000-0000-0000-00000000aaa3', '00000000-0000-0000-0000-0000000000a1', '2026-10-02', string_agg(md5(i::text), ' ') from generate_series(1, 80000) i$q$);
select pg_temp.check_('a long entry is still searchable', (select search @@ to_tsquery('simple', md5('1')) from entries where id = '00000000-0000-0000-0000-00000000aaa3'));
select pg_temp.check_('a long entry keeps its full text', (select length(body_text) > 2500000 from entries where id = '00000000-0000-0000-0000-00000000aaa3'));
select pg_temp.t('sealed letter needs an unlock date',  '^err:23514$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date, sealed) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-02', true)$q$);

-- ---- 5b. save_entry: the editor's only save path ---------------------------------------------------------
select pg_temp.t('save: new entry is created at revision 1', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","entry_date":"2026-10-05","title":"t","body_text":"one","body_rich":{"type":"doc"}}', 0) @> '{"revision":1,"created":true,"conflict":false}'$q$);
select pg_temp.t('save: next save bumps to revision 2', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","body_text":"one two"}', 1) @> '{"revision":2,"conflict":false}'$q$);
select pg_temp.t('save: identical retry is a no-op', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","body_text":"one two"}', 1) @> '{"revision":2,"conflict":false}'$q$);
select pg_temp.check_('save: partial save kept the other fields', (select title = 't' and body_text = 'one two' and entry_date = '2026-10-05' from entries where id = '00000000-0000-0000-0000-00000000aaa5'));
select pg_temp.t('save: stale save from another device wins but flags a conflict', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","body_text":"from the phone"}', 1) @> '{"revision":3,"conflict":true}'$q$);
select pg_temp.check_('save: the overwritten version is kept', (select count(*) = 1 from entry_versions where entry_id = '00000000-0000-0000-0000-00000000aaa5' and reason = 'concurrent_edit' and snapshot ->> 'body_text' = 'one two' and not snapshot ? 'search'));
select pg_temp.t('save: displaced tab text is kept as a version', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","body_text":"merged"}', 3, '[{"body_text":"other tab"}]') @> '{"revision":4,"conflict":true}'$q$);
select pg_temp.check_('save: displaced snapshot stored', (select count(*) = 1 from entry_versions where entry_id = '00000000-0000-0000-0000-00000000aaa5' and snapshot ->> 'body_text' = 'other tab'));
select pg_temp.t('save: B cannot save into A''s entry', '^err:42501$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$select save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","body_text":"hijack"}', 4)$q$);
select pg_temp.check_('save: A''s entry untouched by B', (select body_text = 'merged' and revision = 4 from entries where id = '00000000-0000-0000-0000-00000000aaa5'));
select pg_temp.t('save: signed-out visitor cannot call it', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'anon', $q$select save_entry('{"id":"00000000-0000-0000-0000-00000000aaa6"}', 0)$q$);

-- ---- 5c. Organisation: templates, tags, chapters ---------------------------------------------------------
select pg_temp.check_('Spiritual track points at the Spiritual template', (select default_template_id = '00000000-0000-4000-8000-0000000000e1' from tracks where user_id = '00000000-0000-0000-0000-0000000000a1' and slug = 'spiritual'));
select pg_temp.check_('Letters and Dreams have no template', (select count(*) = 0 from tracks where user_id = '00000000-0000-0000-0000-0000000000a1' and slug in ('letters', 'dreams') and default_template_id is not null));
select pg_temp.t('A can read the global template', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from templates where id = '00000000-0000-4000-8000-0000000000e1'$q$);
select pg_temp.t('A cannot edit the global template', '^ok:0$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update templates set name = 'hacked' where id = '00000000-0000-4000-8000-0000000000e1'$q$);
select pg_temp.t('A cannot create a global template', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into templates (user_id, name) values (null, 'mine')$q$);
select pg_temp.t('A cannot read B''s template', '^ok:0$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from templates where id = '00000000-0000-0000-0000-00000000e0b2'$q$);

select pg_temp.t('A creates a tag', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into tags (id, user_id, name) values ('00000000-0000-0000-0000-0000000007a1', '00000000-0000-0000-0000-0000000000a1', 'family')$q$);
select pg_temp.t('tag names are unique ignoring case', '^err:23505$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into tags (user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'FAMILY')$q$);
select pg_temp.t('A can rename a tag', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update tags set name = 'Family' where id = '00000000-0000-0000-0000-0000000007a1'$q$);
select pg_temp.t('B cannot rename A''s tag', '^ok:0$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$update tags set name = 'x' where id = '00000000-0000-0000-0000-0000000007a1'$q$);
select pg_temp.t('B cannot see A''s tag', '^ok:0$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$select * from tags where id = '00000000-0000-0000-0000-0000000007a1'$q$);

select pg_temp.t('save_entry attaches own tag and skips B''s', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa9","entry_date":"2026-09-15","body_text":"tagged","tag_ids":["00000000-0000-0000-0000-0000000007a1","00000000-0000-0000-0000-0000000007b2"]}', 0) @> '{"revision":1,"created":true}'$q$);
select pg_temp.check_('only the caller''s tag is linked', (select array_agg(tag_id) = array['00000000-0000-0000-0000-0000000007a1'::uuid] from entry_tags where entry_id = '00000000-0000-0000-0000-00000000aaa9' and deleted_at is null));
select pg_temp.t('identical retry with tags is a no-op', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa9","tag_ids":["00000000-0000-0000-0000-0000000007a1"]}', 1) @> '{"revision":1}'$q$);
select pg_temp.t('removing every tag is a change', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa9","tag_ids":[]}', 1) @> '{"revision":2}'$q$);
select pg_temp.check_('unlinked tag is soft-deleted, not removed', (select count(*) = 1 and bool_and(deleted_at is not null) from entry_tags where entry_id = '00000000-0000-0000-0000-00000000aaa9'));
select pg_temp.t('re-adding the tag revives the same link', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa9","tag_ids":["00000000-0000-0000-0000-0000000007a1"]}', 2) @> '{"revision":3}'$q$);
select pg_temp.check_('one link row, active again', (select count(*) = 1 and bool_and(deleted_at is null) from entry_tags where entry_id = '00000000-0000-0000-0000-00000000aaa9'));
select pg_temp.t('a save without tag_ids leaves tags alone', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa9","title":"renamed"}', 3) @> '{"revision":4}'$q$);
select pg_temp.check_('tags untouched by that save', (select count(*) = 1 from entry_tags where entry_id = '00000000-0000-0000-0000-00000000aaa9' and deleted_at is null));
select pg_temp.t('an unknown tag id never fails the text save', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa9","body_text":"still saves","tag_ids":["00000000-0000-0000-0000-0000000007a1","00000000-0000-0000-0000-00000000dead"]}', 4) @> '{"revision":5}'$q$);

select pg_temp.t('A creates a chapter', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into chapters (id, user_id, name, start_date, end_date) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'September', '2026-09-01', '2026-09-30')$q$);
select pg_temp.t('A creates an ongoing chapter', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into chapters (id, user_id, name, start_date) values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'October on', '2026-10-01')$q$);
select pg_temp.t('a chapter cannot end before it starts', '^err:23514$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into chapters (user_id, name, start_date, end_date) values ('00000000-0000-0000-0000-0000000000a1', 'backwards', '2026-10-02', '2026-10-01')$q$);
select pg_temp.t('chapter shows the entries inside its dates', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select e.* from entries e join chapters c on e.entry_date >= c.start_date and (c.end_date is null or e.entry_date <= c.end_date) where c.id = '00000000-0000-0000-0000-0000000000c1' and e.deleted_at is null$q$);
select pg_temp.t('ongoing chapter shows only A''s entries from its start', '^ok:4$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select e.* from entries e join chapters c on e.entry_date >= c.start_date and (c.end_date is null or e.entry_date <= c.end_date) where c.id = '00000000-0000-0000-0000-0000000000c2' and e.deleted_at is null$q$);
select pg_temp.t('A can rename a chapter', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update chapters set name = 'Sept' where id = '00000000-0000-0000-0000-0000000000c1'$q$);
select pg_temp.t('B cannot touch A''s chapter', '^ok:0$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$update chapters set name = 'x' where id = '00000000-0000-0000-0000-0000000000c1'$q$);
select pg_temp.t('B cannot see A''s chapters', '^ok:0$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$select * from chapters$q$);

select pg_temp.t('A records an import remap', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select remember_remap('entry', '00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000aaa1')$q$);
select pg_temp.t('B cannot see A''s import remaps', '^ok:0$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$select * from restore_remaps$q$);
select pg_temp.t('export_journal only exports the caller''s journal', '^ok:1$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$select 1 where jsonb_array_length(export_journal() -> 'entries') = 1 and not (export_journal()::text like '%A first%')$q$);
select pg_temp.t('restore into A''s entry from B''s session cannot touch it', '^ok:1$', '00000000-0000-0000-0000-0000000000b2', 'authenticated', $q$select 1 where (restore_batch('{"entries":[{"id":"00000000-0000-0000-0000-00000000aaa1","entry_date":"2026-10-01","body_text":"hijack","updated_at":"2030-01-01T00:00:00Z"}]}', '{}', false) -> 'entries' -> 0 ->> 'stored_as') <> '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.check_('A''s entry kept its text', (select body_text <> 'hijack' from entries where id = '00000000-0000-0000-0000-00000000aaa1'));

-- ---- 6. Trial ended long ago (more than 48h): read-only ---------------------------------------------------
update licenses set trial_ends_at = now() - interval '3 days' where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.t('expired: inserts fail',               '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-03')$q$);
select pg_temp.t('expired: edits fail',                 '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set title = 'late' where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('expired: new tags fail',              '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into tags (user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'late')$q$);
select pg_temp.t('expired: reading still works',        '^ok:5$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from entries$q$);
select pg_temp.t('expired: save_entry edit refused',    '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","body_text":"late"}', 4)$q$);
select pg_temp.t('expired: save_entry new entry refused', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select save_entry('{"id":"00000000-0000-0000-0000-00000000aaa7","body_text":"late"}', 0)$q$);
select pg_temp.t('expired: can_write() is false',       '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where can_write()$q$);

-- ---- 7. Grace window: ended less than 48h ago ----------------------------------------------------------------
update licenses set trial_ends_at = now() - interval '1 hour' where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.t('grace: new entries blocked',          '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-03')$q$);
select pg_temp.t('grace: edits to existing entries land', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set title = 'in progress' where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('grace: a conflict version can be logged', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entry_versions (entry_id, user_id, snapshot, reason) values ('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000a1', '{}', 'concurrent_edit')$q$);
select pg_temp.t('grace: save_entry edit lands',       '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where save_entry('{"id":"00000000-0000-0000-0000-00000000aaa5","body_text":"landed in grace"}', 4) @> '{"revision":5}'$q$);
select pg_temp.t('grace: save_entry new entry refused', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select save_entry('{"id":"00000000-0000-0000-0000-00000000aaa8","body_text":"new"}', 0)$q$);
select pg_temp.t('grace: photos blocked (media row)',   '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into media (user_id, entry_id, storage_path, mime, bytes, sha256) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aaa1', 'x', 'image/webp', 1, 'abc')$q$);

-- ---- 8. Unlocked, refunded -----------------------------------------------------------------------------------------
update licenses set status = 'unlocked', unlocked_at = now() where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.t('unlocked (trial long over): writes work', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-04')$q$);
update licenses set status = 'refunded', trial_ends_at = now() + interval '10 days' where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.t('refunded: inserts fail even with trial days left', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-05')$q$);
select pg_temp.t('refunded: edits fail',                '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set title = 'x' where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('refunded: reading still works',       '^ok:[1-9]',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from entries$q$);

-- ---- 9. Storage policy (skipped on real Supabase: direct deletes from storage tables are blocked, so
--         the cleanup would leave rows behind. Phase 6 tests this through real uploads.) -------------------------------
update licenses set status = 'trial', trial_ends_at = now() + interval '5 days' where user_id = '00000000-0000-0000-0000-0000000000a1';
do $$
begin
  if to_regproc('storage.protect_delete') is not null then
    perform pg_temp.check_('storage policy tests skipped on real Supabase (covered in phase 6)', true, 'SKIP');
    return;
  end if;
  insert into storage.buckets (id, name) values ('media', 'media') on conflict do nothing;
  insert into storage.objects (bucket_id, name) values ('media', '00000000-0000-0000-0000-0000000000b2/e/m.webp');
  perform pg_temp.t('storage: A uploads into own folder',   '^ok:1$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into storage.objects (bucket_id, name) values ('media', '00000000-0000-0000-0000-0000000000a1/e/m.webp')$q$);
  perform pg_temp.t('storage: A cannot upload into B''s folder', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into storage.objects (bucket_id, name) values ('media', '00000000-0000-0000-0000-0000000000b2/e/x.webp')$q$);
  perform pg_temp.t('storage: A cannot see B''s photos',    '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from storage.objects where name like '00000000-0000-0000-0000-0000000000b2/%'$q$);
  update licenses set trial_ends_at = now() - interval '3 days' where user_id = '00000000-0000-0000-0000-0000000000a1';
  perform pg_temp.t('storage: expired trial cannot upload', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into storage.objects (bucket_id, name) values ('media', '00000000-0000-0000-0000-0000000000a1/e/late.webp')$q$);
  delete from storage.objects where name like '00000000-0000-0000-0000-0000000000%/%';
end $$;

select pg_temp.check_('photo bucket only takes WebP up to 3 MB', (select file_size_limit = 3145728 and allowed_mime_types = array['image/webp'] from storage.buckets where id = 'media'));

-- ---- Cleanup, then the report -------------------------------------------------------------------------------------
delete from prompts where text = 'Test prompt';
delete from auth.users where email like 'rlstest-%@example.test';
delete from templates where id = '00000000-0000-0000-0000-00000000e000';
select pg_temp.check_('test users and all their rows were removed', (select count(*) = 0 from entries where user_id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2')));

select case when passed then 'PASS' else 'FAIL' end as result, test, case when passed then '' else detail end as detail
from rls_results order by n;
