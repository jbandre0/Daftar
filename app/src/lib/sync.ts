/**
 * Never lose text. The autosave engine (spec §7, "Never lose text").
 *
 *   keystroke ──500 ms idle──▶ IndexedDB draft ──2 s idle / 5 s max──▶ save_entry() on the server
 *                                   │                                       │
 *                         other tabs see it (BroadcastChannel)       draft cleared only after
 *                                                                    the server confirms that seq
 *
 * Rules that keep text safe:
 * - The IndexedDB draft is the shared source of truth for unconfirmed text. Every tab writes into it in
 *   one atomic transaction, and every save sends what is in it (never a tab's possibly stale memory).
 *   After the server confirms, the record stays as a clean copy (seq === savedSeq) holding the confirmed
 *   revision, so the next keystroke always builds on the right base. Clean copies are pruned after a week.
 * - Saves for one entry are serialised across tabs with a Web Lock.
 * - A tab whose text was not derived from the latest draft never silently replaces it: the replaced
 *   text travels to the server as a "displaced" snapshot and is kept in entry_versions.
 * - If another device saved in between, the server keeps its copy in entry_versions (save_entry).
 * - On pagehide the unwritten tail goes to localStorage synchronously ("rescue"), because an
 *   IndexedDB transaction started while the page is dying may never commit.
 */
import { DELETE, type Draft, type DraftStore } from './draftStore'

export const CLEAN_DRAFT_TTL_MS = 7 * 24 * 3600 * 1000
import { OfflineError, SealRejectedError, WriteBlockedError, type EntryContent, type EntryRow, type SaveResult } from './entries'
import { markKnownSealed } from './seal'

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'local' | 'failed' | 'blocked' | 'sealed'

export const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: '',
  pending: 'Saving…',
  saving: 'Saving…',
  saved: 'Saved',
  local: "Saved on this device. Will sync when you're back online.",
  failed: "Couldn't reach the server. Your words are safe on this device.",
  blocked: 'Saved on this device. Writing is paused on this account, so it will sync when you unlock Daftar.',
  sealed: "This letter is sealed, so this copy can't be changed.",
}

export const CONFLICT_NOTE = 'This entry was also edited elsewhere. The other version is kept.'

export type SyncMessage =
  | { t: 'draft'; id: string; seq: number; content: EntryContent; tab: string }
  | { t: 'saved'; id: string; seq: number; revision: number; conflict: boolean; tab: string }

export type Rescue = { id: string; userId: string; content: EntryContent; basedOnSeq: number; revision: number; at: number }

export interface RescueStore {
  get(id: string): Rescue | undefined
  put(r: Rescue): void
  del(id: string): void
  all(): Rescue[]
}

export type Timing = {
  localMs: number
  /** Even during non-stop typing, the device copy is never older than this (covers a crash or kill). */
  localMaxMs: number
  idleMs: number
  maxWaitMs: number
  retryBaseMs: number
  retryMaxMs: number
}
export const DEFAULT_TIMING: Timing = { localMs: 500, localMaxMs: 1000, idleMs: 2000, maxWaitMs: 5000, retryBaseMs: 2000, retryMaxMs: 60000 }

export type SyncDeps = {
  store: DraftStore
  rescue: RescueStore
  save: (content: EntryContent, baseRevision: number, displaced: EntryContent[]) => Promise<SaveResult>
  fetch: (id: string) => Promise<EntryRow | null>
  channel: { post(msg: SyncMessage): void; subscribe(fn: (msg: SyncMessage) => void): () => void }
  lock: <T>(name: string, fn: () => Promise<T>) => Promise<T>
  isOnline: () => boolean
  tabId: string
  timing: Timing
  now: () => number
}

// ---------------------------------------------------------------------------------------------------------------

const sortedTags = (c: EntryContent) => [...(c.tag_ids ?? [])].sort().join(',')

export function sameContent(a: EntryContent, b: EntryContent): boolean {
  return (
    !!a.is_letter === !!b.is_letter &&
    (a.letter_to ?? null) === (b.letter_to ?? null) &&
    !!a.sealed === !!b.sealed &&
    (a.unlock_at ?? null) === (b.unlock_at ?? null) &&
    (a.track_id ?? null) === (b.track_id ?? null) &&
    JSON.stringify(a.fields ?? {}) === JSON.stringify(b.fields ?? {}) &&
    sortedTags(a) === sortedTags(b) &&
    a.title === b.title &&
    a.body_text === b.body_text &&
    a.entry_date === b.entry_date &&
    a.language === b.language &&
    JSON.stringify(a.body_rich) === JSON.stringify(b.body_rich)
  )
}

/**
 * Write `content` into the shared draft. `basedOnSeq` is the draft seq this text was derived from;
 * if the draft has moved on since (another tab wrote), the draft's text is kept as displaced.
 */
export async function writeContent(
  deps: Pick<SyncDeps, 'store' | 'now'>,
  id: string,
  userId: string,
  content: EntryContent,
  basedOnSeq: number,
  revisionIfFresh: number,
): Promise<Draft> {
  const next = await deps.store.mutate(id, (cur) => {
    if (!cur || cur.userId !== userId) {
      return {
        id, userId, content, seq: basedOnSeq + 1, savedSeq: basedOnSeq, baseRevision: revisionIfFresh,
        displaced: [], updatedAt: deps.now(),
      }
    }
    const lostUpdate = cur.seq !== basedOnSeq && !sameContent(cur.content, content)
    return {
      ...cur,
      content,
      seq: cur.seq + 1,
      displaced: lostUpdate ? [...cur.displaced, cur.content] : cur.displaced,
      updatedAt: deps.now(),
    }
  })
  return next!
}

export type PushResult = { kind: 'clean' } | { kind: 'saved'; seq: number; result: SaveResult }

/** Send the shared draft for `id` to the server, if it has unconfirmed text. Serialised across tabs. */
export function pushDraft(deps: SyncDeps, id: string, userId: string): Promise<PushResult> {
  return deps.lock(`daftar-save:${id}`, async () => {
    const d = await deps.store.get(id)
    if (!d || d.userId !== userId || d.seq <= d.savedSeq) return { kind: 'clean' } as const
    const sent = d.displaced.length
    const result = await deps.save(d.content, d.baseRevision, d.displaced)
    await deps.store.mutate(id, (cur) => {
      if (!cur) return undefined
      return { ...cur, savedSeq: d.seq, baseRevision: result.revision, displaced: cur.displaced.slice(sent) }
    })
    deps.channel.post({ t: 'saved', id, seq: d.seq, revision: result.revision, conflict: result.conflict, tab: deps.tabId })
    return { kind: 'saved', seq: d.seq, result } as const
  })
}

/** On app open (and when the network returns): fold in rescued text, then push every unsynced draft. */
export async function syncAll(deps: SyncDeps, userId: string): Promise<{ pushed: number; waiting: number; blocked: boolean }> {
  for (const r of deps.rescue.all()) {
    if (r.userId !== userId) continue
    await writeContent(deps, r.id, userId, r.content, r.basedOnSeq, r.revision)
    deps.rescue.del(r.id)
  }
  let pushed = 0
  let waiting = 0
  let blocked = false
  for (const d of await deps.store.all()) {
    if (d.userId !== userId) continue
    if (d.seq <= d.savedSeq) {
      if (deps.now() - d.updatedAt > CLEAN_DRAFT_TTL_MS) {
        await deps.store.mutate(d.id, (cur) => (cur && cur.seq <= cur.savedSeq && cur.seq === d.seq ? DELETE : undefined))
      }
      continue
    }
    try {
      const r = await pushDraft(deps, d.id, userId)
      if (r.kind === 'saved') pushed++
    } catch (e) {
      waiting++
      if (e instanceof WriteBlockedError) blocked = true
      if (e instanceof SealRejectedError && e.reason === 'sealed') markKnownSealed(d.id)
    }
  }
  return { pushed, waiting, blocked }
}

export async function unsyncedDrafts(deps: Pick<SyncDeps, 'store'>, userId: string): Promise<Draft[]> {
  return (await deps.store.all()).filter((d) => d.userId === userId && d.seq > d.savedSeq)
}

// ---------------------------------------------------------------------------------------------------------------

type Listener = () => void

/** One open entry in one tab. */
export class EntrySession {
  content: EntryContent
  status: SaveStatus = 'idle'
  note: string | null = null
  /** Set when the entry exists on the server but couldn't be loaded (offline, no local copy). */
  unavailable = false
  /** Why the last save was refused as a seal problem ('sealed' = changed elsewhere; 'date' = not a future day). */
  sealRejection: 'sealed' | 'date' | null = null
  /** Bumped when another tab's text replaced ours, so the editor knows to reload. */
  remoteVersion = 0
  /** Bumped on every change to anything except the body (title, track, language, tags, fields), so React re-renders controlled inputs. */
  metaVersion = 0

  private basedOnSeq = 0
  private revision = 0
  private memVersion = 0
  private writtenVersion = 0
  private writeChain: Promise<unknown> = Promise.resolve()
  private saving = false
  private saveAgain = false
  private retries = 0
  private closed = false
  private timers: Record<'local' | 'localMax' | 'idle' | 'max' | 'retry', ReturnType<typeof setTimeout> | null> = {
    local: null, localMax: null, idle: null, max: null, retry: null,
  }
  private listeners = new Set<Listener>()
  private unsubscribe: () => void

  private constructor(
    readonly id: string,
    readonly userId: string,
    private deps: SyncDeps,
    initial: EntryContent,
  ) {
    this.content = initial
    this.unsubscribe = deps.channel.subscribe((m) => this.onMessage(m))
  }

  /**
   * Open an entry: local draft first (instant, works offline), else the server row, else a blank page
   * from `blank()` (a brand-new entry). Rescued text from a tab that died is folded in on top.
   */
  static async open(deps: SyncDeps, id: string, userId: string, blank: () => EntryContent, isNew = false): Promise<EntrySession> {
    const draft = await deps.store.get(id)
    let s: EntrySession

    if (draft && draft.userId === userId) {
      s = new EntrySession(id, userId, deps, draft.content)
      s.basedOnSeq = draft.seq
      s.revision = draft.baseRevision
      s.status = draft.seq > draft.savedSeq ? 'pending' : 'saved'
      if (draft.seq <= draft.savedSeq) {
        // A clean local copy: another device may have saved since. Prefer the server's newer text.
        const row = await deps.fetch(id).catch(() => null)
        if (row && row.revision > draft.baseRevision) {
          const adopted = await deps.store.mutate(id, (cur) =>
            cur && cur.seq === draft.seq && cur.seq <= cur.savedSeq
              ? { ...cur, content: toContent(row), baseRevision: row.revision, updatedAt: deps.now() }
              : undefined,
          )
          if (adopted && adopted.seq === draft.seq) {
            s.content = adopted.content
            s.revision = adopted.baseRevision
          }
        }
      }
    } else {
      let row: EntryRow | null = null
      let unavailable = false
      if (!isNew) {
        try {
          row = await deps.fetch(id)
        } catch {
          unavailable = true
        }
      }
      s = new EntrySession(id, userId, deps, row ? toContent(row) : blank())
      s.revision = row?.revision ?? 0
      s.status = row ? 'saved' : 'idle'
      s.unavailable = unavailable && !deps.rescue.get(id)
    }

    const rescued = deps.rescue.get(id)
    if (rescued && rescued.userId === userId) {
      await writeContent(deps, id, userId, rescued.content, rescued.basedOnSeq, rescued.revision)
      deps.rescue.del(id)
      const d = await deps.store.get(id)
      if (d) {
        s.content = d.content
        s.basedOnSeq = d.seq
        s.revision = d.baseRevision
        s.unavailable = false
      }
    }

    if (s.status === 'pending' || rescued) s.scheduleSave(0) // push unsynced text first
    return s
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }

  private setStatus(st: SaveStatus) {
    if (this.status !== st) {
      this.status = st
      this.emit()
    }
  }

  get dirty() {
    return this.memVersion !== this.writtenVersion
  }

  /** The editor calls this on every change. */
  change(patch: Partial<EntryContent>) {
    if (this.closed) return
    const next = { ...this.content, ...patch, id: this.id }
    if (sameContent(next, this.content)) return // not a real edit (e.g. editor re-init); never create a draft for it
    this.content = next
    if (Object.keys(patch).some((k) => k !== 'body_rich' && k !== 'body_text' && k !== 'word_count')) {
      this.metaVersion++
      this.emit()
    }
    this.memVersion++
    this.unavailable = false
    this.setStatus('pending')
    this.clear('local')
    this.timers.local = setTimeout(() => void this.writeLocal(), this.deps.timing.localMs)
    if (!this.timers.localMax) this.timers.localMax = setTimeout(() => void this.writeLocal(), this.deps.timing.localMaxMs)
    this.scheduleSave(this.deps.timing.idleMs)
    if (!this.timers.max) this.timers.max = setTimeout(() => void this.saveNow(), this.deps.timing.maxWaitMs)
  }

  /**
   * Apply a change that replaces the editor's content (a template): same as change(), but the editor
   * is told to reload from `content`.
   */
  replaceContent(patch: Partial<EntryContent>) {
    this.change(patch)
    this.remoteVersion++
    this.emit()
  }

  /** Blur, tab hidden, route change: write and save right away. */
  async flush(): Promise<void> {
    await this.writeLocal() // even if a save is already in flight, the tail reaches IndexedDB now
    await this.saveNow()
  }

  /** pagehide: the only thing guaranteed to finish is a synchronous write. */
  rescueNow() {
    if (!this.dirty) return
    this.deps.rescue.put({
      id: this.id, userId: this.userId, content: this.content, basedOnSeq: this.basedOnSeq,
      revision: this.revision, at: this.deps.now(),
    })
  }

  /** Network back, licence changed, or the user asked: try again now. */
  retry() {
    this.retries = 0
    this.clear('retry')
    void this.saveNow()
  }

  async close() {
    if (this.closed) return
    await this.flush().catch(() => {})
    this.closed = true
    for (const k of Object.keys(this.timers) as (keyof typeof this.timers)[]) this.clear(k)
    this.unsubscribe()
    this.listeners.clear()
  }

  // ---- internals ----------------------------------------------------------------------------------------------

  private clear(k: keyof EntrySession['timers']) {
    if (this.timers[k]) clearTimeout(this.timers[k]!)
    this.timers[k] = null
  }

  private scheduleSave(ms: number) {
    if (this.closed) return
    this.clear('idle')
    this.timers.idle = setTimeout(() => void this.saveNow(), ms)
  }

  /** Memory → IndexedDB. Serialised within the tab. */
  private writeLocal(): Promise<void> {
    const run = async () => {
      this.clear('local')
      this.clear('localMax')
      if (!this.dirty) return
      const v = this.memVersion
      const content = this.content
      const d = await writeContent(this.deps, this.id, this.userId, content, this.basedOnSeq, this.revision)
      this.basedOnSeq = d.seq
      this.writtenVersion = v
      this.deps.rescue.del(this.id)
      this.deps.channel.post({ t: 'draft', id: this.id, seq: d.seq, content, tab: this.deps.tabId })
      if (!this.deps.isOnline() && this.status !== 'blocked') this.setStatus('local')
    }
    const p = this.writeChain.then(run, run)
    this.writeChain = p.catch(() => {})
    return p
  }

  private async saveNow(): Promise<void> {
    if (this.closed) return
    if (this.saving) {
      this.saveAgain = true
      return
    }
    this.clear('idle')
    this.clear('max')
    this.clear('retry')
    this.saving = true
    try {
      await this.writeLocal()
      if (this.status === 'pending') this.setStatus('saving')
      const r = await pushDraft(this.deps, this.id, this.userId)
      this.retries = 0
      if (r.kind === 'saved') {
        if (r.seq === this.basedOnSeq) this.revision = r.result.revision
        if (r.result.conflict) this.note = CONFLICT_NOTE
      }
      const stillDirty = this.dirty || (r.kind === 'saved' && r.seq < this.basedOnSeq)
      this.setStatus(stillDirty ? 'pending' : 'saved')
      if (stillDirty) this.scheduleSave(this.deps.timing.idleMs)
      this.emit()
    } catch (e) {
      if (e instanceof SealRejectedError) {
        // sealed elsewhere (or a bad date): retrying can't help, and what was typed stays on this device
        if (e.reason === 'sealed') markKnownSealed(this.id)
        this.sealRejection = e.reason
        this.setStatus('sealed')
      } else if (e instanceof WriteBlockedError) {
        this.setStatus('blocked') // waits for retry(): unlock, or next app open
      } else {
        this.setStatus(e instanceof OfflineError || !this.deps.isOnline() ? 'local' : 'failed')
        const t = this.deps.timing
        const delay = Math.min(t.retryMaxMs, t.retryBaseMs * 2 ** this.retries++)
        this.timers.retry = setTimeout(() => void this.saveNow(), delay)
      }
    } finally {
      this.saving = false
      if (this.saveAgain && !this.closed) {
        this.saveAgain = false
        void this.saveNow()
      }
    }
  }

  private onMessage(m: SyncMessage) {
    if (m.id !== this.id || m.tab === this.deps.tabId || this.closed) return
    if (m.t === 'draft') {
      if (m.seq <= this.basedOnSeq) return
      // Unwritten local keystrokes win here; when they're written, the other tab's text is displaced, not lost.
      if (this.dirty) return
      this.content = m.content
      this.basedOnSeq = m.seq
      this.remoteVersion++
      // Not on the server yet. The writing tab normally saves it; if that tab dies, this one will.
      this.status = this.status === 'blocked' ? 'blocked' : this.deps.isOnline() ? 'pending' : 'local'
      this.scheduleSave(this.deps.timing.idleMs * 2)
      this.emit()
    } else {
      if (m.seq === this.basedOnSeq) {
        this.revision = m.revision
        if (!this.dirty && this.status !== 'blocked') this.setStatus('saved')
      }
      if (m.conflict) {
        this.note = CONFLICT_NOTE
        this.emit()
      }
    }
  }
}

function toContent(row: EntryRow): EntryContent {
  return {
    id: row.id,
    entry_date: row.entry_date,
    title: row.title ?? '',
    body_rich: row.body_rich,
    body_text: row.body_text,
    language: row.language,
    word_count: row.word_count,
    track_id: row.track_id ?? null,
    fields: row.fields ?? {},
    tag_ids: row.tag_ids ?? [],
    is_letter: row.is_letter ?? false,
    letter_to: row.letter_to ?? null,
    sealed: row.sealed ?? false,
    unlock_at: row.unlock_at ?? null,
  }
}
