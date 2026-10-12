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
- `0008_letters.sql` (phase 7: the seal guard, masked browse and list_letters)
- `0009_prompts.sql` (phase 8: one prompt per text, time-of-day check; tidies existing rows first; then load prompts, below)
- `0010_licensing.sql` (phase 9: apply_license_event, license_events; then set up the webhook, below)

## Loading prompts
Prompts live in `seed/prompts.json` (the file shipped is a small sample; replace it with yours).
1. `cd app && npm run prompts:sql` checks the file and tells you plainly what to fix, then writes `seed/prompts.sql`.
2. Paste `seed/prompts.sql` into the SQL Editor → **Run**. Safe to run again: prompts are matched by their exact text, so tags (depth, mood, time, track) update in place and new prompts are added. Nothing is ever deleted; to remove a prompt, delete its row in Table Editor → `prompts`.
No keys involved. Fields: `text`, `depth` (light / medium / deep, required), and optional `mood` (calm, heavy, restless, grateful, hopeful, curious), `time_of_day` (morning, afternoon, evening, night), `track_hint` (daily, spiritual, letters, dreams). Leave an optional field out and the prompt fits any.

## Licensing: Lemon Squeezy webhook (phase 9)
Nothing here needs the app's keys; the service-role key stays inside Supabase's Edge Function environment.
1. **Lemon Squeezy** (test mode first): create a store and one product, $49 one-time. Under the product's checkout options set the **redirect after purchase** to `https://YOUR-APP/unlock?paid=1` (use `http://localhost:5173/unlock?paid=1` in development). Copy the product's buy link into `app/.env.local` as `VITE_CHECKOUT_URL=...`.
2. **Webhook** (Settings → Webhooks → +): URL `https://<project-ref>.supabase.co/functions/v1/lemonsqueezy-webhook`, a signing secret you invent (long and random), events **order_created** and **order_refunded**.
3. **Deploy** (needs the Supabase CLI, `supabase login`, `supabase link --project-ref <ref>`):
       supabase secrets set LEMONSQUEEZY_WEBHOOK_SECRET=<the signing secret>
       supabase functions deploy lemonsqueezy-webhook --no-verify-jwt
   Optional: `supabase secrets set LEMONSQUEEZY_VARIANT_ID=<variant id>` so only that product can unlock Daftar.
   (`--no-verify-jwt` is correct: Lemon Squeezy sends no Supabase login; the signature is the authentication.)
4. **Try it** with a test-mode purchase using Lemon Squeezy's test card: the Unlock screen should flip to "Daftar is yours." within a few seconds. Then refund the order in the dashboard: the account goes read-only. In the SQL Editor, `select * from license_events order by id desc` shows every webhook and what it did (`unlocked`, `duplicate`, `already_unlocked`, ...). An `already_unlocked` row means someone paid twice: refund the second order by hand.
5. Going live: switch the store out of test mode, create the live webhook (new secret), update the secrets and `VITE_CHECKOUT_URL`.

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
