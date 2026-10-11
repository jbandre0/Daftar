-- Daftar v1 · migration 0004 · tracks, tags, chapters, templates (phase 3).
-- Paste into Supabase → SQL Editor and run once, then re-run tests/rls.test.sql.
--
-- 1. The Spiritual template (a global, read-only template) and the link from every Spiritual track to it,
--    for existing accounts and, via handle_new_user(), for new ones.
-- 2. save_entry() now also carries an entry's tags (tag_ids), so tag changes are buffered offline with the
--    text and can never block a text save: unknown or foreign tag ids are skipped, and a refused tag link
--    (trial grace window) is skipped rather than failing the save.

-- ---------------------------------------------------------------------------
-- 1. Spiritual template
-- ---------------------------------------------------------------------------

insert into templates (id, user_id, name, body_rich, is_builtin) values (
  '00000000-0000-4000-8000-0000000000e1', null, 'Spiritual',
  '{"type":"doc","content":[
     {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"What I noticed"}]},
     {"type":"paragraph"},
     {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Impressions"}]},
     {"type":"paragraph"}
   ]}'::jsonb,
  true
) on conflict (id) do nothing;

update tracks set default_template_id = '00000000-0000-4000-8000-0000000000e1'
where is_builtin and slug = 'spiritual' and default_template_id is null;

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id) values (new.id);
  insert into licenses (user_id) values (new.id);
  insert into tracks (user_id, name, slug, color_token, sort_order, is_builtin, default_template_id) values
    (new.id, 'Daily',     'daily',     'flame',    1, true, null),
    (new.id, 'Spiritual', 'spiritual', 'olive',    2, true, '00000000-0000-4000-8000-0000000000e1'),
    (new.id, 'Letters',   'letters',   'seal',     3, true, null),
    (new.id, 'Dreams',    'dreams',    'ash-soft', 4, true, null);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. save_entry with tags
-- ---------------------------------------------------------------------------

create or replace function save_entry(p_entry jsonb, p_base_revision int, p_displaced jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_id        uuid := (p_entry ->> 'id')::uuid;
  v_cur       entries;
  v_new       entries;
  v_conflict  boolean := false;
  v_created   boolean := false;
  v_snap      jsonb;
  v_has_tags  boolean := p_entry ? 'tag_ids';
  v_want      uuid[] := '{}';
  v_have      uuid[] := '{}';
  v_tags_diff boolean := false;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_id is null then
    raise exception 'entry id is required' using errcode = '22023';
  end if;

  -- Wanted tags: only ids that exist and belong to the caller (anything else is skipped, never an error).
  if v_has_tags then
    select coalesce(array_agg(t.id), '{}') into v_want
    from tags t
    where t.user_id = v_uid and t.deleted_at is null
      and t.id in (select (jsonb_array_elements_text(p_entry -> 'tag_ids'))::uuid);
  end if;

  select * into v_cur from entries where id = v_id for update;

  if found and v_has_tags then
    select coalesce(array_agg(tag_id), '{}') into v_have
    from entry_tags where entry_id = v_id and deleted_at is null;
    v_tags_diff := (select array_agg(x order by x) from unnest(v_want) x)
                   is distinct from (select array_agg(x order by x) from unnest(v_have) x);
    -- array_agg of nothing is null on both sides: treat as equal
    if coalesce(cardinality(v_want), 0) = 0 and coalesce(cardinality(v_have), 0) = 0 then
      v_tags_diff := false;
    end if;
  end if;

  if not found then
    insert into entries (
      id, user_id, entry_date, title, body_rich, body_text, language, word_count,
      track_id, fields, is_letter, letter_to, sealed, unlock_at
    ) values (
      v_id, v_uid,
      coalesce((p_entry ->> 'entry_date')::date, current_date),
      p_entry ->> 'title',
      coalesce(p_entry -> 'body_rich', '{}'::jsonb),
      coalesce(p_entry ->> 'body_text', ''),
      coalesce(p_entry ->> 'language', 'en'),
      coalesce((p_entry ->> 'word_count')::int, 0),
      (p_entry ->> 'track_id')::uuid,
      coalesce(p_entry -> 'fields', '{}'::jsonb),
      coalesce((p_entry ->> 'is_letter')::boolean, false),
      p_entry ->> 'letter_to',
      coalesce((p_entry ->> 'sealed')::boolean, false),
      (p_entry ->> 'unlock_at')::timestamptz
    )
    on conflict (id) do nothing
    returning * into v_new;

    if v_new.id is null then
      if exists (select 1 from entries where id = v_id) then
        raise exception 'writing is paused on this account' using errcode = '42501';
      end if;
      raise exception 'this entry id belongs to another account' using errcode = '42501';
    end if;
    v_created := true;
  else
    v_new := v_cur;
    if p_entry ? 'entry_date' then v_new.entry_date := (p_entry ->> 'entry_date')::date; end if;
    if p_entry ? 'title'      then v_new.title      := p_entry ->> 'title'; end if;
    if p_entry ? 'body_rich'  then v_new.body_rich  := p_entry -> 'body_rich'; end if;
    if p_entry ? 'body_text'  then v_new.body_text  := p_entry ->> 'body_text'; end if;
    if p_entry ? 'language'   then v_new.language   := p_entry ->> 'language'; end if;
    if p_entry ? 'word_count' then v_new.word_count := (p_entry ->> 'word_count')::int; end if;
    if p_entry ? 'track_id'   then v_new.track_id   := (p_entry ->> 'track_id')::uuid; end if;
    if p_entry ? 'fields'     then v_new.fields     := p_entry -> 'fields'; end if;
    if p_entry ? 'is_letter'  then v_new.is_letter  := (p_entry ->> 'is_letter')::boolean; end if;
    if p_entry ? 'letter_to'  then v_new.letter_to  := p_entry ->> 'letter_to'; end if;
    if p_entry ? 'sealed'     then v_new.sealed     := (p_entry ->> 'sealed')::boolean; end if;
    if p_entry ? 'unlock_at'  then v_new.unlock_at  := (p_entry ->> 'unlock_at')::timestamptz; end if;

    if (v_new.entry_date, v_new.title, v_new.body_rich, v_new.body_text, v_new.language, v_new.word_count,
        v_new.track_id, v_new.fields, v_new.is_letter, v_new.letter_to, v_new.sealed, v_new.unlock_at)
       is not distinct from
       (v_cur.entry_date, v_cur.title, v_cur.body_rich, v_cur.body_text, v_cur.language, v_cur.word_count,
        v_cur.track_id, v_cur.fields, v_cur.is_letter, v_cur.letter_to, v_cur.sealed, v_cur.unlock_at)
       and not v_tags_diff
       and jsonb_array_length(p_displaced) = 0
    then
      return jsonb_build_object('id', v_cur.id, 'revision', v_cur.revision, 'updated_at', v_cur.updated_at,
                                'conflict', false, 'created', false);
    end if;

    if v_cur.revision <> p_base_revision then
      insert into entry_versions (entry_id, user_id, snapshot, reason)
      values (v_cur.id, v_cur.user_id, to_jsonb(v_cur) - 'search', 'concurrent_edit');
      v_conflict := true;
    end if;

    update entries set
      entry_date = v_new.entry_date, title = v_new.title, body_rich = v_new.body_rich,
      body_text = v_new.body_text, language = v_new.language, word_count = v_new.word_count,
      track_id = v_new.track_id, fields = v_new.fields, is_letter = v_new.is_letter,
      letter_to = v_new.letter_to, sealed = v_new.sealed, unlock_at = v_new.unlock_at,
      revision = v_cur.revision + 1
    where id = v_cur.id
    returning * into v_new;

    if v_new.id is null then
      raise exception 'writing is paused on this account' using errcode = '42501';
    end if;
  end if;

  -- Tags: link wanted, unlink the rest. A refused link (grace window) must never fail the text save.
  if v_has_tags then
    begin
      insert into entry_tags (entry_id, tag_id, user_id)
      select v_new.id, t, v_uid from unnest(v_want) t
      on conflict (entry_id, tag_id) do update set deleted_at = null where entry_tags.deleted_at is not null;
    exception when insufficient_privilege then
      null;
    end;
    update entry_tags set deleted_at = now()
    where entry_id = v_new.id and deleted_at is null and not (tag_id = any (v_want));
  end if;

  for v_snap in select value from jsonb_array_elements(p_displaced) loop
    insert into entry_versions (entry_id, user_id, snapshot, reason)
    values (v_new.id, v_uid, v_snap, 'concurrent_edit');
    v_conflict := true;
  end loop;

  return jsonb_build_object('id', v_new.id, 'revision', v_new.revision, 'updated_at', v_new.updated_at,
                            'conflict', v_conflict, 'created', v_created);
end;
$$;
