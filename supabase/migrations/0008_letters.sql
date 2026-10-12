-- Daftar v1 · migration 0008 · Letters (phase 7).
-- Paste into Supabase → SQL Editor and run once, then re-run tests/rls.test.sql.
--
-- "Sealed means hidden until the date, not encrypted" (spec). The seal is a promise the app keeps, and this migration
-- makes the server keep it too, in four places:
--   1. guard_sealed_letter(): once a letter is sealed and its date hasn't come, its content cannot be changed (so a
--      second tab or device that still shows the old draft can't overwrite it), and a letter can only be sealed
--      for a future date. A restore may import text but still never breaks a seal (restore_batch tells the guard).
--   2. browse_entries(): a sealed letter shows no title either, and says who it is for and when it opens.
--   3. list_letters(): the Letters screen's list, with sealed letters masked the same way.
--   4. nothing here lets anyone OPEN a letter early: there is no early-open. (Export still contains everything:
--      the file belongs to the user, and the spec says so plainly.)

-- ---------------------------------------------------------------------------
-- 1. The seal guard
-- ---------------------------------------------------------------------------

create function guard_sealed_letter() returns trigger
language plpgsql set search_path = public as $$
declare
  v_restoring boolean := coalesce(current_setting('daftar.restoring', true), '') = 'on';
begin
  if v_restoring then
    return new;
  end if;

  -- sealing: only for a date that hasn't come yet
  if new.sealed and not old.sealed and (new.unlock_at is null or new.unlock_at <= now()) then
    raise exception 'seal_needs_future_date' using errcode = '55000';
  end if;

  -- while sealed, the letter's content is frozen (moving it to the trash and back is still allowed)
  if old.sealed and old.unlock_at > now() and (
       new.entry_date  is distinct from old.entry_date  or new.title      is distinct from old.title
    or new.body_rich   is distinct from old.body_rich   or new.body_text  is distinct from old.body_text
    or new.language    is distinct from old.language    or new.word_count is distinct from old.word_count
    or new.track_id    is distinct from old.track_id    or new.fields     is distinct from old.fields
    or new.is_letter   is distinct from old.is_letter   or new.letter_to  is distinct from old.letter_to
    or new.sealed      is distinct from old.sealed      or new.unlock_at  is distinct from old.unlock_at
  ) then
    raise exception 'letter_is_sealed' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger entries_guard_seal before update on entries
  for each row execute function guard_sealed_letter();

-- restore_batch again, now setting the restore flag (otherwise identical to migration 0005)
create or replace function restore_batch(p jsonb, p_remap jsonb, p_dry_run boolean default true) returns jsonb
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

  -- the seal guard (below) lets a restore import text, but never lets it break a seal (that rule is in this function)
  perform set_config('daftar.restoring', 'on', true);

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

  -- the restore is over: the seal guard is back on, even for the rest of this transaction
  perform set_config('daftar.restoring', 'off', true);
  return jsonb_build_object('entries', v_results, 'versions_added', v_versions);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. browse_entries: sealed letters show no title, and who/when instead
-- ---------------------------------------------------------------------------

drop function browse_entries(text, uuid, uuid[], text, date, date, int, int);

create function browse_entries(
  p_q        text    default null,
  p_track    uuid    default null,
  p_tags     uuid[]  default null,
  p_language text    default null,
  p_from     date    default null,
  p_to       date    default null,
  p_limit    int     default 40,
  p_offset   int     default 0
) returns table (
  id          uuid,
  entry_date  date,
  title       text,
  snippet     text,
  word_count  int,
  updated_at  timestamptz,
  track_id    uuid,
  language    text,
  tag_ids     uuid[],
  total_count bigint,
  letter_to   text,
  sealed_until timestamptz
)
language plpgsql stable security invoker set search_path = public, extensions as $$
#variable_conflict use_column
declare
  v_q    text := nullif(btrim(coalesce(p_q, '')), '');
  v_like text;
  v_ts   tsquery;
  -- Typo tolerance only for a single word of 5+ letters: shorter or multi-word queries match too loosely
  v_fuzzy boolean := v_q is not null and v_q !~ '\s' and char_length(v_q) >= 5;
begin
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_ts := plainto_tsquery('simple', v_q);
  end if;

  return query
  with hit as (
    select
      e.*,
      (e.sealed and e.unlock_at > now()) as hidden,
      case when v_q is null then 0 else
        (case when e.title ilike v_like then 4 else 0 end)
        + (case when e.body_text ilike v_like then 2 else 0 end)
        + (case when e.search @@ v_ts then 1 else 0 end)
        + ts_rank(e.search, v_ts)
      end as score
    from entries e
    where e.deleted_at is null
      and (p_track is null or e.track_id = p_track)
      and (p_language is null or e.language = p_language)
      and (p_from is null or e.entry_date >= p_from)
      and (p_to is null or e.entry_date <= p_to)
      and (p_tags is null or cardinality(p_tags) = 0 or (
            select count(distinct et.tag_id) from entry_tags et
            where et.entry_id = e.id and et.deleted_at is null and et.tag_id = any (p_tags)
          ) = cardinality(p_tags))
      and (v_q is null or (
            not (e.sealed and e.unlock_at > now())
            and (
              e.search @@ v_ts
              or e.title ilike v_like
              or e.body_text ilike v_like
              or (v_fuzzy and word_similarity(v_q, coalesce(e.title, '') || ' ' || e.body_text) >= 0.5)
            )
          ))
  ),
  counted as (
    select h.*, count(*) over () as total from hit h
  )
  select
    c.id, c.entry_date, case when c.hidden then null else c.title end,
    case
      when c.hidden then null
      when v_q is not null and strpos(lower(c.body_text), lower(v_q)) > 0 then
        regexp_replace(substr(c.body_text, greatest(1, strpos(lower(c.body_text), lower(v_q)) - 50), 160), '\s+', ' ', 'g')
      else regexp_replace(left(c.body_text, 160), '\s+', ' ', 'g')
    end,
    c.word_count, c.updated_at, c.track_id, c.language,
    coalesce((
      select array_agg(et.tag_id order by et.tag_id)
      from entry_tags et join tags g on g.id = et.tag_id and g.deleted_at is null
      where et.entry_id = c.id and et.deleted_at is null
    ), '{}'::uuid[]),
    c.total,
    case when c.hidden then c.letter_to end,
    case when c.hidden then c.unlock_at end
  from counted c
  order by c.score desc, c.entry_date desc, c.created_at desc, c.id
  limit greatest(1, least(coalesce(p_limit, 40), 100)) offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke execute on function browse_entries(text, uuid, uuid[], text, date, date, int, int) from public, anon;
grant execute on function browse_entries(text, uuid, uuid[], text, date, date, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The Letters screen
-- ---------------------------------------------------------------------------

create function list_letters() returns table (
  id           uuid,
  entry_date   date,
  title        text,
  snippet      text,
  word_count   int,
  updated_at   timestamptz,
  letter_to    text,
  sealed       boolean,
  unlock_at    timestamptz,
  is_sealed_now boolean
)
language sql stable security invoker set search_path = public as $$
  select
    e.id, e.entry_date,
    case when e.sealed and e.unlock_at > now() then null else e.title end,
    case when e.sealed and e.unlock_at > now() then null
         else regexp_replace(left(e.body_text, 160), '\s+', ' ', 'g') end,
    e.word_count, e.updated_at, e.letter_to, e.sealed, e.unlock_at,
    (e.sealed and e.unlock_at > now())
  from entries e
  where e.deleted_at is null and (e.is_letter or e.sealed)
  order by (e.sealed and e.unlock_at > now()) desc,
           case when e.sealed and e.unlock_at > now() then e.unlock_at end asc,
           e.updated_at desc
$$;

revoke execute on function list_letters() from public, anon;
grant execute on function list_letters() to authenticated;
