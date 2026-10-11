import { useEffect, useState, useSyncExternalStore } from 'react'
import { EntrySession } from '../lib/sync'
import { useSyncDeps } from '../lib/depsContext'
import type { EntryContent } from '../lib/entries'

/**
 * Opens one entry for editing and wires the flush points from the spec:
 * blur (the editor calls flush), tab hidden, pagehide, route change (unmount), network back.
 */
export function useEntrySession(id: string, userId: string, blank: () => EntryContent, isNew: boolean) {
  const deps = useSyncDeps()
  const [session, setSession] = useState<EntrySession | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let s: EntrySession | null = null
    setSession(null)
    setError(null)

    EntrySession.open(deps, id, userId, blank, isNew).then(
      (opened) => {
        if (cancelled) {
          void opened.close()
          return
        }
        s = opened
        setSession(opened)
      },
      (e) => !cancelled && setError(String(e)),
    )

    const onHidden = () => {
      if (document.visibilityState === 'hidden' && s) {
        s.rescueNow()
        void s.flush()
      }
    }
    const onPageHide = () => {
      if (s) {
        s.rescueNow()
        void s.flush()
      }
    }
    const onOnline = () => s?.retry()

    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('online', onOnline)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      if (s) {
        s.rescueNow()
        void s.close() // route change: flush
      }
    }
    // blank is only used for brand-new entries; its identity must not reopen the session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps, id, userId, isNew])

  return { session, error }
}

/** Re-render when the session's status, note or remote content changes. */
export function useSessionState(session: EntrySession | null) {
  return useSyncExternalStore(
    (fn) => (session ? session.subscribe(fn) : () => {}),
    () => (session ? `${session.status}|${session.note ?? ''}|${session.remoteVersion}|${session.unavailable}` : ''),
  )
}
