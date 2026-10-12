/**
 * Phase 8: the prompt library and the die.
 *
 * Prompts are global and read-only (table `prompts`, loaded from supabase/seed/prompts.json; see
 * supabase/README.md). The die rolls from the filtered pool and never repeats a prompt within 20 rolls.
 *
 * Matching: a prompt with no mood / time / track fits ANY choice for that field. A filter left on "Any" matches all.
 * Rolling: `rollPrompt` is pure (give it an rng to test). If the pool is smaller than the 20-roll window, nothing
 * can avoid repeating, so it serves the prompt shown longest ago and never the one you just had (unless it is the only one).
 */
import { supabase } from './supabase'
import { preview } from './preview'
import type { Depth, Mood, SeedPrompt, TimeOfDay } from './promptSeed'

export type PromptRow = SeedPrompt & { id: string }
export type PromptFilters = { depth: Depth | null; mood: Mood | null; time: TimeOfDay | null }
export const NO_FILTERS: PromptFilters = { depth: null, mood: null, time: null }
export const NO_REPEAT_WINDOW = 20

export function matchesPrompt(p: SeedPrompt, f: PromptFilters): boolean {
  return (
    (!f.depth || p.depth === f.depth) &&
    (!f.mood || p.mood === null || p.mood === f.mood) &&
    (!f.time || p.time_of_day === null || p.time_of_day === f.time)
  )
}

/** `history` is newest first (ids of earlier rolls). null = nothing fits. */
export function rollPrompt(pool: PromptRow[], history: string[], rng: () => number = Math.random): PromptRow | null {
  if (pool.length === 0) return null
  const recent = new Set(history.slice(0, NO_REPEAT_WINDOW))
  let candidates = pool.filter((p) => !recent.has(p.id))
  if (candidates.length === 0) {
    const age = (p: PromptRow) => {
      const i = history.indexOf(p.id)
      return i === -1 ? Infinity : i
    }
    const oldest = Math.max(...pool.map(age))
    candidates = pool.filter((p) => age(p) === oldest)
  }
  return candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]
}

export const pushHistory = (history: string[], id: string): string[] => [id, ...history.filter((x) => x !== id)].slice(0, NO_REPEAT_WINDOW)

/* ---- what the die remembers on this device: filters, recent rolls, the prompt on show ---- */
export type DieState = { filters: PromptFilters; history: string[]; current: string | null }
const DIE_KEY = 'daftar.die'
const CACHE_KEY = 'daftar.prompts'

export function loadDieState(): DieState {
  try {
    const s = JSON.parse(localStorage.getItem(DIE_KEY) ?? 'null')
    if (s && typeof s === 'object') {
      return {
        filters: { ...NO_FILTERS, ...(s.filters ?? {}) },
        history: Array.isArray(s.history) ? s.history.filter((x: unknown) => typeof x === 'string').slice(0, NO_REPEAT_WINDOW) : [],
        current: typeof s.current === 'string' ? s.current : null,
      }
    }
  } catch { /* storage unavailable: start fresh */ }
  return { filters: NO_FILTERS, history: [], current: null }
}
export function saveDieState(s: DieState) {
  try { localStorage.setItem(DIE_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

/** English prompts, newest data from the server when online, the last copy on this device when not. */
export async function loadPrompts(): Promise<{ rows: PromptRow[]; offline: boolean }> {
  if (preview.prompts) return { rows: await preview.prompts(), offline: false }
  try {
    const { data, error } = await supabase
      .from('prompts')
      .select('id, text, depth, mood, time_of_day, track_hint')
      .eq('language', 'en')
      .order('created_at')
      .limit(5000)
    if (error) throw error
    const rows = (data ?? []) as PromptRow[]
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(rows)) } catch { /* ignore */ }
    return { rows, offline: false }
  } catch {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]')
      return { rows: Array.isArray(cached) ? cached : [], offline: true }
    } catch {
      return { rows: [], offline: true }
    }
  }
}
