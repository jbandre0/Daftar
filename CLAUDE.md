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
`cd app && npm run dev | build | typecheck`

## Carry-forward from the Phase 1 Opus RLS review
- Phase 2: do the save as ONE Postgres function (row lock, revision check, copy to entry_versions, write) so two tabs can't race; then revoke client insert on entry_versions.
- Phase 6: media.bytes is client-reported, so the 2 GB cap can't trust it. Compute usage from storage.objects metadata server-side and enforce the cap in the storage insert policy.
- Phase 7: the seal is UI-only per spec. Consider a trigger that blocks edits to a sealed letter before unlock_at.
- Phase 10: deleting auth.users cascades rows but NOT storage objects; the delete-account function must remove them.
- Supabase setting: keep anonymous sign-ins OFF (anonymous users get role authenticated and would get a trial).
- New tables/functions are closed by default (0002); every migration must grant explicitly.

## Status
Phase 1 complete: migrations 0001 + 0002 (Opus review fixes: same-owner composite keys, tsvector length cap, closed default privileges, bucket limits), `supabase/tests/rls.test.sql` (58 checks; `cd app && npm run db:test` runs them on PGlite), magic-link + 6-digit-code login, route guard.
Decisions: `can_write` requires status='trial' (so refunded never writes); `can_edit` = unlocked or trial+48h grace; tracks are copied per account by the signup trigger; entry_versions is insert-only from the client.
Phase 0 complete (scaffold, tokens, fonts, both themes, nine routed stub screens, PWA manifest + service worker).
