-- Phase 8: the prompt library.
-- The table and its public-read policy came with 0001. This adds what loading a seed file needs:
--   * one prompt per text (per language), so the loader can be run again without duplicating anything
--   * time_of_day limited to the four values the app filters by
-- Prompts stay global and read-only for clients (no insert/update/delete grant); content is loaded by
-- pasting the generated prompts.sql into the SQL Editor (see supabase/README.md).

-- Tidy any rows that already exist so the new rules can't fail on them (this migration is safe on a table that has data):
--   * time_of_day: "Morning " -> morning; anything that isn't one of the four ("any", "anytime", "dawn", ...) -> null, meaning "fits any time"
--   * the same words stored twice: the oldest copy stays
update prompts set time_of_day = nullif(lower(btrim(time_of_day)), '') where time_of_day is not null;
update prompts set time_of_day = null where time_of_day is not null and time_of_day not in ('morning', 'afternoon', 'evening', 'night');
delete from prompts p using prompts q
 where p.language = q.language and md5(p.text) = md5(q.text)
   and (p.created_at, p.id) > (q.created_at, q.id);

create unique index prompts_unique_text on prompts (language, (md5(text)));

alter table prompts
  add constraint prompts_time_of_day_check
  check (time_of_day is null or time_of_day in ('morning', 'afternoon', 'evening', 'night'));

alter table prompts
  add constraint prompts_text_len check (char_length(text) between 1 and 500);
