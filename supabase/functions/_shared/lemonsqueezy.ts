/**
 * Lemon Squeezy webhook: signature check and event parsing. Pure (Web Crypto only), so it runs in Deno
 * (the Edge Function) and in Node (vitest). The licence RULES live in SQL (apply_license_event, migration 0010).
 *
 * Verified against Lemon Squeezy's docs: header `X-Signature` = hex HMAC-SHA256 of the RAW body with the signing secret;
 * events `order_created` / `order_refunded`; the checkout's `checkout[custom][user_id]` arrives at `meta.custom_data.user_id`.
 * Not verified against a live store: payload field details beyond the docs' example (data.id, attributes.status,
 * attributes.first_order_item.variant_id). The first test-mode purchase confirms them.
 */
export type LicenseEvent = { kind: 'paid' | 'refunded'; orderId: string; userId: string | null }
export type Parsed = { ok: true; event: LicenseEvent } | { ok: false; reason: string }

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Constant-time comparison of two hex strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export async function sign(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)))
}

export async function verifySignature(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header) return false
  return safeEqual(await sign(rawBody, secret), header.trim().toLowerCase())
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Decide what a (verified) webhook means. `variantId`: when set, only orders for that product variant count,
 * so something else sold from the same store can never unlock Daftar.
 */
export function parseEvent(body: unknown, variantId?: string): Parsed {
  const b = body as any
  const name = b?.meta?.event_name
  if (name !== 'order_created' && name !== 'order_refunded') return { ok: false, reason: `ignored event ${String(name)}` }
  const order = b?.data
  if (order?.type !== 'orders' || order?.id === undefined || order?.id === null || String(order.id) === '') return { ok: false, reason: 'no order id' }
  const attrs = order.attributes ?? {}
  if (variantId && String(attrs.first_order_item?.variant_id ?? '') !== String(variantId)) return { ok: false, reason: 'a different product' }
  const orderId = String(order.id)
  if (name === 'order_created') {
    if (attrs.status !== 'paid') return { ok: false, reason: `order is ${String(attrs.status)}, not paid` }
    const uid = b?.meta?.custom_data?.user_id
    return { ok: true, event: { kind: 'paid', orderId, userId: typeof uid === 'string' && UUID.test(uid) ? uid.toLowerCase() : null } }
  }
  // a partial refund keeps the licence: only a full refund (status "refunded") ends it
  if (attrs.status !== 'refunded') return { ok: false, reason: `refund is ${String(attrs.status)}, not a full refund` }
  return { ok: true, event: { kind: 'refunded', orderId, userId: null } }
}
