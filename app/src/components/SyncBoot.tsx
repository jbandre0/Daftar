import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { useAuth } from '../auth'
import { syncAll } from '../lib/sync'
import { syncDeps } from '../lib/syncDeps'
import { OrganizeProvider } from '../organize'
import { preview } from '../lib/preview'
import { photoQueue } from '../lib/photoRuntime'
import { patchEntryMediaId } from '../lib/photoRestore'

/** On app open and whenever the network returns, unsynced drafts are pushed first (spec §7, rule 6). */
export function SyncBoot() {
  const { session } = useAuth()
  const userId = session?.user.id
  const { refresh } = useAuth()

  // Photos waiting on this device go up whenever they can; the storage meter follows what the server confirms.
  useEffect(() => {
    if (!userId) return
    void photoQueue.start(userId)
    const unsub = photoQueue.subscribe((e) => {
      if (e.type !== 'registered') return
      void refresh()
      // restored under a different id here (another account's file, or the same photo was already on the entry)
      if (e.result.id !== e.record.id) void patchEntryMediaId(e.record.entryId, e.record.id, e.result.id).catch(() => {})
    })
    const online = () => photoQueue.retryNow()
    window.addEventListener('online', online)
    return () => {
      unsub()
      window.removeEventListener('online', online)
    }
  }, [userId, refresh])

  useEffect(() => {
    if (!userId || preview.active) return
    const run = () => void syncAll(syncDeps, userId).catch(() => {})
    run()
    window.addEventListener('online', run)
    return () => window.removeEventListener('online', run)
  }, [userId])
  return (
    <OrganizeProvider>
      <Outlet />
    </OrganizeProvider>
  )
}
