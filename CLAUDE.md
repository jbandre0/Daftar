# Daftar

"The journal you actually own." Lamplit journaling PWA; every word exports as readable JSON. Full spec: `Daftar — v1 Build Spec & Style Guide.pdf` (text extract of the same lives in the session history; re-extract with PDFKit if needed).

## Rules
- Build ONE phase at a time (spec section 10). Stop after each phase, report against "done when", flag any model switch needed for the next phase, and commit.
- Model plan: phases 2 and 4 on Opus; Opus review of RLS (end of phase 1) and webhook (end of phase 9); everything else Sonnet.
- Decision log (spec p.1) overrides the original brief: $49 one-time, 2 GB photo cap, burn mode v2, flat chapters, English-only prompts, minimal RTL layer, phone and desktop equal, local IndexedDB buffer in v1, CSS-only Lamplight.

## Stack
App lives in `app/`: Vite + React + TypeScript, vite-plugin-pwa, react-router, Phosphor Light icons (20px, never mix sets), plain CSS with custom properties. Later: Tiptap, idb-keyval, Supabase, browser-image-compression.

## Conventions
- All colours/spacing/radii come from `app/src/styles/tokens.css`. No raw hex in components. No #FFF/#000.
- CSS logical properties only (margin-inline-start, inset-inline, text-align: start). No left/right in layout.
- UI stays LTR; content direction is `dir="auto"` per paragraph/input.
- Design language ("Heritage lamplight", set by the user from reference images): dark chocolate desk + amber (Lamplight), parchment everywhere (Daylight); the Write/Read screens always sit on the parchment image behind a frosted-glass panel. Rounded cards (24px) and panel (28px). **Buttons and pills are lozenges (pointed ends), the Write action and current-page marker are diamonds** (shape drawn on `::before` with `clip-path` so focus rings still work; use `.btn`, `.btn-primary`, `.btn-tint`, `.btn-quiet`, `.pill`). Icons: Phosphor Light 20px.
- Type: Windsong (`--font-script`) for display moments only (screen titles, entry date); Newsreader (`--font-serif`) for book text; Figtree (`--font-ui`); Noto Naskh / IBM Plex Sans Arabic for Arabic. Windsong has no Arabic, and is hairline-thin: never use it for long body text by default (Settings has an opt-in "Handwriting" style, `html[data-write=hand]`).
- Text that sits directly on the parchment (no card) must use the strong ink in Daylight (see the rule at the end of components.css).
- The writing glass (`--glass`, Write/Read pages) is deliberately clear (58% Lamplight / 45% Daylight, 3px blur) so the parchment's texture shows under the words; cards keep the heavier frost. Lamplight's other screens show the parchment at 16% through the dark desk (no edge veil there). All three are covered by `scripts/contrast.mjs`.
- No emoji, toasts for save status, or looping animation. Transitions under 200 ms; honour prefers-reduced-motion.
- Copy follows the spec voice table (p.20-21).
- Run `node app/scripts/contrast.mjs` after touching colour tokens, glass opacity or the parchment (must report 0 FAIL). It composites the glass over the real parchment pixels (darkest 1%).
- Rebuild parchment assets with `node app/scripts/parchment.mjs <source image>` (source: public-domain "parchment paper background", publicdomainpictures.net image 802240, supplied by the user).

## Deviations from spec
- **Design pass (user decision, overrides spec §8):** parchment photo background on writing screens (spec said no photographs), frosted glass panel (spec: no glassmorphism), rounded corners on paper (spec: crisp), lozenge/diamond buttons (spec: 8px radius / pills), Windsong + Newsreader + Figtree (spec: Literata + Source Sans 3). Tokens in the spec's table were replaced; WCAG AA still holds.
- Daylight tokens darkened to pass AA: --flame #8F5311 (spec #A8641C), --ash-soft #6A5D4B (spec #786A57), --olive #56613A (spec #5E6A40). Added --on-flame (button text) because ink-on-flame fails AA in Daylight.
- Spec gaps to resolve in phase 1: `can_edit()` is referenced but never defined (trial + 48h grace, or unlocked).

## Commands
`cd app && npm run dev | build | typecheck | test | db:test`
- `npm test`: sync-engine suite (vitest + fake-indexeddb): offline, tab kill, rescue, two tabs, other devices.
- `npm run db:test`: migrations + `supabase/tests/rls.test.sql` on PGlite.
- **Preview mode (dev only):** run `npm run dev`, open `http://localhost:5173/?preview=1`. The whole real app runs on sample data with a fixed signed-in user, no Supabase login needed. The server is simulated in localStorage with save_entry()'s rules; the badge top-right has an Offline switch and Reset. Leave with `/?preview=0`. Hooks live in `app/src/lib/preview.ts`; the backend in `app/src/dev/previewBackend.tsx`, loaded only behind `import.meta.env.DEV` (verified absent from production bundles). Restore and settings writes are not simulated (they need the real server). Use this for visual checks; use the real login for anything touching Supabase.

## Autosave architecture (phase 2): read `app/src/lib/sync.ts` header before touching saves
- IndexedDB draft (shared by tabs) is the source of truth for unconfirmed text; saves always send the draft, never tab memory.
- Draft write: 500 ms debounce, 1 s max during non-stop typing. Server: 2 s idle, 5 s max. Flush on blur/hidden/pagehide/route change.
- pagehide/hidden also writes a synchronous localStorage "rescue" copy.
- Web Lock per entry serialises saves across tabs; BroadcastChannel shows other tabs' text live.
- A tab whose text isn't derived from the latest draft "displaces" it: the replaced text is sent and kept in entry_versions.
- Clean drafts stay as a record of the confirmed revision; pruned after 7 days.
- Never call `editor.setEditable(x)` without `emitUpdate=false`: it fires an update that looks like typing.

## Carry-forward from the Phase 1 Opus RLS review
- (Done in phase 2: `save_entry()` is the single atomic save. It is security invoker, so the client keeps its insert grant on entry_versions; harmless, own rows only.)
- (Done in phase 6: the 2 GB cap is counted from storage.objects sizes server-side; see Photos below.)
- (Done in phase 7: a server-side guard now freezes a sealed letter; see Letters below.)
- Phase 10: deleting auth.users cascades rows but NOT storage objects; the delete-account function must remove them. Also schedule the nightly photo job (see Photos).
- Supabase setting: keep anonymous sign-ins OFF (anonymous users get role authenticated and would get a trial).
- New tables/functions are closed by default (0002); every migration must grant explicitly.

## Organisation (phase 3)
- Tracks/tags/chapters/templates load into `OrganizeProvider` (`app/src/organize.tsx`), cached in localStorage so the editor works offline. Their create/rename/hide writes are online-only direct table calls (RLS enforces the trial).
- An entry's `track_id`, `fields`, and `tag_ids` ride through `save_entry()` with the text, so they are buffered offline like text. Unknown/foreign tag ids are skipped server-side and a refused tag link never fails a text save.
- Chapters are never joined to entries: membership is `entry_date` inside [start_date, end_date] (null end = ongoing), computed at query time (`inChapter`, `entriesInRange`).
- Template flow: switching track on a page that is blank or still equals the old template swaps in the new track's template; written text is never replaced. Spiritual field definitions (scripture, answered_later, answered_on) are hardcoded by track slug in `EntryMeta.tsx`.
- When a control is bound to session state (not editor state), `EntrySession.change()` emits for any non-body patch (`metaVersion`). Without that, controlled inputs snap back to stale values.

## Vault (phase 4): read the header of `supabase/migrations/0005_vault.sql` before touching restore
- Export = `export_journal()` (one SQL snapshot, deterministic order, UTC microsecond timestamps) wrapped in `app/src/lib/vault.ts` with readme/header, plus unsynced local drafts marked `"unsynced": true`.
- Restore = `restore_meta` then `restore_batch` (100 entries per call), both with `p_dry_run`. The preview and the merge run the same SQL, so the preview is exact. The server applies every spec §5 rule; the client only batches and reports.
- `restore_remaps` remembers ids that had to change (another account owns them) so re-restoring never duplicates. Report "remapped" = new entries stored under a new id.
- Deviation: "unchanged" compares the whole entry (incl. body_rich, track, language) after the tag union, not just the spec's hash fields. More things count as changed, but changes never destroy text (versions kept).
- Tests: `src/lib/vault.db.test.ts` runs the real migrations on PGlite: round trip, restore twice, every conflict rule. 11 SQL mutations of the rules were each caught.
- Not yet: pruning entry_versions older than 90 days (needs a scheduled job, phase 10); .zip with media (phase 6).

## Browse and Read (phase 5)
- `browse_entries()` (migration 0006) is the one call for the Browse list: filters + search. Partial words in ANY script (Arabic included) come from `ILIKE`, which needs no trigram support; typo tolerance is trigram `word_similarity` >= 0.5 and only for a single word of 5+ letters (shorter/multi-word queries are exact, otherwise "seed" matches "see"). **Known limit:** Arabic words are short, so a one-letter Arabic typo scores about 0.43 and is NOT caught in v1. Arabic normalisation is deferred by the spec.
- `%`, `_` and `\` are escaped: they are plain characters in a search.
- A sealed letter whose date hasn't come is never matched by title or text and gets `snippet = null`. **Phase 7 must keep this**: Read's `fetchDay` already blanks its body; the Letters screen owns the sealed card.
- `lib/browse.ts` folds this device's unsynced drafts into results (and is the offline fallback) using `matchesFilters`, a client mirror of the server rules. Keep the two in step.
- Browse state lives in the URL (`q, track, tags, lang, from, to, chapter, view, month, day`), so Back from an entry lands where you were. The calendar shows everything: when a search or filter is active the view is the list.
- Read (`/read?date=`): `lib/readModel.ts` builds spreads from `entry_dates()`: one per day with entries, and each run of empty days collapses into ONE "N quiet days" spread (never counts, never guilt). ← earlier, → later; swipe left = later; jump-to-date lands on the day or the quiet run around it.
- **Page turn (built, Opus): read the header of `app/src/components/PageStage.tsx` and `app/src/lib/pageTurn.ts` first.** A rigid sheet hinged at the spine, drawn per frame from one angle θ by `createEngine().frame(θ)`: perspective rotateY, Lambert light from the desk lamp (top-left), spine shadow, edge glint, a paper back face with mirrored show-through past 90°, a moving cast shadow and dim on the page beneath. Jumps riffle 2-6 blank pages (`riffleCount`). Drag: touch anywhere / mouse from the outer 64px edge; commit past 72° (or 108° back) or on a flick (>0.45 px/ms).
  - **Glass rule:** never animate opacity/filter/mask/clip-path on an ANCESTOR of a `.page` (it becomes a backdrop root and the frosted blur breaks). The page beneath is clipped itself (its own clip-path), exactly to what the sheet has uncovered, so two glass panels never stack (no smudges, no brightening). Paper-only elements (back face, riffled blanks, shadows) may use opacity.
  - Layers are keyed by spread so React never remounts the page that stays; turns finish instantly if a new one starts; hidden tab = no animation; a safety timeout always lands a turn.
  - Read prefetches the days around the current one (`ensure`), so pages never turn onto "loading" and dragged pages already have writing.
  - Dev tools: `?slowmo=8` slows every turn; `?turnfreeze=60` holds an automatic turn at 60°; `window.__daftarTurn.frame(θ)` draws any angle (dev only, compiled out of production).
  - Not measurable here: compositor cost on a real phone (main-thread cost per frame is ~0.1 ms). If a phone stutters, the first suspect is the per-frame clip-path on the glass page beneath.
- Dev note: another chat's server may hold port 5173; `daftar-preview` in `.claude/launch.json` runs the preview on 5199.

## Photos (phase 6): read `supabase/migrations/0007_photos.sql` and `app/src/lib/photos.ts` first
- **Pipeline (browser):** `processImage` decodes with the EXIF orientation applied, redraws through a canvas (this drops ALL EXIF/GPS: nothing is copied across), fits 1600 px long edge, WebP 0.8, 400 px thumbnail, SHA-256 of the result. Safari can't encode WebP from a canvas (it returns a PNG), so `encodeWebp` falls back to `@jsquash/webp` (WebAssembly, loaded only then; both wasm files are precached). We use plain canvas, not `browser-image-compression` (the spec's pick): same result with full control. The canvas may add an ICC colour profile chunk (just colour; kept); EXIF/XMP never survive (`webpPersonalMetadata`).
- **Measured in a real browser:** a 15.1 MB, 4032x3024 phone photo with Orientation 6 and a GPS block became 98 KB, upright, no EXIF/XMP, on both the native and the wasm encoder.
- **The cap is server-side (Opus review item).** Usage = the sum of real sizes in `storage.objects` for the account (`storage_used_bytes()`), orphans and not-yet-purged photos included, thumbnails included. Layers: the storage insert policy refuses uploads at the cap; `register_media()` is the ONLY way a media row is created (clients can no longer insert/update media except `deleted_at`): it reads both files' real sizes, enforces cap + 12-per-entry + trial rules + ownership, dedupes by sha256, remaps an id owned by another account. Never trust `bytes` from a client.
- **Always use `media.storage_path` / `thumb_path` from the row**, never rebuild a path from an id (a remapped photo keeps the name it was uploaded under). Paths: `{user}/{entry}/{media}.webp` and `.thumb.webp`.
- **Upload queue (`photoQueue.ts`):** a photo is written to IndexedDB BEFORE the editor is told it exists; the device copy is deleted only after `register_media` confirms. Offline, or before the entry's text is on the server, it retries with backoff (and immediately when an entry save lands: `Write.tsx`). Refusals (`cap`, `paused`) block that photo without retry storms and never touch text; the 13th photo is rejected for good. `PhotoBackend` is an interface so tests use fakes, and preview mode simulates storage.
- **Editor:** `photo` node `{mediaId,width,height}` (atom, block). Each photo is inserted followed by an empty paragraph (a lone selected atom would be replaced by the next one). Paste, drop and the toolbar button; remove = soft-delete the row. Read renders photos via `RichText` (`entryId` prop) and `usePhoto`.
- **.zip:** `vaultZip.ts`. Export verifies each photo's checksum as it is collected (a bad download fails the whole export), includes photos still waiting on the device (`unsynced`), streams with fflate (photos stored, not deflated). Restore opens .json or .zip, `planPhotos` is pure (skips entries the merge left alone, skips same-sha photos, applies the 2 GB cap and 12/entry, reports photos a text-only file can't supply), then `applyPhotoPlan` checks sha + makes a thumbnail and enqueues; `SyncBoot` repoints a page (`swapMediaId`) when a photo registers under a different id. Limit: the whole .zip is read into memory (about 1 GB is the practical ceiling in a browser).
- **Nightly job (NOT built; phase 10 schedules it with the service role):** `media_purge_candidates()` -> delete those files through the Storage API (direct deletes from storage tables are blocked) -> `finalize_media_purge(ids)`; `media_orphans()` -> delete files with no media row older than a day; `soft_delete_unreferenced_media()` -> photos deleted from the page with the keyboard.
- **Unverified against real Supabase:** that Storage records `metadata.size` by the time we register (the app retries `upload_missing`, so a short delay is fine). First real upload will confirm it. Also unmeasured: phone GPU cost, iPhone Safari (wasm path tested in Chrome only).
- Dev: `node app/scripts/make-test-photo.mjs <image>` makes the 15 MB GPS/orientation test photo in `public/__fixtures__/` (delete before shipping). `/?preview=1&used=2147450000` simulates a nearly full account.

## Letters (phase 7): read `supabase/migrations/0008_letters.sql` and `app/src/lib/seal.ts` first
- **"Sealed means hidden until the date, not encrypted."** The app keeps the promise everywhere; export still holds everything (the file belongs to the user). There is deliberately NO way to open a letter early.
- **Server guard (`guard_sealed_letter` trigger, UPDATE only):** while `sealed and unlock_at > now()` the letter's content (text, title, recipient, date, the seal itself) cannot change, so a stale second tab can't overwrite it; sealing needs a future date; moving it to the trash and back is still allowed. Errors: errcode 55000, messages `letter_is_sealed` / `seal_needs_future_date`. `restore_batch` sets `daftar.restoring` so a restore can import text but still never breaks a seal, and clears the flag before it returns (the flag must never outlive the restore, even inside one transaction).
- **Masking:** `browse_entries` returns no title, no snippet, never matches by title/words, and returns `letter_to` + `sealed_until` for a hidden letter; `list_letters()` does the same for the Letters screen. Client side, `maskIfSealed` / `summaryFromContent` / `rowFromContent` / `matchesFilters` / `fetchDay` apply the same rule to anything built from this device's drafts. Every NEW list that reads entries must go through one of these.
- **Stale drafts:** when a save is refused as sealed, the id goes into `markKnownSealed` (localStorage); lists then ignore any local draft of that letter, so an old unsealed draft never appears. The draft itself is kept on the device (never delete words).
- **Compose:** the Letters track (or `/write/new?letter=1`) makes a page a letter (`is_letter`). `LetterPanel` = "To" + a deliberate "Seal this letter…" step (warning in plain words, a date at least tomorrow, quick choices, a button that spells out the date). The seal opens at the START of the chosen day in the writer's own time zone (`unlockInstant`). After sealing, `Write.tsx` renders `SealedCard` and NEVER mounts the editor, so a sealed letter's words aren't even loaded into the page. Once the day comes it is an ordinary entry again with a note.
- **Letters are not "today's page":** `findTodaysEntry` and the Desk's Write today / Keep going ignore letters.
- **Visuals:** `WaxSeal` (CSS only: lopsided disc, lit from the lamp, pressed rim, embossed dal د, cracked when open) and `SealedCard` (voice table: "Sealed until 20 April 2029.").
- **Limits:** "sealed now" on the device uses the device clock (the server uses its own for lists/search); setting the clock forward only defeats a promise the owner made to themselves.
- **Preview:** sample letters (sealed far and near, opened, draft); the simulated server enforces the same seal rules.

## Prompts and the die (phase 8): read `app/src/lib/promptSeed.ts` and `app/src/lib/prompts.ts` first
- **Content is the user's.** `supabase/seed/prompts.json` (the repo ships a 30-prompt sample). `npm run prompts:sql` validates it (vocabulary, no emoji, no duplicates, 12-240 chars, English only) and writes the git-ignored `supabase/seed/prompts.sql`, an idempotent upsert keyed on `(language, md5(text))` (unique index in migration 0009) that the user pastes into the SQL Editor. No keys. Node runs `promptSeed.ts` directly (type stripping), so keep that file to erasable TS with no imports. It is the single source of the vocabulary: depth light/medium/deep; mood calm/heavy/restless/grateful/hopeful/curious; time morning/afternoon/evening/night; track_hint daily/spiritual/letters/dreams.
- **Matching:** a prompt with no mood/time/track fits any filter value; depth is required and exact. **Die:** `rollPrompt` is pure; it bars the last 20 rolled ids (`NO_REPEAT_WINDOW`), and when the pool is smaller than that it serves the one shown longest ago (never the one just shown unless the pool is 1). History, filters and the prompt on show persist in localStorage (`daftar.die`); prompts are cached in `daftar.prompts` for offline.
- **UI:** `PromptDie` card on the Desk (`BrassDie` = flame line art SVG, 150 ms tilt keyed by roll count, off under reduced motion). "Write about this" navigates to `/write/new` with `state.prompt = {text, track_hint}`; `Write` starts the page on the hinted track and stores the text in `entry.fields.prompt` (so it exports with the entry and survives Spiritual field edits, which spread `...fields`); shown as an italic line above the editor.
- **Preview:** `preview.prompts` reads the real seed file (dev only; `vite.config.ts` `server.fs.allow: ['..']`, compiled out of production; verified absent from dist).
- `rls.test.sql`: the old "visitor can read prompts" check wanted exactly one row; it now accepts any number (real Supabase will hold the loaded seed).

## Licensing (phase 9): read `supabase/migrations/0010_licensing.sql` and `supabase/functions/_shared/lemonsqueezy.ts` first
- **All rules are in SQL:** `apply_license_event(provider, kind 'paid'|'refunded', order_id, user_id)` (service_role only, security definer) with `license_events` (unique per provider+order+kind) as the idempotency key and audit log. Outcomes: unlocked, duplicate, already_unlocked (second order: first kept, owner refunds by hand), refunded_before_paid (webhooks out of order), unknown_user, unknown_order, ignored. A refund is matched by ORDER, so refunding an old order never touches a newer unlock; a repurchase after a refund unlocks again. Refund touches no data.
- **Edge Function** `supabase/functions/lemonsqueezy-webhook` is thin: verify `X-Signature` (hex HMAC-SHA256 of the raw body, constant-time), `parseEvent` (only order_created with status paid, only a FULL refund; optional `LEMONSQUEEZY_VARIANT_ID` filter; user id from `meta.custom_data.user_id`, UUID-checked), call the RPC. 200 for events we deliberately skip, 5xx on database errors so the provider retries. Deploy with `--no-verify-jwt`. `_shared/lemonsqueezy.ts` is pure Web Crypto so vitest runs it (vitest config includes `../supabase/functions/**/*.test.ts`).
- **Not verified against a live store:** payload fields beyond the docs' example (`data.id`, `attributes.status`, `first_order_item.variant_id`); partial-refund status naming. The first test-mode purchase confirms. Provider choice (Lemon Squeezy over Paddle) was mine; only `_shared/lemonsqueezy.ts` and the function are provider-specific (`provider` is a column).
- **Client:** `lib/licence.ts` (copy from the voice table, `deskNotice` silent until 5 days remain, `checkoutUrl` adds only our user id as `checkout[custom][user_id]`, `pollUntil` 3 s for 60 s). `/unlock` screen (buy; `?paid=1` polls `refresh()`, "Daftar is yours. Write as long as you like."; after 60 s says plainly it is still arriving + Check again; also refreshes when the tab regains focus). Realtime is NOT used: polling meets the spec's alternative. Desk shows the notice with an Unlock button; Write's status line shows read-only/grace/refunded copy with Unlock; Settings shows the line + Unlock.
- **Preview:** badge select for licence state (trial/soon/grace/ended/unlocked/refunded, or `?licence=ended`); Unlock simulates the purchase.
- `VITE_CHECKOUT_URL` (https only) in `app/.env.local`; unset = "Checkout isn't switched on here yet."

## Hosting (GitHub Pages, personal use; swap for a real host before selling)
- `.github/workflows/pages.yml` runs tests, builds `app/` and deploys on push to main. Repo secrets `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`; optional repo variables `PAGES_BASE` (override the base path; `/` for a custom domain) and `VITE_CHECKOUT_URL`. Pages needs Settings -> Pages -> Source: GitHub Actions.
- The app is served from `VITE_BASE` (default `/`; the workflow uses `/<repo>/`). Vite prefixes the base on index.html, CSS urls and the manifest; the router uses `basename`, the PWA scope/start_url/navigateFallback follow it, and the sign-in link uses `BASE_URL`. **Never write a root-absolute path ("/foo") in TS/TSX code; build it from `import.meta.env.BASE_URL`.**
- The build copies index.html to 404.html so a refresh on /write works (Pages can't rewrite).
- The repo is public: the spec PDFs are untracked and git-ignored (`*.pdf`, `docs/`), the Supabase project URL is not in tracked files, only the publishable key ever leaves the machine (via the Actions secret, and it is public by design). README says all rights reserved. Supabase Auth Site URL and Redirect URLs must list the Pages address.

## Status
Phase 9 complete (not yet exercised against Lemon Squeezy or a deployed function): migration 0010, webhook Edge Function, Unlock screen, trial messaging, refund/read-only states. 148 DB checks, SQL rules mutation-tested (9 of 10; the survivor is an unreachable label).
Phase 8 complete: migration 0009, prompt seed validator + SQL loader, die with no-repeat-in-20 roll, Desk card with depth/mood/time filters, Write-about-this handoff. 141 DB checks, 245 client tests (roll/filter logic mutation-tested). Real Supabase: run 0009, re-run rls.test.sql, then load prompts.sql.
Phase 7 complete: migration 0008, seal guard, masked lists, Letters screen, compose + seal flow, wax seal, sealed pages in Write and Read. 136 DB checks, 212 client tests (guard and masking mutation-tested). Not yet run against real Supabase.
Phase 6 complete: migration 0007, photo pipeline, upload queue, photo node (paste/drop/toolbar), photos in Read, .zip export and restore, storage meter on server numbers. 124 DB checks, 173 client tests (mutation-tested). Not yet exercised against real Supabase Storage.
Phase 5 complete including the page turn (Opus): migration 0006, Browse (search, filters, calendar with dots and chapter underlines, list with paging and highlights), Read (spreads, quiet days, keyboard, drag, jump, page-turn with riffle). 115 DB checks, 104 client tests.
Design pass complete (Heritage lamplight): fonts, tokens, parchment + glass, lozenge/diamond controls, floating nav, Desk hero, Handwriting option, contrast verified on real pixels. Layout verified at 375 px and 1280 px in both themes; the brass die, wax seal and calendar will follow this language when built.
Phase 4 complete: migration 0005, Vault screen (export, restore preview → merge → report download, storage meter), Desk backup line + 30-day nudge. 107 DB checks, 52 client tests (incl. 21 Vault integration tests).
Phase 3 complete: migration 0004, tracks/tags/chapters UI (Settings cards, Chapters + chapter detail, track/language pills and tag bar in the entry header), Spiritual template, 102 DB checks, 27 client tests. Not yet exercised against the real Supabase from the browser (needs a signed-in session): create/rename/hide writes.
Phase 2 complete: Tiptap editor (per-block dir=auto via decorations; JSON stays clean), `save_entry()` (migration 0003), sync engine + 19 tests, Write screen (/write = today's entry, /write/new, /write/:id), Desk with last 5 entries, offline account cache.
Phase 1 complete: migrations 0001 + 0002 (Opus review fixes: same-owner composite keys, tsvector length cap, closed default privileges, bucket limits), `supabase/tests/rls.test.sql` (58 checks; `cd app && npm run db:test` runs them on PGlite), magic-link + 6-digit-code login, route guard.
Decisions: `can_write` requires status='trial' (so refunded never writes); `can_edit` = unlocked or trial+48h grace; tracks are copied per account by the signup trigger; entry_versions is insert-only from the client.
Phase 0 complete (scaffold, tokens, fonts, both themes, nine routed stub screens, PWA manifest + service worker).
