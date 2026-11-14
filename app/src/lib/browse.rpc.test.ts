import { describe, expect, it, vi } from 'vitest'

const rpc = vi.fn(async () => ({ data: [], error: null }))
vi.mock('./supabase', () => ({ supabase: { rpc } }))
vi.mock('./syncDeps', () => ({ syncDeps: { store: { all: async () => [] } } }))
const { browseEntries, NO_FILTERS } = await import('./browse')

describe('browseEntries sends the Favorites filter to the server', () => {
  it('p_favorites follows the filter', async () => {
    await browseEntries('u1', { ...NO_FILTERS, favorites: true })
    expect(rpc).toHaveBeenLastCalledWith('browse_entries', expect.objectContaining({ p_favorites: true }))
    await browseEntries('u1', NO_FILTERS)
    expect(rpc).toHaveBeenLastCalledWith('browse_entries', expect.objectContaining({ p_favorites: false }))
  })
})
