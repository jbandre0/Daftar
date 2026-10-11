import { afterEach, describe, expect, it } from 'vitest'
import { idbDraftStore } from './draftStore'
import { OfflineError, WriteBlockedError, type EntryContent, type EntryRow, type SaveResult } from './entries'
import {
  CONFLICT_NOTE, EntrySession, sameContent, syncAll, unsyncedDrafts,
  type Rescue, type RescueStore, type SyncDeps, type SyncMessage,
} from './sync'

// ---- test doubles -------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return
    await sleep(5)
  }
  throw new Error('timed out waiting')
}

/** Mirrors save_entry() in supabase/migrations/0003_save_entry.sql. */
class FakeServer {
  rows = new Map<string, { content: EntryContent; revision: number }>()
  versions: { id: string; content: EntryContent }[] = []
  offline = false
  blocked = false
  loseNextResponse = false
  calls = 0
  latency = 3

  save = async (content: EntryContent, base: number, displaced: EntryContent[]): Promise<SaveResult> => {
    await sleep(this.latency)
    this.calls++
    if (this.offline) throw new OfflineError('offline')
    if (this.blocked) throw new WriteBlockedError('paused')
    const cur = this.rows.get(content.id)
    let conflict = false
    let revision = 1
    if (cur) {
      if (sameContent(cur.content, content) && displaced.length === 0) {
        return { id: content.id, revision: cur.revision, updated_at: '', conflict: false, created: false }
      }
      if (cur.revision !== base) {
        this.versions.push({ id: content.id, content: cur.content })
        conflict = true
      }
      revision = cur.revision + 1
    }
    this.rows.set(content.id, { content: structuredClone(content), revision })
    for (const d of displaced) {
      this.versions.push({ id: content.id, content: d })
      conflict = true
    }
    if (this.loseNextResponse) {
      this.loseNextResponse = false
      throw new OfflineError('response lost after commit')
    }
    return { id: content.id, revision, updated_at: '', conflict, created: !cur }
  }

  fetch = async (id: string): Promise<EntryRow | null> => {
    await sleep(2)
    if (this.offline) throw new OfflineError('offline')
    const r = this.rows.get(id)
    return r ? { ...structuredClone(r.content), revision: r.revision, updated_at: '', created_at: '', deleted_at: null } : null
  }

  /** Another device saves directly. */
  externalEdit(id: string, body: string) {
    const cur = this.rows.get(id)!
    this.rows.set(id, { content: { ...cur.content, body_text: body }, revision: cur.revision + 1 })
  }
}

class MemRescue implements RescueStore {
  m = new Map<string, Rescue>()
  get = (id: string) => this.m.get(id)
  put = (r: Rescue) => void this.m.set(r.id, structuredClone(r))
  del = (id: string) => void this.m.delete(id)
  all = () => [...this.m.values()]
}

/** One "browser profile": shared IndexedDB, localStorage, locks and broadcast bus; many tabs. */
function makeBrowser(server: FakeServer) {
  const store = idbDraftStore(`daftar-test-${Math.random()}`)
  const rescue = new MemRescue()
  const subs = new Map<string, (m: SyncMessage) => void>()
  const deaf = new Set<string>()
  const locks = new Map<string, Promise<unknown>>()
  let online = true

  const lock = <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(name) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    locks.set(name, next.catch(() => {}))
    return next
  }

  function tab(tabId: string): SyncDeps {
    return {
      store, rescue, lock, tabId,
      save: server.save,
      fetch: server.fetch,
      isOnline: () => online,
      now: () => Date.now(),
      timing: { localMs: 10, localMaxMs: 25, idleMs: 30, maxWaitMs: 80, retryBaseMs: 20, retryMaxMs: 80 },
      channel: {
        post(msg) {
          for (const [id, fn] of subs) {
            if (id.startsWith(tabId + ':') || deaf.has(id.split(':')[0])) continue
            const copy = structuredClone(msg)
            queueMicrotask(() => fn(copy))
          }
        },
        subscribe(fn) {
          const key = `${tabId}:${Math.random()}`
          subs.set(key, fn)
          return () => subs.delete(key)
        },
      },
    }
  }
  return { store, rescue, tab, deafen: (t: string) => deaf.add(t), setOnline: (v: boolean) => { online = v } }
}

const USER = 'user-a'
let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
const blank = (id: string) => (): EntryContent => ({
  id, entry_date: '2026-10-11', title: '', body_rich: { type: 'doc' }, body_text: '', language: 'en', word_count: 0,
})
/** Simulates typing: one change per word, a few ms apart. */
async function type(s: EntrySession, words: string[], gap = 4) {
  for (const w of words) {
    const text = (s.content.body_text ? s.content.body_text + ' ' : '') + w
    s.change({ body_text: text, body_rich: { type: 'doc', text } })
    await sleep(gap)
  }
}

const open: EntrySession[] = []
async function session(deps: SyncDeps, id: string, isNew = false) {
  const s = await EntrySession.open(deps, id, USER, blank(id), isNew)
  open.push(s)
  return s
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {})
})

// ---- tests ---------------------------------------------------------------------------------------------------

describe('autosave', () => {
  it('saves after the writer pauses and reports Saved', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['Read', 'Alma', '32', 'this', 'morning.'])
    await waitFor(() => s.status === 'saved')
    expect(server.rows.get(id)?.content.body_text).toBe('Read Alma 32 this morning.')
    expect(await unsyncedDrafts(b.tab('t1'), USER)).toHaveLength(0)
  })

  it('saves at least every maxWait during continuous typing', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`)
    const typing = type(s, words, 6) // ~240 ms, never idle for 30 ms
    await sleep(150)
    expect(server.rows.get(id)?.content.body_text.length ?? 0).toBeGreaterThan(0)
    await typing
    await waitFor(() => s.status === 'saved')
    expect(server.rows.get(id)!.content.body_text).toBe(words.join(' '))
  })

  it('keeps typing that happens while a save is in flight', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['one', 'two'])
    const flushing = s.flush()
    await type(s, ['three', 'four'], 1)
    await flushing
    await waitFor(() => s.status === 'saved')
    expect(server.rows.get(id)!.content.body_text).toBe('one two three four')
  })
})

describe('no phantom entries', () => {
  it('a change event with identical content creates no draft and no save', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    s.change({ body_text: '', title: '' })
    await sleep(100)
    expect(await b.store.get(id)).toBeUndefined()
    expect(server.calls).toBe(0)
  })
})

describe('hard kill (no pagehide)', () => {
  it('during non-stop offline typing the device copy is never more than localMaxMs behind', async () => {
    const server = new FakeServer()
    server.offline = true
    const b = makeBrowser(server)
    b.setOnline(false)
    const id = newId()
    const deps = b.tab('t1')
    deps.timing = { ...deps.timing, maxWaitMs: 10_000, idleMs: 10_000 } // only the local timers can help
    const s = await session(deps, id, true)
    const words = Array.from({ length: 30 }, (_, i) => `k${i}`)
    await type(s, words, 5) // never pauses for localMs, never reaches maxWaitMs
    const d = await b.store.get(id) // the tab is killed now: no rescue, no flush
    const stored = d?.content.body_text.split(' ').length ?? 0
    expect(stored).toBeGreaterThanOrEqual(words.length - 6) // at most ~25 ms of words missing
  })
})

describe('metadata changes', () => {
  it('every title/track/tag/fields change notifies subscribers, even while the status stays pending', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    let emits = 0
    s.subscribe(() => emits++)
    s.change({ fields: { scripture: 'A' } })
    const afterFirst = emits
    s.change({ fields: { scripture: 'Al' } })
    s.change({ fields: { scripture: 'Alm' } })
    expect(emits).toBeGreaterThanOrEqual(afterFirst + 2) // inputs stay in step with what was typed
    expect(s.content.fields).toEqual({ scripture: 'Alm' })
  })

  it('tags, track and fields travel with the save and survive a reload', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    s.change({ track_id: 'track-1', tag_ids: ['t1', 't2'], fields: { scripture: 'Alma 32', answered_later: true } })
    await s.flush()
    await waitFor(() => s.status === 'saved')
    const row = server.rows.get(id)!.content
    expect([row.track_id, row.tag_ids, row.fields]).toEqual(['track-1', ['t1', 't2'], { scripture: 'Alma 32', answered_later: true }])
    await s.close()
    const s2 = await session(b.tab('t2'), id)
    expect(s2.content.tag_ids).toEqual(['t1', 't2'])
  })

  it('drafts saved before phase 3 (no track/fields/tags) still open and compare equal to defaults', () => {
    const old = { id: 'x', entry_date: '2026-10-01', title: '', body_rich: {}, body_text: '', language: 'en', word_count: 0 }
    expect(sameContent(old, { ...old, track_id: null, fields: {}, tag_ids: [] })).toBe(true)
    expect(sameContent(old, { ...old, tag_ids: ['a'] })).toBe(false)
  })
})

describe('flush', () => {
  it('writes the unsaved tail to the device immediately, even while a slow save is in flight', async () => {
    const server = new FakeServer()
    server.latency = 200
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['first'])
    void s.flush() // slow save now in flight
    await sleep(20)
    await type(s, ['tail', 'words'], 0)
    await s.flush() // e.g. the tab is being hidden
    const d = await b.store.get(id)
    expect(d?.content.body_text).toBe('first tail words')
  })
})

describe('offline and failures', () => {
  it('pull the network mid-sentence, close the tab, reopen: every word is there', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s1 = await session(b.tab('t1'), id, true)
    await type(s1, ['Online', 'part.'])
    await waitFor(() => s1.status === 'saved')

    server.offline = true
    b.setOnline(false)
    await type(s1, ['Offline', 'half', 'of', 'a'])
    await waitFor(() => s1.status === 'local')
    await type(s1, ['sentence'], 0)
    s1.rescueNow() // pagehide fires; the last word hasn't reached IndexedDB yet
    // the tab dies here: no close(), no flush
    open.splice(open.indexOf(s1), 1)

    server.offline = false
    b.setOnline(true)
    const s2 = await session(b.tab('t2'), id)
    expect(s2.content.body_text).toBe('Online part. Offline half of a sentence')
    await waitFor(() => s2.status === 'saved')
    expect(server.rows.get(id)!.content.body_text).toBe('Online part. Offline half of a sentence')
  })

  it('retries with backoff and syncs when the network returns', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    server.offline = true
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['written', 'offline'])
    await waitFor(() => s.status === 'local')
    const callsWhileOffline = server.calls
    await sleep(120)
    expect(server.calls).toBeGreaterThan(callsWhileOffline) // it kept retrying
    server.offline = false
    await waitFor(() => s.status === 'saved', 1000)
    expect(server.rows.get(id)!.content.body_text).toBe('written offline')
  })

  it('a lost response after the server committed does not create a false conflict', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    server.loseNextResponse = true
    await type(s, ['hello'])
    await waitFor(() => s.status === 'saved')
    expect(server.versions).toHaveLength(0)
    expect(s.note).toBeNull()
    await type(s, ['again'])
    await waitFor(() => s.status === 'saved')
    expect(server.rows.get(id)!.content.body_text).toBe('hello again')
    expect(server.versions).toHaveLength(0)
  })

  it('trial over: text stays on the device, then syncs on unlock', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    server.blocked = true
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['past', 'the', 'grace', 'window'])
    await waitFor(() => s.status === 'blocked')
    expect(await unsyncedDrafts(b.tab('t1'), USER)).toHaveLength(1)
    server.blocked = false
    s.retry()
    await waitFor(() => s.status === 'saved')
    expect(server.rows.get(id)!.content.body_text).toBe('past the grace window')
  })

  it('on app open, unsynced drafts from an earlier session are pushed first', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    server.offline = true
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['from', 'yesterday'])
    await waitFor(() => s.status === 'local')
    await s.close()
    server.offline = false
    const r = await syncAll(b.tab('t2'), USER)
    expect(r.pushed).toBe(1)
    expect(server.rows.get(id)!.content.body_text).toBe('from yesterday')
  })
})

describe('two tabs, one entry', () => {
  it('edits flow between tabs and nothing is lost', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const a = await session(b.tab('A'), id, true)
    await type(a, ['from', 'A.'])
    await a.flush()
    const t2 = await session(b.tab('B'), id)
    expect(t2.content.body_text).toBe('from A.')
    await type(t2, ['then', 'B.'])
    await t2.flush()
    await waitFor(() => a.content.body_text === 'from A. then B.')
    await type(a, ['A', 'again.'])
    await a.flush()
    await waitFor(() => t2.content.body_text === 'from A. then B. A again.')
    expect(server.rows.get(id)!.content.body_text).toBe('from A. then B. A again.')
    expect(server.versions).toHaveLength(0) // no false conflicts
  })

  it('a stale tab that missed updates displaces nothing silently: the other text is kept as a version', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const a = await session(b.tab('A'), id, true)
    await type(a, ['shared', 'start.'])
    await a.flush()
    const stale = await session(b.tab('S'), id)
    b.deafen('S') // e.g. a frozen background tab
    await type(a, ['Important', 'words', 'from', 'A.'])
    await a.flush()
    await type(stale, ['stale', 'tab', 'typing.'])
    await stale.flush()
    await waitFor(() => stale.status === 'saved')
    const kept = [...server.versions.map((v) => v.content.body_text), server.rows.get(id)!.content.body_text]
    expect(kept).toContain('shared start. Important words from A.')
    expect(kept).toContain('shared start. stale tab typing.')
    expect(stale.note).toBe(CONFLICT_NOTE)
  })

  it('saves are serialised: two tabs flushing at once send one save each at most', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const a = await session(b.tab('A'), id, true)
    await type(a, ['x'])
    await a.flush()
    const c = await session(b.tab('C'), id)
    await type(a, ['y'])
    await Promise.all([a.flush(), c.flush()])
    expect(server.rows.get(id)!.content.body_text).toBe('x y')
    expect(server.versions).toHaveLength(0)
  })
})

describe('writer tab dies', () => {
  it('the other open tab shows the text as unsynced and pushes it', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const a = await session(b.tab('A'), id, true)
    await type(a, ['base'])
    await a.flush()
    const other = await session(b.tab('O'), id)
    server.offline = true
    b.setOnline(false)
    await type(a, ['written', 'then', 'killed'])
    await waitFor(async () => (await b.store.get(id))?.content.body_text === 'base written then killed')
    open.splice(open.indexOf(a), 1) // A is killed: no close()
    ;(a as unknown as { closed: boolean }).closed = true
    await waitFor(() => other.content.body_text === 'base written then killed')
    expect(other.status).toBe('local')
    server.offline = false
    b.setOnline(true)
    other.retry()
    await waitFor(() => other.status === 'saved')
    expect(server.rows.get(id)!.content.body_text).toBe('base written then killed')
  })
})

describe('cross-tab save lock', () => {
  it('a second tab saving during the first tab’s slow save does not raise a false conflict', async () => {
    const server = new FakeServer()
    server.latency = 60
    const b = makeBrowser(server)
    const id = newId()
    const a = await session(b.tab('A'), id, true)
    const c = await session(b.tab('C'), id, true)
    await type(a, ['one'])
    const aSave = a.flush() // A's save of seq 1 is in flight for 60 ms
    await sleep(15)
    await type(a, ['two'], 0)
    await sleep(15) // A's local write (seq 2) lands
    await c.flush() // C pushes the shared draft while A's save is still running
    await aSave
    await waitFor(() => a.status === 'saved')
    expect(server.rows.get(id)!.content.body_text).toBe('one two')
    expect(server.versions).toHaveLength(0)
    expect(a.note).toBeNull()
    expect(c.note).toBeNull()
  })
})

describe('other devices', () => {
  it('a save over another device’s newer edit keeps that edit as a version and says so', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['laptop'])
    await waitFor(() => s.status === 'saved')
    server.externalEdit(id, 'laptop + phone')
    await type(s, ['more'])
    await waitFor(() => s.status === 'saved')
    expect(server.versions.map((v) => v.content.body_text)).toContain('laptop + phone')
    expect(s.note).toBe(CONFLICT_NOTE)
  })

  it('reopening prefers the server’s newer text over a clean local copy', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    const s = await session(b.tab('t1'), id, true)
    await type(s, ['old'])
    await waitFor(() => s.status === 'saved')
    await s.close()
    server.externalEdit(id, 'newer from phone')
    const s2 = await session(b.tab('t2'), id)
    expect(s2.content.body_text).toBe('newer from phone')
    await type(s2, ['and', 'more'])
    await waitFor(() => s2.status === 'saved')
    expect(server.versions).toHaveLength(0)
    expect(server.rows.get(id)!.content.body_text).toBe('newer from phone and more')
  })

  it('offline with no local copy: the entry is marked unavailable rather than shown blank', async () => {
    const server = new FakeServer()
    const b = makeBrowser(server)
    const id = newId()
    server.rows.set(id, { content: { ...blank(id)(), body_text: 'on server' }, revision: 3 })
    server.offline = true
    const s = await session(b.tab('t1'), id)
    expect(s.unavailable).toBe(true)
  })
})
