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
- No emoji, gradients on buttons, glassmorphism, toasts for save status, or looping animation. Transitions under 200 ms; honour prefers-reduced-motion.
- Copy follows the spec voice table (p.20-21).
- Run `node app/scripts/contrast.mjs` after touching colour tokens (must report 0 FAIL).

## Deviations from spec
- Daylight tokens darkened to pass AA: --flame #8F5311 (spec #A8641C), --ash-soft #6A5D4B (spec #786A57), --olive #56613A (spec #5E6A40). Added --on-flame (button text) because ink-on-flame fails AA in Daylight.
- Spec gaps to resolve in phase 1: `can_edit()` is referenced but never defined (trial + 48h grace, or unlocked).

## Commands
`cd app && npm run dev | build | typecheck | test | db:test`
- `npm test`: sync-engine suite (vitest + fake-indexeddb): offline, tab kill, rescue, two tabs, other devices.
- `npm run db:test`: migrations + `supabase/tests/rls.test.sql` on PGlite.
- Dev-only harness: `/dev/write/<uuid>` runs the real Write screen against a simulated server with an offline switch (not in production builds).

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

## Status
Phase 3 complete: migration 0004, tracks/tags/chapters UI (Settings cards, Chapters + chapter detail, track/language pills and tag bar in the entry header), Spiritual template, 102 DB checks, 27 client tests. Not yet exercised against the real Supabase from the browser (needs a signed-in session): create/rename/hide writes.
Phase 2 complete: Tiptap editor (per-block dir=auto via decorations; JSON stays clean), `save_entry()` (migration 0003), sync engine + 19 tests, Write screen (/write = today's entry, /write/new, /write/:id), Desk with last 5 entries, offline account cache.
Phase 1 complete: migrations 0001 + 0002 (Opus review fixes: same-owner composite keys, tsvector length cap, closed default privileges, bucket limits), `supabase/tests/rls.test.sql` (58 checks; `cd app && npm run db:test` runs them on PGlite), magic-link + 6-digit-code login, route guard.
Decisions: `can_write` requires status='trial' (so refunded never writes); `can_edit` = unlocked or trial+48h grace; tracks are copied per account by the signup trigger; entry_versions is insert-only from the client.
Phase 0 complete (scaffold, tokens, fonts, both themes, nine routed stub screens, PWA manifest + service worker).
