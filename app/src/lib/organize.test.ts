import { describe, expect, it } from 'vitest'
import { chaptersFor, inChapter, slugify, type Chapter } from './organize'
import { docToText } from './entries'

const ch = (name: string, start: string, end: string | null): Chapter => ({
  id: name, name, description: '', start_date: start, end_date: end, color_token: 'olive',
})

describe('chapters are computed from dates', () => {
  it('includes both ends of the range', () => {
    const c = ch('Junior year', '2026-09-01', '2027-05-31')
    expect(inChapter('2026-09-01', c)).toBe(true)
    expect(inChapter('2027-05-31', c)).toBe(true)
    expect(inChapter('2026-08-31', c)).toBe(false)
    expect(inChapter('2027-06-01', c)).toBe(false)
  })
  it('an ongoing chapter has no end', () => {
    const c = ch('Now', '2026-10-01', null)
    expect(inChapter('2026-10-01', c)).toBe(true)
    expect(inChapter('2099-01-01', c)).toBe(true)
    expect(inChapter('2026-09-30', c)).toBe(false)
  })
  it('an entry can be in several overlapping chapters', () => {
    const list = [ch('Year', '2026-01-01', '2026-12-31'), ch('Trip', '2026-06-01', '2026-06-15'), ch('Later', '2027-01-01', null)]
    expect(chaptersFor('2026-06-10', list).map((c) => c.name)).toEqual(['Year', 'Trip'])
    expect(chaptersFor('2026-12-31', list).map((c) => c.name)).toEqual(['Year'])
    expect(chaptersFor('2025-01-01', list)).toEqual([])
  })
})

describe('slugify', () => {
  it('keeps letters from any script', () => {
    expect(slugify('Morning  Prayer!')).toBe('morning-prayer')
    expect(slugify('دعاء الصباح')).toBe('دعاء-الصباح')
    expect(slugify('!!!')).toBe('track')
  })
})

describe('docToText', () => {
  it('joins blocks with a blank line and ignores empty edges', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'What I noticed' }] },
        { type: 'paragraph' },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Impressions' }] },
        { type: 'paragraph' },
      ],
    }
    expect(docToText(doc)).toBe('What I noticed\n\n\n\nImpressions')
  })
})
