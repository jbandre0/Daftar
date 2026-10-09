-- Daftar · RLS and licensing test. Run in Supabase → SQL Editor (or locally via `npm run db:test`).
-- It creates two throw-away users, tries to break every rule, deletes them again, and prints one row per check.
-- Every row in the result must say PASS.

drop table if exists pg_temp.rls_results;
create temp table rls_results (n serial, passed boolean, test text, detail text);

-- Start clean in case an earlier run stopped half-way.
delete from auth.users where email like 'rlstest-%@example.test';

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
select pg_temp.t('A cannot tag B''s entry',             '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entry_tags (entry_id, tag_id, user_id) values ('00000000-0000-0000-0000-00000000bbb1', gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.t('A cannot attach media to B''s entry', '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into media (user_id, entry_id, storage_path, mime, bytes, sha256) values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000bbb1', 'x', 'image/webp', 1, 'abc')$q$);
select pg_temp.t('A cannot version B''s entry',         '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entry_versions (entry_id, user_id, snapshot, reason) values ('00000000-0000-0000-0000-00000000bbb1', '00000000-0000-0000-0000-0000000000a1', '{}', 'concurrent_edit')$q$);

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
select pg_temp.t('sealed letter needs an unlock date',  '^err:23514$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date, sealed) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-02', true)$q$);

-- ---- 6. Trial ended long ago (more than 48h): read-only ---------------------------------------------------
update licenses set trial_ends_at = now() - interval '3 days' where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.t('expired: inserts fail',               '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-03')$q$);
select pg_temp.t('expired: edits fail',                 '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set title = 'late' where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('expired: new tags fail',              '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into tags (user_id, name) values ('00000000-0000-0000-0000-0000000000a1', 'late')$q$);
select pg_temp.t('expired: reading still works',        '^ok:2$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select * from entries$q$);
select pg_temp.t('expired: can_write() is false',       '^ok:0$',  '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$select 1 where can_write()$q$);

-- ---- 7. Grace window: ended less than 48h ago ----------------------------------------------------------------
update licenses set trial_ends_at = now() - interval '1 hour' where user_id = '00000000-0000-0000-0000-0000000000a1';
select pg_temp.t('grace: new entries blocked',          '^err:42501$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entries (id, user_id, entry_date) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1', '2026-10-03')$q$);
select pg_temp.t('grace: edits to existing entries land', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$update entries set title = 'in progress' where id = '00000000-0000-0000-0000-00000000aaa1'$q$);
select pg_temp.t('grace: a conflict version can be logged', '^ok:1$', '00000000-0000-0000-0000-0000000000a1', 'authenticated', $q$insert into entry_versions (entry_id, user_id, snapshot, reason) values ('00000000-0000-0000-0000-00000000aaa1', '00000000-0000-0000-0000-0000000000a1', '{}', 'concurrent_edit')$q$);
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

-- ---- Cleanup, then the report -------------------------------------------------------------------------------------
delete from prompts where text = 'Test prompt';
delete from auth.users where email like 'rlstest-%@example.test';
select pg_temp.check_('test users and all their rows were removed', (select count(*) = 0 from entries where user_id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2')));

select case when passed then 'PASS' else 'FAIL' end as result, test, case when passed then '' else detail end as detail
from rls_results order by n;
