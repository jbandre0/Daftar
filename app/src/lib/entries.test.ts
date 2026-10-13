import { describe, expect, it } from 'vitest'
import { parseEntryDate } from './entries'

describe('parseEntryDate: the date a page may be filed under', () => {
  const today = '2026-10-13'
  it('accepts a real past date and today', () => {
    expect(parseEntryDate('2019-02-28', today)).toBe('2019-02-28')
    expect(parseEntryDate('2026-10-13', today)).toBe('2026-10-13')
    expect(parseEntryDate('2024-02-29', today)).toBe('2024-02-29')
  })
  it('refuses the future, impossible days, and anything that is not YYYY-MM-DD', () => {
    expect(parseEntryDate('2026-10-14', today)).toBeNull()
    expect(parseEntryDate('2027-01-01', today)).toBeNull()
    expect(parseEntryDate('2023-02-29', today)).toBeNull()
    expect(parseEntryDate('2023-13-01', today)).toBeNull()
    expect(parseEntryDate('13/10/2020', today)).toBeNull()
    expect(parseEntryDate('2020-1-5', today)).toBeNull()
    expect(parseEntryDate('', today)).toBeNull()
    expect(parseEntryDate(null, today)).toBeNull()
    expect(parseEntryDate(undefined, today)).toBeNull()
  })
})
