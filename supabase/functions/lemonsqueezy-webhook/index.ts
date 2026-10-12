// Supabase Edge Function (Deno). Deploy with:  supabase functions deploy lemonsqueezy-webhook --no-verify-jwt
// (--no-verify-jwt: Lemon Squeezy sends no Supabase JWT; the signature below is the authentication.)
// Secrets:  supabase secrets set LEMONSQUEEZY_WEBHOOK_SECRET=... [LEMONSQUEEZY_VARIANT_ID=...]
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to Edge Functions automatically; the service key is never in the app.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { parseEvent, verifySignature } from '../_shared/lemonsqueezy.ts'

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  const secret = Deno.env.get('LEMONSQUEEZY_WEBHOOK_SECRET') ?? ''
  if (!secret) return json(500, { error: 'not configured' })

  const raw = await req.text() // the signature covers the exact bytes, so never re-serialise before checking
  if (!(await verifySignature(raw, req.headers.get('x-signature'), secret))) return json(401, { error: 'bad signature' })

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json(400, { error: 'not json' })
  }
  const parsed = parseEvent(body, Deno.env.get('LEMONSQUEEZY_VARIANT_ID') || undefined)
  if (!parsed.ok) return json(200, { handled: false, reason: parsed.reason }) // 200 so the provider doesn't retry what we deliberately skip

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
  const { data, error } = await db.rpc('apply_license_event', {
    p_provider: 'lemonsqueezy', p_kind: parsed.event.kind, p_order_id: parsed.event.orderId, p_user_id: parsed.event.userId,
  })
  if (error) {
    console.error('apply_license_event failed', error.message)
    return json(500, { error: 'try again' }) // a 5xx makes the provider retry; the function is idempotent
  }
  return json(200, { handled: true, outcome: data })
})
