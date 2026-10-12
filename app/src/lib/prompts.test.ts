import { describe, expect, it } from 'vitest'
import { NO_FILTERS, NO_REPEAT_WINDOW, matchesPrompt, pushHistory, rollPrompt, type PromptRow } from './prompts'

const mk = (n: number, extra: Partial<PromptRow> = {}): PromptRow => ({
  id: `p${n}`, text: `Prompt number ${n} goes here`, depth: 'light', mood: null, time_of_day: null, track_hint: null, ...extra,
})
const pool = (n: number) => Array.from({ length: n }, (_, i) => mk(i))
// a small seeded rng so failures reproduce
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)

describe('rollPrompt: never repeats within 20 rolls', () => {
  it('21 prompts, 20,000 rolls: no id appears twice inside any window of 20', () => {
    const p = pool(21), rng = seeded(7)
    let history: string[] = []
    const seen: string[] = []
    for (let i = 0; i < 20000; i++) {
      const r = rollPrompt(p, history, rng)!
      expect(seen.slice(-NO_REPEAT_WINDOW)).not.toContain(r.id)
      seen.push(r.id)
      history = pushHistory(history, r.id)
    }
  })
  it('a bigger pool uses all of it', () => {
    const p = pool(60), rng = seeded(3)
    let h: string[] = []
    const used = new Set<string>()
    for (let i = 0; i < 2000; i++) { const r = rollPrompt(p, h, rng)!; used.add(r.id); h = pushHistory(h, r.id) }
    expect(used.size).toBe(60)
  })
  it('a pool smaller than the window cycles through everything and never repeats back to back', () => {
    const p = pool(5), rng = seeded(11)
    let h: string[] = []
    let last = ''
    const order: string[] = []
    for (let i = 0; i < 500; i++) {
      const r = rollPrompt(p, h, rng)!
      expect(r.id).not.toBe(last)
      last = r.id; order.push(r.id); h = pushHistory(h, r.id)
    }
    // every 5 consecutive rolls are all different
    for (let i = 0; i + 5 <= order.length; i += 5) expect(new Set(order.slice(i, i + 5)).size).toBe(5)
  })
  it('a pool of one still answers; an empty pool answers null', () => {
    expect(rollPrompt([mk(1)], ['p1'])?.id).toBe('p1')
    expect(rollPrompt([], [])).toBeNull()
  })
  it('history from other filters counts: rolls outside the pool still use up the window', () => {
    const p = pool(25)
    const history = p.slice(0, 20).map((x) => x.id).reverse() // p19 newest ... p0 oldest
    const r = rollPrompt(p, history, () => 0)!
    expect(['p20', 'p21', 'p22', 'p23', 'p24']).toContain(r.id)
  })
  it('only the last 20 rolls are barred, even when more history was stored', () => {
    const p = pool(25)
    const history = p.map((x) => x.id) // p0 newest ... p24 oldest
    expect(rollPrompt(p, history, () => 0)?.id).toBe('p20')
  })
  it('rng at the extremes stays in range', () => {
    expect(rollPrompt(pool(3), [], () => 0.9999999)?.id).toBe('p2')
    expect(rollPrompt(pool(3), [], () => 0)?.id).toBe('p0')
  })
})

describe('pushHistory', () => {
  it('newest first, capped, no duplicates', () => {
    let h: string[] = []
    for (let i = 0; i < 30; i++) h = pushHistory(h, `p${i}`)
    expect(h).toHaveLength(NO_REPEAT_WINDOW)
    expect(h[0]).toBe('p29')
    expect(pushHistory(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })
})

describe('matchesPrompt: filters', () => {
  const p = mk(1, { depth: 'deep', mood: 'heavy', time_of_day: 'night' })
  const any = mk(2, { depth: 'deep' })
  it('no filters matches everything', () => { expect(matchesPrompt(p, NO_FILTERS)).toBe(true) })
  it('depth must match exactly', () => {
    expect(matchesPrompt(p, { ...NO_FILTERS, depth: 'deep' })).toBe(true)
    expect(matchesPrompt(p, { ...NO_FILTERS, depth: 'light' })).toBe(false)
  })
  it('mood and time must match when the prompt has one', () => {
    expect(matchesPrompt(p, { ...NO_FILTERS, mood: 'calm' })).toBe(false)
    expect(matchesPrompt(p, { ...NO_FILTERS, time: 'morning' })).toBe(false)
    expect(matchesPrompt(p, { depth: 'deep', mood: 'heavy', time: 'night' })).toBe(true)
  })
  it('a prompt with no mood / time fits any mood / time', () => {
    expect(matchesPrompt(any, { depth: 'deep', mood: 'calm', time: 'morning' })).toBe(true)
  })
})
