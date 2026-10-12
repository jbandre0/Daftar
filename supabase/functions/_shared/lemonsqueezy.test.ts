import { describe, expect, it } from 'vitest'
import { parseEvent, safeEqual, sign, verifySignature } from './lemonsqueezy'

const UID = '3f2a9c1e-7b4d-4e8a-9d10-5a6b7c8d9e0f'
const order = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}, id: unknown = '1001') => ({
  meta: { event_name: 'order_created', custom_data: { user_id: UID }, ...meta },
  data: { type: 'orders', id, attributes: { status: 'paid', first_order_item: { variant_id: 77 }, ...over } },
})

describe('signature', () => {
  const body = JSON.stringify(order())
  it('accepts the right signature', async () => { expect(await verifySignature(body, await sign(body, 's3cret'), 's3cret')).toBe(true) })
  it('accepts upper-case hex (headers are case-loose)', async () => { expect(await verifySignature(body, (await sign(body, 's3cret')).toUpperCase(), 's3cret')).toBe(true) })
  it('refuses a wrong secret, a changed body, a missing header, an empty secret', async () => {
    const good = await sign(body, 's3cret')
    expect(await verifySignature(body, good, 'other')).toBe(false)
    expect(await verifySignature(body + ' ', good, 's3cret')).toBe(false)
    expect(await verifySignature(body, null, 's3cret')).toBe(false)
    expect(await verifySignature(body, '', 's3cret')).toBe(false)
    expect(await verifySignature(body, 'abc', '')).toBe(false)
  })
  it('matches a known HMAC-SHA256 vector', async () => {
    expect(await sign('The quick brown fox jumps over the lazy dog', 'key')).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8')
  })
  it('safeEqual: length and content', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('parseEvent', () => {
  it('a paid order carries the user id from the checkout', () => {
    expect(parseEvent(order())).toEqual({ ok: true, event: { kind: 'paid', orderId: '1001', userId: UID } })
  })
  it('order ids may be numbers', () => { expect((parseEvent(order({}, {}, 1001)) as any).event.orderId).toBe('1001') })
  it('a paid order with no (or a malformed) user id still parses, with userId null (the database then answers unknown_user)', () => {
    expect((parseEvent(order({}, { custom_data: {} })) as any).event.userId).toBeNull()
    expect((parseEvent(order({}, { custom_data: { user_id: "x'; drop table licenses;--" } })) as any).event.userId).toBeNull()
  })
  it('only a paid order unlocks', () => {
    expect(parseEvent(order({ status: 'pending' })).ok).toBe(false)
    expect(parseEvent(order({ status: 'failed' })).ok).toBe(false)
  })
  it('only a full refund ends a licence', () => {
    const r = (status: string) => parseEvent(order({ status }, { event_name: 'order_refunded' }))
    expect(r('refunded')).toEqual({ ok: true, event: { kind: 'refunded', orderId: '1001', userId: null } })
    expect(r('partial_refund').ok).toBe(false)
    expect(r('paid').ok).toBe(false)
  })
  it('other events are ignored', () => {
    expect(parseEvent(order({}, { event_name: 'subscription_created' })).ok).toBe(false)
    expect(parseEvent({}).ok).toBe(false)
    expect(parseEvent(null).ok).toBe(false)
  })
  it('needs an order', () => {
    expect(parseEvent({ meta: { event_name: 'order_created' }, data: { type: 'orders', attributes: { status: 'paid' } } }).ok).toBe(false)
    expect(parseEvent({ meta: { event_name: 'order_created' }, data: { type: 'customers', id: '1', attributes: { status: 'paid' } } }).ok).toBe(false)
  })
  it('a variant filter keeps other products from unlocking Daftar', () => {
    expect(parseEvent(order(), '77').ok).toBe(true)
    expect(parseEvent(order(), '78').ok).toBe(false)
    expect(parseEvent(order({ first_order_item: undefined }), '77').ok).toBe(false)
    expect(parseEvent(order(), undefined).ok).toBe(true)
  })
})
