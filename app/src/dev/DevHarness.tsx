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
import { Chapters, ChapterDetail } from '../screens/Chapters'
import { Settings } from '../screens/Settings'
import { OrganizeCtx, type OrganizeValue } from '../organize'
import { docToText } from '../lib/entries'

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

const SPIRITUAL_TPL = '00000000-0000-4000-8000-0000000000e1'
const fakeOrganize: OrganizeValue = {
  tracks: [
    { id: 'tr-daily', name: 'Daily', slug: 'daily', color_token: 'flame', default_template_id: null, sort_order: 1, is_builtin: true },
    { id: 'tr-spirit', name: 'Spiritual', slug: 'spiritual', color_token: 'olive', default_template_id: SPIRITUAL_TPL, sort_order: 2, is_builtin: true },
    { id: 'tr-letters', name: 'Letters', slug: 'letters', color_token: 'seal', default_template_id: null, sort_order: 3, is_builtin: true },
  ],
  tags: [{ id: 'tag-family', name: 'family' }, { id: 'tag-mosque', name: 'مسجد' }],
  chapters: [{ id: 'ch-1', name: 'Junior year', description: '', start_date: '2026-09-01', end_date: null, color_token: 'olive' }],
  templates: [{
    id: SPIRITUAL_TPL, name: 'Spiritual',
    body_rich: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'What I noticed' }] }, { type: 'paragraph' },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Impressions' }] }, { type: 'paragraph' },
    ] },
  }],
  refresh: async () => {},
}
void docToText

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
        <OrganizeCtx.Provider value={fakeOrganize}>
          <Bar />
          <Routes>
            <Route path="write/:id" element={<Write />} />
            <Route path="chapters" element={<Chapters />} />
            <Route path="chapters/:id" element={<ChapterDetail />} />
            <Route path="settings" element={<Settings />} />
          </Routes>
        </OrganizeCtx.Provider>
      </SyncDepsContext.Provider>
    </AuthContext.Provider>
  )
}
