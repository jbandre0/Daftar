-- Phase 8b: favorites.
-- A favorite is `entries.fields.favorite = true`. It rides through save_entry(), export_journal() and restore
-- exactly like every other field (so it exports as readable JSON and survives a restore) and needs no new column.
-- This migration only teaches browse_entries to filter by it (p_favorites) and to say which rows are starred.
-- Sealed letters stay masked (no title, no snippet); their star shows, and nothing else about them does.

drop function browse_entries(text, uuid, uuid[], text, date, date, int, int);

create function browse_entries(
  p_q        text    default null,
  p_track    uuid    default null,
  p_tags     uuid[]  default null,
  p_language text    default null,
  p_from     date    default null,
  p_to       date    default null,
  p_limit    int     default 40,
  p_offset   int     default 0,
  p_favorites boolean default false
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
  sealed_until timestamptz,
  favorite     boolean
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
      and (not coalesce(p_favorites, false) or e.fields @> '{"favorite": true}'::jsonb)
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
    case when c.hidden then c.unlock_at end,
    (c.fields @> '{"favorite": true}'::jsonb)
  from counted c
  order by c.score desc, c.entry_date desc, c.created_at desc, c.id
  limit greatest(1, least(coalesce(p_limit, 40), 100)) offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke execute on function browse_entries(text, uuid, uuid[], text, date, date, int, int, boolean) from public, anon;
grant execute on function browse_entries(text, uuid, uuid[], text, date, date, int, int, boolean) to authenticated;
