-- Phase 8: the prompt library.
-- The table and its public-read policy came with 0001. This adds what loading a seed file needs:
--   * one prompt per text (per language), so the loader can be run again without duplicating anything
--   * time_of_day limited to the four values the app filters by
-- Prompts stay global and read-only for clients (no insert/update/delete grant); content is loaded by
-- pasting the generated prompts.sql into the SQL Editor (see supabase/README.md).

create unique index prompts_unique_text on prompts (language, (md5(text)));

alter table prompts
  add constraint prompts_time_of_day_check
  check (time_of_day is null or time_of_day in ('morning', 'afternoon', 'evening', 'night'));

alter table prompts
  add constraint prompts_text_len check (char_length(text) between 1 and 500);
