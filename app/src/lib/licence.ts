/**
 * Phase 9, client side. The client only DISPLAYS licence state; the server (can_write / can_edit, migration 0001)
 * decides what is allowed, and the webhook (supabase/functions/lemonsqueezy-webhook) is the only thing that changes a licence.
 * Voice: the spec's table (p.20-21). Reading and export are never gated, and the copy always says so when writing is.
 */
import { trialDaysLeft, writeState, type License } from './account'
import { preview } from './preview'

export const PRICE = '$49'
export const TRIAL_NOTICE_DAYS = 5

const plural = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`

export type LicenceNotice = { text: string; offerUnlock: boolean }

/** The one quiet line on the Desk (and Settings). null = nothing to say (unlocked, or more than 5 days of trial left). */
export function deskNotice(l: License | null, now = Date.now()): LicenceNotice | null {
  if (!l) return null
  const s = writeState(l, now)
  if (s === 'unlocked' || s === 'unknown') return null
  if (s === 'trial') {
    const d = trialDaysLeft(l, now)
    return d <= TRIAL_NOTICE_DAYS ? { text: `Your trial ends in ${plural(d)}. Everything you've written stays yours either way.`, offerUnlock: true } : null
  }
  return { text: ENDED[s === 'grace' ? 'grace' : l.status === 'refunded' ? 'refunded' : 'ended'], offerUnlock: true }
}

const ENDED = {
  grace: 'Your trial has ended, so new entries are paused. You can still finish anything already started, and read and export everything.',
  ended: `Your trial has ended. You can still read and export everything. Unlock Daftar for ${PRICE}, once, to keep writing.`,
  refunded: 'Your purchase was refunded, so Daftar is read-only. Everything you wrote is still yours to read and export.',
} as const

/** The line under the page while the trial is over (Write screen). null while writing is open. */
export function pageNotice(l: License | null, now = Date.now(), hasStarted = false): string | null {
  const s = writeState(l, now)
  if (s === 'readonly') return l?.status === 'refunded' ? ENDED.refunded : ENDED.ended
  if (s === 'grace' && !hasStarted) return ENDED.grace
  return null
}

/** What Settings says about the account. */
export function settingsLine(l: License | null, now = Date.now()): string {
  if (!l) return ''
  const s = writeState(l, now)
  if (s === 'unlocked') return 'Daftar is yours.'
  if (s === 'trial') return `Your trial ends in ${plural(trialDaysLeft(l, now))}. Everything you've written stays yours either way.`
  return ENDED[s === 'grace' ? 'grace' : l.status === 'refunded' ? 'refunded' : 'ended']
}

/** Hosted checkout. Our user id rides along as custom data and comes back in the webhook; no card detail ever touches this app. */
export function checkoutUrl(userId: string, base: string | undefined = import.meta.env.VITE_CHECKOUT_URL as string | undefined): string | null {
  if (!base) return null
  try {
    const u = new URL(base)
    if (u.protocol !== 'https:') return null
    u.searchParams.set('checkout[custom][user_id]', userId)
    return u.toString()
  } catch {
    return null
  }
}

/** Dev preview: pretend the purchase happened (no provider). */
export function startCheckout(userId: string): 'redirecting' | 'simulated' | 'unavailable' {
  if (preview.checkout) {
    preview.checkout()
    return 'simulated'
  }
  const url = checkoutUrl(userId)
  if (!url) return 'unavailable'
  window.location.assign(url)
  return 'redirecting'
}

/**
 * After checkout the webhook may land a moment later. Look every `every` ms for up to `within` ms
 * (the spec: poll for up to 60 seconds). Returns true as soon as `check` does. Injectable clock for tests.
 */
export async function pollUntil(
  check: () => Promise<boolean>,
  opts: { every?: number; within?: number; sleep?: (ms: number) => Promise<void>; signal?: { cancelled: boolean } } = {},
): Promise<boolean> {
  const every = opts.every ?? 3000
  const within = opts.within ?? 60_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let waited = 0
  for (;;) {
    if (opts.signal?.cancelled) return false
    try {
      if (await check()) return true
    } catch {
      /* offline for a moment: keep looking */
    }
    if (waited >= within) return false
    await sleep(every)
    waited += every
  }
}
