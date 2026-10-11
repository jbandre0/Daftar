-- Daftar v1 · migration 0007 · photos (phase 6).
-- Paste into Supabase → SQL Editor and run once, then re-run tests/rls.test.sql.
--
-- The 2 GB cap is enforced on the SERVER, from the real size of the stored files (storage.objects metadata),
-- never from numbers the browser reports (Opus review of phase 1). Three layers:
--   1. the storage insert policy refuses a new upload once the account's stored bytes are at the cap;
--   2. register_media() is the ONLY way a media row is created: it reads both files' real sizes, enforces the cap
--      (thumbnails count), the 12-photo limit, the trial rules and ownership, and de-duplicates by sha256;
--   3. clients can no longer insert into media or edit its columns (only soft-delete).
-- Files uploaded but never registered (a failed or refused registration) are "orphans": media_orphans() lists
-- them for the nightly clean-up job (phase 10), which runs with the service role through the Storage API.
--
-- Paths: {user_id}/{entry_id}/{media_id}.webp, and the 400 px thumbnail at {media_id}.thumb.webp.
-- Always use media.storage_path / thumb_path from the row, never rebuild a path from an id: a photo restored
-- from another account is registered under a new id but keeps the name it was uploaded under.

alter table media add column thumb_path  text;
alter table media add column thumb_bytes int not null default 0 check (thumb_bytes >= 0);

-- ---------------------------------------------------------------------------
-- Usage and the cap
-- ---------------------------------------------------------------------------

create function storage_cap_bytes() returns bigint
language sql immutable as $$ select 2147483648::bigint $$;

-- What an account is really storing: every object in its folder, orphans and not-yet-purged photos included.
create function storage_used_bytes_for(p_uid uuid) returns bigint
language sql stable security definer set search_path = public, storage as $$
  select coalesce(sum(coalesce((metadata ->> 'size')::bigint, 0)), 0)::bigint
  from storage.objects
  where bucket_id = 'media' and (storage.foldername(name))[1] = p_uid::text
$$;

create function storage_used_bytes() returns bigint
language sql stable security definer set search_path = public, storage as $$
  select storage_used_bytes_for(auth.uid())
$$;

create function refresh_storage_usage(p_uid uuid) returns void
language sql security definer set search_path = public, storage as $$
  update profiles set storage_bytes_used = storage_used_bytes_for(p_uid) where id = p_uid
$$;

-- Layer 1: no new upload once the account is at its cap.
drop policy media_objects_insert on storage.objects;
create policy media_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select can_write())
    and (select storage_used_bytes()) < (select storage_cap_bytes())
  );

-- ---------------------------------------------------------------------------
-- Layer 2: the only way to create a media row
-- ---------------------------------------------------------------------------

create function register_media(
  p_id uuid, p_entry_id uuid, p_mime text, p_width int, p_height int, p_sha256 text
) returns jsonb
language plpgsql security definer set search_path = public, storage as $$
declare
  v_uid     uuid := auth.uid();
  v_id      uuid := p_id;
  v_path    text;
  v_thumb   text;
  v_bytes   bigint;
  v_tbytes  bigint;
  v_existing uuid;
  v_n       int;
  v_used    bigint;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not can_write() then
    raise exception 'writing is paused on this account' using errcode = '42501';
  end if;
  if p_mime is distinct from 'image/webp' then
    raise exception 'unsupported_type' using errcode = '22023';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'bad_hash' using errcode = '22023';
  end if;

  -- The entry must already be saved (the editor registers photos only after its text has landed).
  perform 1 from entries where id = p_entry_id and user_id = v_uid and deleted_at is null;
  if not found then
    raise exception 'entry_not_found' using errcode = 'P0002';
  end if;

  -- A retry of a registration that already succeeded changes nothing.
  select id into v_existing from media where id = p_id and user_id = v_uid and deleted_at is null;
  if v_existing is not null then
    return jsonb_build_object('id', v_existing, 'duplicate', true, 'remapped', false);
  end if;
  -- The same photo (same bytes) already on this entry: reuse it.
  select id into v_existing from media
  where entry_id = p_entry_id and user_id = v_uid and sha256 = p_sha256 and deleted_at is null limit 1;
  if v_existing is not null then
    return jsonb_build_object('id', v_existing, 'duplicate', true, 'remapped', v_existing <> p_id);
  end if;

  select count(*) into v_n from media where entry_id = p_entry_id and user_id = v_uid and deleted_at is null;
  if v_n >= 12 then
    raise exception 'photo_limit' using errcode = '53400';
  end if;

  -- Both files must really be there; their sizes come from storage, not from the caller.
  v_path  := v_uid::text || '/' || p_entry_id::text || '/' || p_id::text || '.webp';
  v_thumb := v_uid::text || '/' || p_entry_id::text || '/' || p_id::text || '.thumb.webp';
  select coalesce((metadata ->> 'size')::bigint, 0) into v_bytes from storage.objects where bucket_id = 'media' and name = v_path;
  if not found or v_bytes <= 0 then
    raise exception 'upload_missing' using errcode = 'P0002';
  end if;
  select coalesce((metadata ->> 'size')::bigint, 0) into v_tbytes from storage.objects where bucket_id = 'media' and name = v_thumb;
  if not found or v_tbytes <= 0 then
    raise exception 'upload_missing' using errcode = 'P0002';
  end if;

  -- The cap, counted from what is actually stored (these two files included).
  v_used := storage_used_bytes_for(v_uid);
  if v_used > storage_cap_bytes() then
    raise exception 'storage_cap' using errcode = '53400';
  end if;

  -- An id that belongs to another account (a file restored into a different account) gets a new id.
  if exists (select 1 from media where id = p_id) then
    v_id := gen_random_uuid();
  end if;

  insert into media (id, user_id, entry_id, storage_path, thumb_path, mime, bytes, thumb_bytes, width, height, sha256)
  values (v_id, v_uid, p_entry_id, v_path, v_thumb, p_mime, v_bytes, v_tbytes, p_width, p_height, p_sha256);

  update profiles set storage_bytes_used = v_used where id = v_uid;

  return jsonb_build_object('id', v_id, 'bytes', v_bytes, 'thumb_bytes', v_tbytes, 'duplicate', false, 'remapped', v_id <> p_id);
end;
$$;

-- Layer 3: clients can read their media rows and soft-delete them. Nothing else.
revoke insert, update on media from authenticated;
grant update (deleted_at) on media to authenticated;

-- ---------------------------------------------------------------------------
-- Clean-up helpers for the nightly job (service role only; phase 10 schedules them)
-- ---------------------------------------------------------------------------

-- Photos removed from an entry more than 30 days ago: delete their files through the Storage API, then call
-- finalize_media_purge() with these ids.
create function media_purge_candidates() returns table (id uuid, user_id uuid, storage_path text, thumb_path text)
language sql stable security definer set search_path = public as $$
  select m.id, m.user_id, m.storage_path, m.thumb_path from media m where m.deleted_at < now() - interval '30 days'
$$;

create function finalize_media_purge(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public, storage as $$
declare v_uids uuid[]; v_n int;
begin
  select array_agg(distinct user_id) into v_uids from media where id = any (p_ids) and deleted_at is not null;
  delete from media where id = any (p_ids) and deleted_at is not null;
  get diagnostics v_n = row_count;
  perform refresh_storage_usage(u) from unnest(coalesce(v_uids, '{}')) u;
  return v_n;
end;
$$;

-- Files in the bucket that no media row points at, older than a day (an upload whose registration failed).
create function media_orphans() returns table (name text, user_id uuid, bytes bigint)
language sql stable security definer set search_path = public, storage as $$
  select o.name, ((storage.foldername(o.name))[1])::uuid, coalesce((o.metadata ->> 'size')::bigint, 0)
  from storage.objects o
  where o.bucket_id = 'media'
    and coalesce(o.created_at, now() - interval '2 days') < now() - interval '1 day'
    and not exists (select 1 from media m where m.storage_path = o.name or m.thumb_path = o.name)
$$;

-- A photo that is no longer on the page it was added to (the writer deleted it with the keyboard): soft-delete
-- its row a day after it stopped being referenced, so it leaves the cap and the export.
create function soft_delete_unreferenced_media() returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update media m set deleted_at = now()
  from entries e
  where m.entry_id = e.id and m.deleted_at is null
    and m.created_at < now() - interval '1 day'
    and position(m.id::text in e.body_rich::text) = 0;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Export now lists each entry's photos (the browser adds the files to a .zip)
-- ---------------------------------------------------------------------------

create or replace function export_journal() returns jsonb
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
        'media', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', m.id, 'mime', m.mime, 'width', m.width, 'height', m.height, 'bytes', m.bytes, 'sha256', m.sha256,
            'file', 'media/' || left(e.id::text, 8) || '/' || m.id::text || '.webp'
          ) order by m.created_at, m.id)
          from media m where m.entry_id = e.id and m.deleted_at is null
        ), '[]'::jsonb),
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
-- Grants
-- ---------------------------------------------------------------------------

revoke execute on function storage_cap_bytes() from public, anon;
revoke execute on function storage_used_bytes_for(uuid) from public, anon, authenticated;
revoke execute on function storage_used_bytes() from public, anon;
revoke execute on function refresh_storage_usage(uuid) from public, anon, authenticated;
revoke execute on function register_media(uuid, uuid, text, int, int, text) from public, anon;
revoke execute on function media_purge_candidates() from public, anon, authenticated;
revoke execute on function finalize_media_purge(uuid[]) from public, anon, authenticated;
revoke execute on function media_orphans() from public, anon, authenticated;
revoke execute on function soft_delete_unreferenced_media() from public, anon, authenticated;

grant execute on function storage_cap_bytes() to authenticated;
grant execute on function storage_used_bytes() to authenticated;
grant execute on function register_media(uuid, uuid, text, int, int, text) to authenticated;
grant execute on function media_purge_candidates() to service_role;
grant execute on function finalize_media_purge(uuid[]) to service_role;
grant execute on function media_orphans() to service_role;
grant execute on function soft_delete_unreferenced_media() to service_role;
grant execute on function storage_used_bytes_for(uuid) to service_role;
grant execute on function refresh_storage_usage(uuid) to service_role;
