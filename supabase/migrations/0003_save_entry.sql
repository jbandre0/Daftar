-- Daftar v1 · migration 0003 · the one way the editor saves an entry.
-- Paste into Supabase → SQL Editor and run once, then re-run tests/rls.test.sql.
--
-- save_entry() does the whole save in one transaction, under a row lock, with the caller's
-- permissions (security invoker, so RLS and the trial rules still apply):
--   1. Lock the row (or create it, keeping the client-generated id).
--   2. If the server's revision moved past the revision the client started from (another device),
--      copy the server row into entry_versions first. The incoming save then wins. Nothing is lost.
--   3. Store any "displaced" snapshots the client sends (text from another tab that this save replaces).
--   4. Write the new content and bump the revision.
-- Re-sending an identical save is a no-op, so retries after a lost response are safe.

create function save_entry(p_entry jsonb, p_base_revision int, p_displaced jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_id       uuid := (p_entry ->> 'id')::uuid;
  v_cur      entries;
  v_new      entries;
  v_conflict boolean := false;
  v_created  boolean := false;
  v_snap     jsonb;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if v_id is null then
    raise exception 'entry id is required' using errcode = '22023';
  end if;

  select * into v_cur from entries where id = v_id for update;

  if not found then
    -- New entry. ON CONFLICT DO NOTHING covers an id that exists but isn't visible to this user.
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
        -- Visible but not lockable: the update policy refused it (trial and grace are over).
        raise exception 'writing is paused on this account' using errcode = '42501';
      end if;
      raise exception 'this entry id belongs to another account' using errcode = '42501';
    end if;
    v_created := true;
  else
    -- Build the row as it would be after this save (keys absent from p_entry keep their value).
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
       and jsonb_array_length(p_displaced) = 0
    then
      -- Nothing changed (usually a retry whose first response was lost).
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
      -- The update policy refused it: the trial and its grace window are over.
      raise exception 'writing is paused on this account' using errcode = '42501';
    end if;
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

revoke execute on function save_entry(jsonb, int, jsonb) from public, anon;
grant execute on function save_entry(jsonb, int, jsonb) to authenticated;
