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
- Phase 6: media.bytes is client-reported, so the 2 GB cap can't trust it. Compute usage from storage.objects metadata server-side and enforce the cap in the storage insert policy.
- Phase 7: the seal is UI-only per spec. Consider a trigger that blocks edits to a sealed letter before unlock_at.
- Phase 10: deleting auth.users cascades rows but NOT storage objects; the delete-account function must remove them.
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

## Status
Phase 5 complete including the page turn (Opus): migration 0006, Browse (search, filters, calendar with dots and chapter underlines, list with paging and highlights), Read (spreads, quiet days, keyboard, drag, jump, page-turn with riffle). 115 DB checks, 104 client tests.
Design pass complete (Heritage lamplight): fonts, tokens, parchment + glass, lozenge/diamond controls, floating nav, Desk hero, Handwriting option, contrast verified on real pixels. Layout verified at 375 px and 1280 px in both themes; the brass die, wax seal and calendar will follow this language when built.
Phase 4 complete: migration 0005, Vault screen (export, restore preview → merge → report download, storage meter), Desk backup line + 30-day nudge. 107 DB checks, 52 client tests (incl. 21 Vault integration tests).
Phase 3 complete: migration 0004, tracks/tags/chapters UI (Settings cards, Chapters + chapter detail, track/language pills and tag bar in the entry header), Spiritual template, 102 DB checks, 27 client tests. Not yet exercised against the real Supabase from the browser (needs a signed-in session): create/rename/hide writes.
Phase 2 complete: Tiptap editor (per-block dir=auto via decorations; JSON stays clean), `save_entry()` (migration 0003), sync engine + 19 tests, Write screen (/write = today's entry, /write/new, /write/:id), Desk with last 5 entries, offline account cache.
Phase 1 complete: migrations 0001 + 0002 (Opus review fixes: same-owner composite keys, tsvector length cap, closed default privileges, bucket limits), `supabase/tests/rls.test.sql` (58 checks; `cd app && npm run db:test` runs them on PGlite), magic-link + 6-digit-code login, route guard.
Decisions: `can_write` requires status='trial' (so refunded never writes); `can_edit` = unlocked or trial+48h grace; tracks are copied per account by the signup trigger; entry_versions is insert-only from the client.
Phase 0 complete (scaffold, tokens, fonts, both themes, nine routed stub screens, PWA manifest + service worker).
