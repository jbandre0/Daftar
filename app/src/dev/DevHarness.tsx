/**
 * Development only (never in a production build): the real Write screen, editor, IndexedDB buffer,
 * BroadcastChannel and Web Locks, against a simulated save_entry() kept in localStorage.
 * Lets autosave be exercised in a browser without signing in: /dev/write/<uuid>
 */
import { useMemo, useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { AuthContext, type AuthState } from '../auth'
import { SyncDepsContext } from '../lib/depsContext'
import { syncDeps } from '../lib/syncDeps'
import { OfflineError, type EntryContent, type EntryRow, type SaveResult } from '../lib/entries'
import { sameContent, type SyncDeps } from '../lib/sync'
import { Write } from '../screens/Write'

const SERVER = 'daftar.dev.server'
const OFFLINE = 'daftar.dev.offline'
type Row = { content: EntryContent; revision: number; updated_at: string }
type Db = { rows: Record<string, Row>; versions: { id: string; content: unknown; at: string }[] }

const readDb = (): Db => JSON.parse(localStorage.getItem(SERVER) ?? '{"rows":{},"versions":[]}')
const writeDb = (db: Db) => localStorage.setItem(SERVER, JSON.stringify(db))
const isOffline = () => localStorage.getItem(OFFLINE) === '1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const devDeps: SyncDeps = {
  ...syncDeps,
  isOnline: () => !isOffline(),
  async save(content, base, displaced): Promise<SaveResult> {
    await sleep(120)
    if (isOffline()) throw new OfflineError('dev offline')
    const db = readDb()
    const cur = db.rows[content.id]
    let conflict = false
    let revision = 1
    const now = new Date().toISOString()
    if (cur) {
      if (sameContent(cur.content, content) && displaced.length === 0) {
        return { id: content.id, revision: cur.revision, updated_at: cur.updated_at, conflict: false, created: false }
      }
      if (cur.revision !== base) {
        db.versions.push({ id: content.id, content: cur.content, at: now })
        conflict = true
      }
      revision = cur.revision + 1
    }
    for (const d of displaced) {
      db.versions.push({ id: content.id, content: d, at: now })
      conflict = true
    }
    db.rows[content.id] = { content, revision, updated_at: now }
    writeDb(db)
    return { id: content.id, revision, updated_at: now, conflict, created: !cur }
  },
  async fetch(id): Promise<EntryRow | null> {
    await sleep(60)
    if (isOffline()) throw new OfflineError('dev offline')
    const r = readDb().rows[id]
    return r ? { ...r.content, revision: r.revision, updated_at: r.updated_at, created_at: r.updated_at, deleted_at: null } : null
  },
}

const fakeAuth: AuthState = {
  session: { user: { id: 'dev-user', email: 'dev@localhost' } } as unknown as Session,
  profile: { id: 'dev-user', display_name: 'Dev', timezone: 'UTC', default_language: 'en', last_export_at: null, storage_bytes_used: 0 },
  license: null,
  refresh: async () => {},
  signOut: async () => {},
}

function Bar() {
  const [offline, setOffline] = useState(isOffline())
  const [, tick] = useState(0)
  const db = readDb()
  return (
    <div className="dev-bar" role="region" aria-label="Development controls">
      <strong>Dev harness</strong>
      <button
        className="btn btn-quiet"
        data-testid="toggle-offline"
        onClick={() => {
          localStorage.setItem(OFFLINE, offline ? '0' : '1')
          setOffline(!offline)
          if (offline) window.dispatchEvent(new Event('online'))
        }}
      >
        Simulated server: {offline ? 'OFFLINE' : 'online'}
      </button>
      <button className="btn btn-quiet" onClick={() => tick((n) => n + 1)}>
        Refresh
      </button>
      <span data-testid="server-state">
        {Object.entries(db.rows).map(([id, r]) => `${id.slice(0, 8)} r${r.revision}: "${r.content.body_text}"`).join(' | ') || 'server empty'}
        {' · versions: '}
        {db.versions.length}
      </span>
    </div>
  )
}

export default function DevHarness() {
  const deps = useMemo(() => devDeps, [])
  return (
    <AuthContext.Provider value={fakeAuth}>
      <SyncDepsContext.Provider value={deps}>
        <Bar />
        <Routes>
          <Route path="write/:id" element={<Write />} />
        </Routes>
      </SyncDepsContext.Provider>
    </AuthContext.Provider>
  )
}
