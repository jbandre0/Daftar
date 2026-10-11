import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../auth'
import { syncAll } from '../lib/sync'
import { syncDeps } from '../lib/syncDeps'

/** On app open and whenever the network returns, unsynced drafts are pushed first (spec §7, rule 6). */
export function SyncBoot() {
  const { session } = useAuth()
  const userId = session?.user.id
  useEffect(() => {
    if (!userId) return
    const run = () => void syncAll(syncDeps, userId).catch(() => {})
    run()
    window.addEventListener('online', run)
    return () => window.removeEventListener('online', run)
  }, [userId])
  return <Outlet />
}
