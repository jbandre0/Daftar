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
