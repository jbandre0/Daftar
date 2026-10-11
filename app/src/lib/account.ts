import { supabase } from './supabase'

export type Profile = {
  id: string
  display_name: string | null
  timezone: string
  default_language: string
  last_export_at: string | null
  storage_bytes_used: number
  created_at?: string
}

export type License = {
  user_id: string
  trial_started_at: string
  trial_ends_at: string
  status: 'trial' | 'unlocked' | 'refunded'
  unlocked_at: string | null
}

/**
 * What the client may show. The server (RLS) is the only judge of what is actually allowed.
 * 'unknown' (offline, nothing cached) lets the user write: the draft is kept locally either way.
 */
export type WriteState = 'trial' | 'grace' | 'readonly' | 'unlocked' | 'unknown'

export function writeState(l: License | null, now = Date.now()): WriteState {
  if (!l) return 'unknown'
  if (l.status === 'unlocked') return 'unlocked'
  if (l.status === 'refunded') return 'readonly'
  const end = new Date(l.trial_ends_at).getTime()
  if (end > now) return 'trial'
  return now < end + 48 * 3600 * 1000 ? 'grace' : 'readonly'
}

export function trialDaysLeft(l: License, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(l.trial_ends_at).getTime() - now) / 86_400_000))
}

export async function loadAccount(userId: string): Promise<{ profile: Profile | null; license: License | null }> {
  const [p, l] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
    supabase.from('licenses').select('*').eq('user_id', userId).maybeSingle(),
  ])
  if (p.error || l.error) throw p.error ?? l.error // offline: keep what we had
  const a = { profile: (p.data as Profile) ?? null, license: (l.data as License) ?? null }
  cacheAccount(userId, a)
  return a
}

export async function saveDisplayName(userId: string, name: string) {
  return supabase.from('profiles').update({ display_name: name.trim() }).eq('id', userId)
}

const CACHE_PREFIX = 'daftar.account.'

/** Last known profile and licence, so the app still knows who you are offline. */
export function cachedAccount(userId: string): { profile: Profile | null; license: License | null } {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + userId)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return { profile: null, license: null }
}

export function cacheAccount(userId: string, a: { profile: Profile | null; license: License | null }) {
  try {
    localStorage.setItem(CACHE_PREFIX + userId, JSON.stringify(a))
  } catch {
    /* ignore */
  }
}
