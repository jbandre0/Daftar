-- Daftar v1 · migration 0005 · the Vault: export and restore (phase 4).
-- Paste into Supabase → SQL Editor and run once, then re-run tests/rls.test.sql.
--
-- export_journal()   One consistent snapshot of the caller's journal as JSON. The app wraps it with the
--                    readme and format header and adds any drafts not yet synced from this device.
-- restore_meta()     Tracks, tags and chapters from a file. Returns how imported ids map to local ones.
-- restore_batch()    Up to ~100 entries (plus their saved versions) from a file, using that id map.
--
-- Both restore functions take p_dry_run. The preview the user confirms and the real merge run the same
-- code; the dry run just never writes. Everything runs as the caller (security invoker): RLS and the
-- trial rules apply, and a restore needs an active trial or unlock (spec §5, open question 1).
--
-- The rules (spec §5, "Conflict rules"):
--   entry id not in this account ................ insert, keeping the id
--   id belongs to another account ............... insert under a new id, and report the remap
--   same content after merging tags ............. unchanged, nothing written
--   imported copy is newer ...................... keep the current row in entry_versions, then overwrite
--   this account's copy is newer or equal ........ keep it ("skipped, yours is newer")
--   in the trash here, imported copy is newer .... take it out of the trash and update it
--   in the trash here, deletion is newer ......... stays deleted, listed in the report
--   tags on a merged entry ...................... union of both sides
--   sealed letters .............................. text imports, but restore never breaks a seal
--   track / tag / chapter: same id .............. keep local settings; a newer rename wins
--   track / tag / chapter: same name ............ reuse the local one, remap the imported id
--   track / tag / chapter: no match ............. create it, keeping the imported id
-- Restoring the same file twice changes nothing: every write is skipped when it would change nothing, and
-- an id that had to be replaced (it belonged to another account) is remembered in restore_remaps, so the
-- next restore of that file finds the copy instead of making another one.

create table restore_remaps (
  user_id    uuid not null references auth.users on delete cascade,
  kind       text not null check (kind in ('entry', 'track', 'tag', 'chapter')),
  source_id  uuid not null,
  local_id   uuid not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, source_id)
);
alter table restore_remaps enable row level security;
create policy restore_remaps_read on restore_remaps for select using (user_id = (select auth.uid()));
create policy restore_remaps_insert on restore_remaps for insert with check (user_id = (select auth.uid()) and (select can_write()));
create policy restore_remaps_update on restore_remaps for update using (user_id = (select auth.uid()) and (select can_write())) with check (user_id = (select auth.uid()));
grant select, insert, update on restore_remaps to authenticated;

create function remember_remap(p_kind text, p_source uuid, p_local uuid) returns void
language sql security invoker set search_path = public as $$
  insert into restore_remaps (user_id, kind, source_id, local_id) values (auth.uid(), p_kind, p_source, p_local)
  on conflict (user_id, kind, source_id) do update set local_id = excluded.local_id
$$;

create function remapped(p_kind text, p_source uuid) returns uuid
language sql stable security invoker set search_path = public as $$
  select coalesce((select local_id from restore_remaps where kind = p_kind and source_id = p_source), p_source)
$$;

-- ---------------------------------------------------------------------------
-- Timestamps in the file: UTC, ISO 8601, microsecond precision (so "newer" compares exactly).
-- ---------------------------------------------------------------------------

create function daftar_ts(t timestamptz) returns text
language sql immutable set search_path = public as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- ---------------------------------------------------------------------------
-- Export
-- ---------------------------------------------------------------------------

create function export_journal() returns jsonb
language sql stable security invoker set search_path = public as $$
  with
  live_entries as (
    select * from entries where user_id = auth.uid() and deleted_at is null
  ),
  live_tags as (
    select * from tags where user_id = auth.uid() and deleted_at is null
  )
  select jsonb_build_object(
    'account', (
      select jsonb_build_object('display_name', display_name, 'timezone', timezone, 'default_language', default_language)
      from profiles where id = auth.uid()
    ),
    -- Hidden tracks are included when an entry still uses them, so every reference in the file resolves.
    'tracks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'slug', t.slug, 'color_token', t.color_token, 'sort_order', t.sort_order,
        'hidden', t.deleted_at is not null,
        'default_template_id', (select tp.id from templates tp where tp.id = t.default_template_id and tp.user_id is null),
        'updated_at', daftar_ts(t.updated_at)
      ) order by t.sort_order, t.name, t.id)
      from tracks t
      where t.user_id = auth.uid()
        and (t.deleted_at is null or exists (select 1 from live_entries e where e.track_id = t.id))
    ), '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'updated_at', daftar_ts(g.updated_at))
                       order by lower(g.name), g.id)
      from live_tags g
    ), '[]'::jsonb),
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'description', c.description, 'start_date', c.start_date,
        'end_date', c.end_date, 'color_token', c.color_token, 'updated_at', daftar_ts(c.updated_at)
      ) order by c.start_date, c.name, c.id)
      from chapters c where c.user_id = auth.uid() and c.deleted_at is null
    ), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'entry_date', e.entry_date,
        'title', e.title,
        'track_id', e.track_id,
        'tag_ids', coalesce((
          select jsonb_agg(et.tag_id order by et.tag_id)
          from entry_tags et join live_tags g on g.id = et.tag_id
          where et.entry_id = e.id and et.deleted_at is null
        ), '[]'::jsonb),
        'language', e.language,
        'body_text', e.body_text,
        'body_rich', e.body_rich,
        'word_count', e.word_count,
        'fields', e.fields,
        'letter', case when e.is_letter or e.sealed or e.letter_to is not null then jsonb_build_object(
          'to', e.letter_to, 'sealed', e.sealed, 'unlock_at', daftar_ts(e.unlock_at)) end,
        'media', '[]'::jsonb,
        'created_at', daftar_ts(e.created_at),
        'updated_at', daftar_ts(e.updated_at)
      ) order by e.entry_date, e.created_at, e.id)
      from live_entries e
    ), '[]'::jsonb),
    'entry_versions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'entry_id', v.entry_id, 'reason', v.reason, 'created_at', daftar_ts(v.created_at), 'snapshot', v.snapshot
      ) order by v.created_at, v.id)
      from entry_versions v join live_entries e on e.id = v.entry_id
    ), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------
-- Restore: tracks, tags, chapters
-- ---------------------------------------------------------------------------

create function restore_meta(p jsonb, p_dry_run boolean default true) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  r          jsonb;
  v_id       uuid;
  v_src      uuid;
  v_new      uuid;
  v_slug     text;
  v_track    tracks;
  v_tag      tags;
  v_chapter  chapters;
  v_map_tr   jsonb := '{}';
  v_map_tg   jsonb := '{}';
  v_map_ch   jsonb := '{}';
  v_counts   jsonb := jsonb_build_object(
    'tracks',   jsonb_build_object('new', 0, 'matched', 0, 'by_name', 0, 'renamed', 0),
    'tags',     jsonb_build_object('new', 0, 'matched', 0, 'by_name', 0, 'renamed', 0),
    'chapters', jsonb_build_object('new', 0, 'matched', 0, 'by_name', 0, 'renamed', 0));
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not can_write() then
    raise exception 'restore needs an active trial or unlock' using errcode = '42501';
  end if;

  -- Tracks ------------------------------------------------------------------------------------------------
  for r in select value from jsonb_array_elements(coalesce(p -> 'tracks', '[]')) loop
    v_src := (r ->> 'id')::uuid;
    v_id := remapped('track', v_src);
    select * into v_track from tracks where id = v_id;
    if found then
      v_map_tr := v_map_tr || jsonb_build_object(v_src::text, v_id);
      v_counts := jsonb_set(v_counts, '{tracks,matched}', to_jsonb((v_counts #>> '{tracks,matched}')::int + 1));
      if (r ->> 'updated_at')::timestamptz > v_track.updated_at and (r ->> 'name') is distinct from v_track.name then
        v_counts := jsonb_set(v_counts, '{tracks,renamed}', to_jsonb((v_counts #>> '{tracks,renamed}')::int + 1));
        if not p_dry_run then
          update tracks set name = r ->> 'name' where id = v_id;
        end if;
      end if;
      continue;
    end if;

    select * into v_track from tracks
    where lower(name) = lower(r ->> 'name') and deleted_at is null
    order by sort_order, id limit 1;
    if found then
      v_map_tr := v_map_tr || jsonb_build_object(v_src::text, v_track.id);
      v_counts := jsonb_set(v_counts, '{tracks,by_name}', to_jsonb((v_counts #>> '{tracks,by_name}')::int + 1));
      continue;
    end if;

    v_counts := jsonb_set(v_counts, '{tracks,new}', to_jsonb((v_counts #>> '{tracks,new}')::int + 1));
    v_new := v_id;
    if not p_dry_run then
      v_slug := coalesce(nullif(r ->> 'slug', ''), 'track');
      if exists (select 1 from tracks where slug = v_slug) then
        v_slug := v_slug || '-' || substr(md5(random()::text), 1, 4);
      end if;
      insert into tracks (id, user_id, name, slug, color_token, sort_order, default_template_id, deleted_at)
      values (v_id, v_uid, r ->> 'name', v_slug, coalesce(r ->> 'color_token', 'flame'),
              coalesce((r ->> 'sort_order')::int, 0),
              (select id from templates where id = (r ->> 'default_template_id')::uuid and user_id is null),
              case when (r ->> 'hidden')::boolean then now() end)
      on conflict (id) do nothing
      returning id into v_new;
      if v_new is null then -- the id is used by another account
        v_new := gen_random_uuid();
        insert into tracks (id, user_id, name, slug, color_token, sort_order, deleted_at)
        values (v_new, v_uid, r ->> 'name', v_slug, coalesce(r ->> 'color_token', 'flame'),
                coalesce((r ->> 'sort_order')::int, 0), case when (r ->> 'hidden')::boolean then now() end);
        perform remember_remap('track', v_src, v_new);
      end if;
    end if;
    v_map_tr := v_map_tr || jsonb_build_object(v_src::text, v_new);
  end loop;

  -- Tags --------------------------------------------------------------------------------------------------
  for r in select value from jsonb_array_elements(coalesce(p -> 'tags', '[]')) loop
    v_src := (r ->> 'id')::uuid;
    v_id := remapped('tag', v_src);
    select * into v_tag from tags where id = v_id;
    if found and v_tag.deleted_at is null then
      v_map_tg := v_map_tg || jsonb_build_object(v_src::text, v_id);
      v_counts := jsonb_set(v_counts, '{tags,matched}', to_jsonb((v_counts #>> '{tags,matched}')::int + 1));
      if (r ->> 'updated_at')::timestamptz > v_tag.updated_at and (r ->> 'name') is distinct from v_tag.name
         and not exists (select 1 from tags where lower(name) = lower(r ->> 'name') and deleted_at is null and id <> v_id) then
        v_counts := jsonb_set(v_counts, '{tags,renamed}', to_jsonb((v_counts #>> '{tags,renamed}')::int + 1));
        if not p_dry_run then
          update tags set name = r ->> 'name' where id = v_id;
        end if;
      end if;
      continue;
    end if;

    select * into v_tag from tags where lower(name) = lower(r ->> 'name') and deleted_at is null limit 1;
    if found then
      v_map_tg := v_map_tg || jsonb_build_object(v_src::text, v_tag.id);
      v_counts := jsonb_set(v_counts, '{tags,by_name}', to_jsonb((v_counts #>> '{tags,by_name}')::int + 1));
      continue;
    end if;

    v_counts := jsonb_set(v_counts, '{tags,new}', to_jsonb((v_counts #>> '{tags,new}')::int + 1));
    v_new := v_id;
    if not p_dry_run then
      -- A deleted tag with this id here: bring it back under the imported name.
      update tags set deleted_at = null, name = r ->> 'name' where id = v_id and deleted_at is not null returning id into v_new;
      if v_new is null then
        insert into tags (id, user_id, name) values (v_id, v_uid, r ->> 'name')
        on conflict (id) do nothing returning id into v_new;
        if v_new is null then
          v_new := gen_random_uuid();
          insert into tags (id, user_id, name) values (v_new, v_uid, r ->> 'name');
          perform remember_remap('tag', v_src, v_new);
        end if;
      end if;
    end if;
    v_map_tg := v_map_tg || jsonb_build_object(v_src::text, v_new);
  end loop;

  -- Chapters ----------------------------------------------------------------------------------------------
  for r in select value from jsonb_array_elements(coalesce(p -> 'chapters', '[]')) loop
    v_src := (r ->> 'id')::uuid;
    v_id := remapped('chapter', v_src);
    select * into v_chapter from chapters where id = v_id;
    if found and v_chapter.deleted_at is null then
      v_map_ch := v_map_ch || jsonb_build_object(v_src::text, v_id);
      v_counts := jsonb_set(v_counts, '{chapters,matched}', to_jsonb((v_counts #>> '{chapters,matched}')::int + 1));
      if (r ->> 'updated_at')::timestamptz > v_chapter.updated_at and (r ->> 'name') is distinct from v_chapter.name then
        v_counts := jsonb_set(v_counts, '{chapters,renamed}', to_jsonb((v_counts #>> '{chapters,renamed}')::int + 1));
        if not p_dry_run then
          update chapters set name = r ->> 'name' where id = v_id;
        end if;
      end if;
      continue;
    end if;

    select * into v_chapter from chapters where lower(name) = lower(r ->> 'name') and deleted_at is null limit 1;
    if found then
      v_map_ch := v_map_ch || jsonb_build_object(v_src::text, v_chapter.id);
      v_counts := jsonb_set(v_counts, '{chapters,by_name}', to_jsonb((v_counts #>> '{chapters,by_name}')::int + 1));
      continue;
    end if;

    v_counts := jsonb_set(v_counts, '{chapters,new}', to_jsonb((v_counts #>> '{chapters,new}')::int + 1));
    v_new := v_id;
    if not p_dry_run then
      update chapters set deleted_at = null, name = r ->> 'name', description = coalesce(r ->> 'description', ''),
             start_date = (r ->> 'start_date')::date, end_date = (r ->> 'end_date')::date,
             color_token = coalesce(r ->> 'color_token', 'olive')
      where id = v_id and deleted_at is not null returning id into v_new;
      if v_new is null then
        insert into chapters (id, user_id, name, description, start_date, end_date, color_token)
        values (v_id, v_uid, r ->> 'name', coalesce(r ->> 'description', ''), (r ->> 'start_date')::date,
                (r ->> 'end_date')::date, coalesce(r ->> 'color_token', 'olive'))
        on conflict (id) do nothing returning id into v_new;
        if v_new is null then
          v_new := gen_random_uuid();
          insert into chapters (id, user_id, name, description, start_date, end_date, color_token)
          values (v_new, v_uid, r ->> 'name', coalesce(r ->> 'description', ''), (r ->> 'start_date')::date,
                  (r ->> 'end_date')::date, coalesce(r ->> 'color_token', 'olive'));
          perform remember_remap('chapter', v_src, v_new);
        end if;
      end if;
    end if;
    v_map_ch := v_map_ch || jsonb_build_object(v_src::text, v_new);
  end loop;

  return jsonb_build_object(
    'remap', jsonb_build_object('tracks', v_map_tr, 'tags', v_map_tg, 'chapters', v_map_ch),
    'counts', v_counts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Restore: entries (call with batches of about 100)
-- ---------------------------------------------------------------------------

create function restore_batch(p jsonb, p_remap jsonb, p_dry_run boolean default true) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_uid        uuid := auth.uid();
  e            jsonb;
  vr           jsonb;
  v_id         uuid;
  v_src        uuid;
  v_target     uuid;
  v_cur        entries;
  v_new        entries;
  v_found      boolean;
  v_imp_at     timestamptz;
  v_track      uuid;
  v_want       uuid[];
  v_have       uuid[];
  v_union      uuid[];
  v_outcome    text;
  v_write      boolean;
  v_letter     jsonb;
  v_results    jsonb := '[]';
  v_id_map     jsonb := '{}';
  v_versions   int := 0;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not can_write() then
    raise exception 'restore needs an active trial or unlock' using errcode = '42501';
  end if;

  for e in select value from jsonb_array_elements(coalesce(p -> 'entries', '[]')) loop
    v_src := (e ->> 'id')::uuid;
    v_id := remapped('entry', v_src); -- stored here under another id by an earlier restore?
    if v_id <> v_src then
      v_id_map := v_id_map || jsonb_build_object(v_src::text, v_id);
    end if;
    v_imp_at := (e ->> 'updated_at')::timestamptz;
    v_letter := e -> 'letter';

    -- Track: through the id map; a track that doesn't exist here (and isn't about to) becomes "no track".
    v_track := coalesce((p_remap -> 'tracks' ->> (e ->> 'track_id'))::uuid, (e ->> 'track_id')::uuid);
    if v_track is not null and not exists (select 1 from tracks where id = v_track)
       and not (p_dry_run and exists (select 1 from jsonb_each_text(coalesce(p_remap -> 'tracks', '{}')) m where m.value::uuid = v_track)) then
      v_track := null;
    end if;

    -- Tags: through the id map, keeping only tags that exist here (or are about to).
    select coalesce(array_agg(distinct t order by t), '{}') into v_want
    from (
      select coalesce((p_remap -> 'tags' ->> x)::uuid, x::uuid) as t
      from jsonb_array_elements_text(coalesce(e -> 'tag_ids', '[]')) x
    ) s
    where exists (select 1 from tags g where g.id = s.t and g.deleted_at is null)
       or (p_dry_run and exists (select 1 from jsonb_each_text(coalesce(p_remap -> 'tags', '{}')) m where m.value::uuid = s.t));

    -- The row as the file describes it.
    v_new := null;
    v_new.id         := v_id;
    v_new.user_id    := v_uid;
    v_new.entry_date := (e ->> 'entry_date')::date;
    v_new.title      := e ->> 'title';
    v_new.body_rich  := coalesce(e -> 'body_rich', '{}'::jsonb);
    v_new.body_text  := coalesce(e ->> 'body_text', '');
    v_new.language   := coalesce(nullif(e ->> 'language', ''), 'en');
    v_new.word_count := coalesce((e ->> 'word_count')::int, 0);
    v_new.track_id   := v_track;
    v_new.fields     := coalesce(e -> 'fields', '{}'::jsonb);
    v_new.is_letter  := v_letter is not null and jsonb_typeof(v_letter) = 'object';
    v_new.letter_to  := case when v_new.is_letter then v_letter ->> 'to' end;
    v_new.sealed     := case when v_new.is_letter then coalesce((v_letter ->> 'sealed')::boolean, false) else false end;
    v_new.unlock_at  := case when v_new.is_letter then (v_letter ->> 'unlock_at')::timestamptz end;
    if v_new.sealed and v_new.unlock_at is null then
      v_new.sealed := false; -- a seal without a date can't be honoured; keep the text
    end if;
    v_new.created_at := coalesce((e ->> 'created_at')::timestamptz, now());

    if p_dry_run then
      select * into v_cur from entries where id = v_id;
    else
      select * into v_cur from entries where id = v_id for update;
    end if;
    v_found := found;
    v_target := v_id;
    v_write := false;

    if not v_found then
      v_outcome := 'new';
      if not p_dry_run then
        insert into entries (id, user_id, entry_date, title, body_rich, body_text, language, word_count, track_id,
                             fields, is_letter, letter_to, sealed, unlock_at, created_at)
        values (v_id, v_uid, v_new.entry_date, v_new.title, v_new.body_rich, v_new.body_text, v_new.language,
                v_new.word_count, v_new.track_id, v_new.fields, v_new.is_letter, v_new.letter_to, v_new.sealed,
                v_new.unlock_at, v_new.created_at)
        on conflict (id) do nothing
        returning id into v_target;
        if v_target is null then -- id belongs to another account: keep the text under a new id
          v_target := gen_random_uuid();
          insert into entries (id, user_id, entry_date, title, body_rich, body_text, language, word_count, track_id,
                               fields, is_letter, letter_to, sealed, unlock_at, created_at)
          values (v_target, v_uid, v_new.entry_date, v_new.title, v_new.body_rich, v_new.body_text, v_new.language,
                  v_new.word_count, v_new.track_id, v_new.fields, v_new.is_letter, v_new.letter_to, v_new.sealed,
                  v_new.unlock_at, v_new.created_at);
          v_id_map := v_id_map || jsonb_build_object(v_src::text, v_target);
          perform remember_remap('entry', v_src, v_target);
        end if;
        insert into entry_tags (entry_id, tag_id, user_id)
        select v_target, t, v_uid from unnest(v_want) t
        on conflict (entry_id, tag_id) do nothing;
      end if;
    else
      select coalesce(array_agg(tag_id order by tag_id), '{}') into v_have
      from entry_tags where entry_id = v_id and deleted_at is null;
      select coalesce(array_agg(distinct t order by t), '{}') into v_union from unnest(v_have || v_want) t;

      -- The seal is never broken by a restore.
      if v_cur.sealed and v_cur.unlock_at > now() then
        v_new.is_letter := true;
        v_new.sealed    := true;
        v_new.unlock_at := v_cur.unlock_at;
      end if;

      if v_cur.deleted_at is not null then
        if v_imp_at > v_cur.deleted_at then
          v_outcome := 'restored_from_trash';
          v_write := true;
        else
          v_outcome := 'stays_deleted';
        end if;
      elsif (v_new.entry_date, v_new.title, v_new.body_rich, v_new.body_text, v_new.language, v_new.word_count,
             v_new.track_id, v_new.fields, v_new.is_letter, v_new.letter_to, v_new.sealed, v_new.unlock_at)
            is not distinct from
            (v_cur.entry_date, v_cur.title, v_cur.body_rich, v_cur.body_text, v_cur.language, v_cur.word_count,
             v_cur.track_id, v_cur.fields, v_cur.is_letter, v_cur.letter_to, v_cur.sealed, v_cur.unlock_at)
            and v_union = v_have then
        v_outcome := 'unchanged';
      elsif v_imp_at > v_cur.updated_at then
        v_outcome := 'updated';
        v_write := true;
      else
        v_outcome := 'skipped_local_newer';
      end if;

      if v_write and not p_dry_run then
        insert into entry_versions (entry_id, user_id, snapshot, reason)
        values (v_cur.id, v_uid, to_jsonb(v_cur) - 'search', 'restore_overwrite');
        update entries set
          entry_date = v_new.entry_date, title = v_new.title, body_rich = v_new.body_rich, body_text = v_new.body_text,
          language = v_new.language, word_count = v_new.word_count, track_id = v_new.track_id, fields = v_new.fields,
          is_letter = v_new.is_letter, letter_to = v_new.letter_to, sealed = v_new.sealed, unlock_at = v_new.unlock_at,
          deleted_at = null, revision = v_cur.revision + 1
        where id = v_id;
        insert into entry_tags (entry_id, tag_id, user_id)
        select v_id, t, v_uid from unnest(v_union) t
        on conflict (entry_id, tag_id) do update set deleted_at = null where entry_tags.deleted_at is not null;
      end if;
    end if;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'id', v_src, 'stored_as', v_target, 'outcome', v_outcome,
      'title', coalesce(nullif(v_new.title, ''), left(v_new.body_text, 60)), 'entry_date', v_new.entry_date));
  end loop;

  -- Saved versions that travel with these entries (kept by id, so a second restore adds nothing).
  for vr in select value from jsonb_array_elements(coalesce(p -> 'versions', '[]')) loop
    v_target := coalesce((v_id_map ->> (vr ->> 'entry_id'))::uuid, (vr ->> 'entry_id')::uuid);
    if not exists (select 1 from entries where id = v_target)
       and not (p_dry_run and (p -> 'entries') @> jsonb_build_array(jsonb_build_object('id', vr ->> 'entry_id'))) then
      continue;
    end if;
    -- Already here: same id, or (after a remap) the same snapshot from the same moment on the same entry.
    if exists (select 1 from entry_versions where id = (vr ->> 'id')::uuid)
       or exists (select 1 from entry_versions
                  where entry_id = v_target
                    and created_at = (vr ->> 'created_at')::timestamptz
                    and snapshot = vr -> 'snapshot') then
      continue;
    end if;
    v_versions := v_versions + 1;
    if not p_dry_run then
      insert into entry_versions (id, entry_id, user_id, snapshot, reason, created_at)
      values ((vr ->> 'id')::uuid, v_target, v_uid, vr -> 'snapshot',
              case when vr ->> 'reason' in ('restore_overwrite', 'concurrent_edit') then vr ->> 'reason' else 'restore_overwrite' end,
              coalesce((vr ->> 'created_at')::timestamptz, now()))
      on conflict (id) do nothing
      returning id into v_target;
      if v_target is null then -- the version id belongs to another account: keep it under a new id
        insert into entry_versions (entry_id, user_id, snapshot, reason, created_at)
        values (coalesce((v_id_map ->> (vr ->> 'entry_id'))::uuid, (vr ->> 'entry_id')::uuid), v_uid, vr -> 'snapshot',
                case when vr ->> 'reason' in ('restore_overwrite', 'concurrent_edit') then vr ->> 'reason' else 'restore_overwrite' end,
                coalesce((vr ->> 'created_at')::timestamptz, now()));
      end if;
    end if;
  end loop;

  return jsonb_build_object('entries', v_results, 'versions_added', v_versions);
end;
$$;

revoke execute on function remember_remap(text, uuid, uuid) from public, anon;
revoke execute on function remapped(text, uuid) from public, anon;
grant execute on function remember_remap(text, uuid, uuid) to authenticated;
grant execute on function remapped(text, uuid) to authenticated;
revoke execute on function daftar_ts(timestamptz) from public, anon;
revoke execute on function export_journal() from public, anon;
revoke execute on function restore_meta(jsonb, boolean) from public, anon;
revoke execute on function restore_batch(jsonb, jsonb, boolean) from public, anon;
grant execute on function daftar_ts(timestamptz) to authenticated;
grant execute on function export_journal() to authenticated;
grant execute on function restore_meta(jsonb, boolean) to authenticated;
grant execute on function restore_batch(jsonb, jsonb, boolean) to authenticated;
