import { idbDraftStore } from './draftStore'
import { fetchEntry, saveEntryRemote } from './entries'
import { DEFAULT_TIMING, type Rescue, type RescueStore, type SyncDeps, type SyncMessage } from './sync'

const RESCUE_PREFIX = 'daftar.rescue.'

const localRescue: RescueStore = {
  get(id) {
    try {
      const raw = localStorage.getItem(RESCUE_PREFIX + id)
      return raw ? (JSON.parse(raw) as Rescue) : undefined
    } catch {
      return undefined
    }
  },
  put(r) {
    try {
      localStorage.setItem(RESCUE_PREFIX + r.id, JSON.stringify(r))
    } catch {
      /* quota or private mode: IndexedDB still holds everything up to the last 500 ms */
    }
  },
  del(id) {
    try {
      localStorage.removeItem(RESCUE_PREFIX + id)
    } catch {
      /* ignore */
    }
  },
  all() {
    const out: Rescue[] = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(RESCUE_PREFIX)) {
          const r = localRescue.get(k.slice(RESCUE_PREFIX.length))
          if (r) out.push(r)
        }
      }
    } catch {
      /* ignore */
    }
    return out
  },
}

function makeChannel(): SyncDeps['channel'] {
  const listeners = new Set<(m: SyncMessage) => void>()
  let bc: BroadcastChannel | null = null
  try {
    bc = new BroadcastChannel('daftar-sync')
    bc.onmessage = (e) => listeners.forEach((fn) => fn(e.data as SyncMessage))
  } catch {
    bc = null // very old browsers: tabs fall back to draft-level conflict protection
  }
  return {
    post: (m) => bc?.postMessage(m),
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

const localLocks = new Map<string, Promise<unknown>>()
function lock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(name, fn) as Promise<T>
  }
  const prev = localLocks.get(name) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  localLocks.set(name, next.catch(() => {}))
  return next
}

export const syncDeps: SyncDeps = {
  store: idbDraftStore(),
  rescue: localRescue,
  save: saveEntryRemote,
  fetch: fetchEntry,
  channel: makeChannel(),
  lock,
  isOnline: () => navigator.onLine,
  tabId: crypto.randomUUID(),
  timing: DEFAULT_TIMING,
  now: () => Date.now(),
}
