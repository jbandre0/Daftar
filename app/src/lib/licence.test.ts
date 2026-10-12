import { describe, expect, it } from 'vitest'
import type { License } from './account'
import { checkoutUrl, deskNotice, pageNotice, pollUntil, settingsLine } from './licence'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 12, 12)
const lic = (over: Partial<License> & { endsInDays?: number } = {}): License => ({
  user_id: 'u', trial_started_at: new Date(NOW - 10 * DAY).toISOString(), status: 'trial', unlocked_at: null,
  trial_ends_at: new Date(NOW + (over.endsInDays ?? 10) * DAY).toISOString(), ...over,
})

describe('deskNotice: nothing until 5 days remain', () => {
  it('silent with more than 5 days left, and when unlocked, and when unknown', () => {
    expect(deskNotice(lic({ endsInDays: 10 }), NOW)).toBeNull()
    expect(deskNotice(lic({ endsInDays: 5.5 }), NOW)).toBeNull()
    expect(deskNotice(lic({ status: 'unlocked', endsInDays: -30 }), NOW)).toBeNull()
    expect(deskNotice(null, NOW)).toBeNull()
  })
  it('then one quiet line with the days left', () => {
    expect(deskNotice(lic({ endsInDays: 5 }), NOW)?.text).toMatch(/^Your trial ends in 5 days\. Everything you've written stays yours either way\.$/)
    expect(deskNotice(lic({ endsInDays: 1 }), NOW)?.text).toMatch(/in 1 day\./)
    expect(deskNotice(lic({ endsInDays: 0.4 }), NOW)?.text).toMatch(/in 1 day\./)
  })
  it('after the trial: grace, ended, refunded each say plainly that reading and export still work', () => {
    const grace = deskNotice(lic({ endsInDays: -1 }), NOW)!
    const ended = deskNotice(lic({ endsInDays: -3 }), NOW)!
    const refunded = deskNotice(lic({ status: 'refunded', endsInDays: 8 }), NOW)!
    expect(grace.text).toMatch(/new entries are paused/)
    expect(ended.text).toMatch(/read and export everything.*\$49, once/)
    expect(refunded.text).toMatch(/refunded.*read and export/)
    for (const n of [grace, ended, refunded]) expect(n.offerUnlock).toBe(true)
  })
})

describe('pageNotice', () => {
  it('null while open; grace only before anything is written; read-only always; refunded has its own words', () => {
    expect(pageNotice(lic(), NOW)).toBeNull()
    expect(pageNotice(lic({ status: 'unlocked' }), NOW)).toBeNull()
    expect(pageNotice(lic({ endsInDays: -1 }), NOW, false)).toMatch(/paused/)
    expect(pageNotice(lic({ endsInDays: -1 }), NOW, true)).toBeNull()
    expect(pageNotice(lic({ endsInDays: -3 }), NOW)).toMatch(/Unlock Daftar for \$49/)
    expect(pageNotice(lic({ status: 'refunded' }), NOW)).toMatch(/refunded/)
  })
})

describe('settingsLine', () => {
  it('covers every state', () => {
    expect(settingsLine(lic({ status: 'unlocked' }), NOW)).toBe('Daftar is yours.')
    expect(settingsLine(lic({ endsInDays: 12 }), NOW)).toMatch(/12 days/)
    expect(settingsLine(null, NOW)).toBe('')
  })
})

describe('checkoutUrl', () => {
  it('adds our user id as custom data and nothing else personal', () => {
    const u = new URL(checkoutUrl('3f2a-user', 'https://shop.lemonsqueezy.com/checkout/buy/abc')!)
    expect(u.searchParams.get('checkout[custom][user_id]')).toBe('3f2a-user')
    expect([...u.searchParams.keys()]).toEqual(['checkout[custom][user_id]'])
  })
  it('null when unset, not https, or not a URL', () => {
    expect(checkoutUrl('u', undefined)).toBeNull()
    expect(checkoutUrl('u', 'http://shop.example/x')).toBeNull()
    expect(checkoutUrl('u', 'not a url')).toBeNull()
  })
})

describe('pollUntil: up to 60 seconds, every 3', () => {
  const clock = () => { let t = 0; return { sleep: async (ms: number) => { t += ms }, now: () => t } }
  it('stops the moment the licence shows up', async () => {
    const c = clock(); let calls = 0
    expect(await pollUntil(async () => ++calls === 4, { sleep: c.sleep })).toBe(true)
    expect(c.now()).toBe(9000)
  })
  it('gives up after 60 seconds', async () => {
    const c = clock(); let calls = 0
    expect(await pollUntil(async () => (calls++, false), { sleep: c.sleep })).toBe(false)
    expect(c.now()).toBe(60_000)
    expect(calls).toBe(21)
  })
  it('keeps looking through a failed check (offline for a moment)', async () => {
    const c = clock(); let calls = 0
    expect(await pollUntil(async () => { if (++calls < 3) throw new Error('offline'); return true }, { sleep: c.sleep })).toBe(true)
  })
  it('can be cancelled', async () => {
    const s = { cancelled: true }
    expect(await pollUntil(async () => true, { sleep: async () => {}, signal: s })).toBe(false)
  })
})
