import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { cachedAccount, loadAccount, type License, type Profile } from './lib/account'

export type AuthState = {
  /** undefined while the first session check is running */
  session: Session | null | undefined
  profile: Profile | null
  license: License | null
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthState | null>(null)
const Ctx = AuthContext

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [license, setLicense] = useState<License | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id
  const refresh = useCallback(async () => {
    if (!userId) {
      setProfile(null)
      setLicense(null)
      return
    }
    const cached = cachedAccount(userId)
    if (cached.profile) setProfile(cached.profile)
    if (cached.license) setLicense(cached.license)
    try {
      const a = await loadAccount(userId)
      setProfile(a.profile)
      setLicense(a.license)
    } catch {
      /* offline: the cached copy stands */
    }
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
  }, [])

  const value = useMemo(() => ({ session, profile, license, refresh, signOut }), [session, profile, license, refresh, signOut])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
