-- Daftar v1 · migration 0006 · Browse and Read (phase 5).
-- Paste into Supabase → SQL Editor and run once, then re-run tests/rls.test.sql.
--
-- browse_entries()  One call for the Browse list: filters (track, tags, language, date range) plus search.
--                   Search finds a word you typed, PART of a word (in any script, Arabic included, via ILIKE),
--                   and near-misses (trigram word similarity). It runs as the caller, so RLS applies.
--                   A sealed letter whose date hasn't come is never matched by its text and never shows a snippet.
-- entry_dates()     Every date that has an entry, as one array (no row limit), for Read mode.
--
-- The "simple" text-search config does no stemming, so English and Arabic are treated alike (spec §3).
-- Arabic normalisation (harakat, alef forms) is not done in v1: the spec defers it.

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
  total_count bigint
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
    c.id, c.entry_date, c.title,
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
    c.total
  from counted c
  order by c.score desc, c.entry_date desc, c.created_at desc, c.id
  limit greatest(1, least(coalesce(p_limit, 40), 100)) offset greatest(0, coalesce(p_offset, 0));
end;
$$;

create function entry_dates() returns date[]
language sql stable security invoker set search_path = public as $$
  select coalesce(array_agg(d order by d), '{}'::date[])
  from (select distinct entry_date as d from entries where deleted_at is null) s
$$;

revoke execute on function browse_entries(text, uuid, uuid[], text, date, date, int, int) from public, anon;
revoke execute on function entry_dates() from public, anon;
grant execute on function browse_entries(text, uuid, uuid[], text, date, date, int, int) to authenticated;
grant execute on function entry_dates() to authenticated;
