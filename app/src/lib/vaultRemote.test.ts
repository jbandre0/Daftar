import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {} }))
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})
const { dismissNudge, shouldNudge, sinceText } = await import('./vaultRemote')

const DAY = 86_400_000
const now = Date.parse('2026-10-12T12:00:00Z')
const ago = (d: number) => new Date(now - d * DAY).toISOString()

beforeEach(() => store.clear())

describe('backup nudge', () => {
  it('stays quiet within 30 days of the last export', () => {
    expect(shouldNudge(ago(29), ago(400), now)).toBe(false)
    expect(shouldNudge(ago(31), ago(400), now)).toBe(true)
  })
  it('a new account that never exported is not nagged in its first 30 days', () => {
    expect(shouldNudge(null, ago(5), now)).toBe(false)
    expect(shouldNudge(null, ago(45), now)).toBe(true)
  })
  it('dismissing silences it for 30 days', () => {
    dismissNudge(now - 10 * DAY)
    expect(shouldNudge(ago(60), ago(400), now)).toBe(false)
    dismissNudge(now - 31 * DAY)
    expect(shouldNudge(ago(60), ago(400), now)).toBe(true)
  })
  it('reads naturally', () => {
    expect(sinceText(null, now)).toBe('never')
    expect(sinceText(ago(0.2), now)).toBe('today')
    expect(sinceText(ago(1.2), now)).toBe('yesterday')
    expect(sinceText(ago(12.5), now)).toBe('12 days ago')
  })
})
