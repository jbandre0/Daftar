# Supabase setup (Phase 1)

Project: `mcsbybmttzoiynnwexbw`

## 1. Apply the schema (once)
Supabase dashboard → **SQL Editor** → New query → paste all of `migrations/0001_init.sql` → **Run**.
Expect "Success. No rows returned."

## 2. Prove it works (once, and again after every future migration)
New query → paste all of `tests/rls.test.sql` → **Run**. Every row in the result must say `PASS`.
It creates two throw-away users, tries to break every rule, and deletes them afterwards.
(The same test runs locally with `cd app && npm run db:test`.)

## Later migrations
Run each new file in `migrations/` once, in order, then re-run `tests/rls.test.sql`.
- `0002_rls_hardening.sql` (phase 1 review)
- `0003_save_entry.sql` (phase 2: the editor's save function)
- `0004_organization.sql` (phase 3: Spiritual template, tags in save_entry)
- `0005_vault.sql` (phase 4: export_journal, restore_meta, restore_batch, restore_remaps)
- `0006_browse.sql` (phase 5: browse_entries search and filters, entry_dates)
- `0007_photos.sql` (phase 6: register_media, the server-side 2 GB cap, photo list in the export)

## 3. Auth settings
- **Authentication → URL Configuration**
  - Site URL: `http://localhost:5173` (switch to the real domain at launch)
  - Redirect URLs: add `http://localhost:5173/**`
- **Authentication → Email Templates → Magic Link**: make sure the body contains both the link and the code, e.g.

      <h2>Your Daftar sign-in</h2>
      <p><a href="{{ .ConfirmationURL }}">Open Daftar</a></p>
      <p>Or enter this code: <strong>{{ .Token }}</strong></p>

  The code matters on iPhone: a link opens in Safari, not in the installed home-screen app.
- Email provider stays on Supabase's built-in sender for now (low hourly limit; fine for development).

## Keys
The app uses only the **publishable** key (in `app/.env.local`, gitignored). The service-role/secret key never goes in the app or this repo.
