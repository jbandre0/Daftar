import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from './auth'
import { cachedOrganize, EMPTY, loadOrganize, type Organize } from './lib/organize'

export type OrganizeValue = Organize & { refresh: () => Promise<void> }
export const OrganizeCtx = createContext<OrganizeValue | null>(null)

/** Tracks, tags, chapters and templates for the signed-in user. Cached, so the editor works offline. */
export function OrganizeProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const userId = session?.user.id
  const [data, setData] = useState<Organize>(EMPTY)

  const refresh = useCallback(async () => {
    if (!userId) return
    try {
      setData(await loadOrganize(userId))
    } catch {
      /* offline: the cached copy stands */
    }
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setData(EMPTY)
      return
    }
    setData(cachedOrganize(userId))
    void refresh()
    window.addEventListener('online', refresh)
    return () => window.removeEventListener('online', refresh)
  }, [userId, refresh])

  const value = useMemo(() => ({ ...data, refresh }), [data, refresh])
  return <OrganizeCtx.Provider value={value}>{children}</OrganizeCtx.Provider>
}

export function useOrganize() {
  const ctx = useContext(OrganizeCtx)
  if (!ctx) throw new Error('useOrganize outside OrganizeProvider')
  return ctx
}
