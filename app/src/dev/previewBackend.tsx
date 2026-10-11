/**
 * DEV ONLY (loaded behind `import.meta.env.DEV`, so it is not in production builds).
 *
 * Preview mode: open `http://localhost:5173/?preview=1` and the whole real app runs on sample data with a
 * fixed signed-in user, no Supabase. The real editor, IndexedDB buffer, BroadcastChannel and Web Locks are
 * all live; only the server is simulated, in localStorage, using the same rules as save_entry().
 * Leave with `/?preview=0`.
 */
import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { preview } from '../lib/preview'
import { syncDeps } from '../lib/syncDeps'
import { OfflineError, localDate, type EntryContent, type EntryRow, type EntrySummary, type SaveResult } from '../lib/entries'
import { sameContent } from '../lib/sync'
import { matchesFilters, makeSnippet, PAGE_SIZE, type BrowseFilters, type BrowseRow, type DayEntry } from '../lib/browse'
import type { Organize } from '../lib/organize'
import type { AuthState } from '../auth'
import { README, FORMAT, SCHEMA_VERSION, APP_VERSION } from '../lib/vault'
import { createStore, get as idbGet, set as idbSet } from 'idb-keyval'
import { PhotoRetry, PhotoRejected, photoPath, type PhotoBackend } from '../lib/photoQueue'
import type { MediaApi, MediaRow } from '../lib/photoRuntime'
import { sha256Hex } from '../lib/photos'

const SERVER = 'daftar.preview.server'
const OFFLINE = 'daftar.preview.offline'
const FLAG = 'daftar.preview'
const SEED_VERSION = '3'
const SEED_KEY = 'daftar.preview.seed'

type Row = { content: EntryContent; revision: number; updated_at: string; created_at: string }
type SimMedia = { id: string; entry_id: string; path: string; bytes: number; sha256: string; width: number; height: number; created_at: string }
type Db = { rows: Record<string, Row>; versions: { id: string; entry_id: string; content: unknown; at: string }[]; media?: SimMedia[] }

const readDb = (): Db => JSON.parse(localStorage.getItem(SERVER) ?? '{"rows":{},"versions":[]}')
const writeDb = (db: Db) => localStorage.setItem(SERVER, JSON.stringify(db))
const isOffline = () => localStorage.getItem(OFFLINE) === '1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- sample data ------------------------------------------------------------------------------------------------

const SPIRITUAL_TPL = '00000000-0000-4000-8000-0000000000e1'
const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDate(d)
}

const organize: Organize = {
  tracks: [
    { id: 'tr-daily', name: 'Daily', slug: 'daily', color_token: 'flame', default_template_id: null, sort_order: 1, is_builtin: true },
    { id: 'tr-spiritual', name: 'Spiritual', slug: 'spiritual', color_token: 'olive', default_template_id: SPIRITUAL_TPL, sort_order: 2, is_builtin: true },
    { id: 'tr-letters', name: 'Letters', slug: 'letters', color_token: 'seal', default_template_id: null, sort_order: 3, is_builtin: true },
    { id: 'tr-dreams', name: 'Dreams', slug: 'dreams', color_token: 'ash-soft', default_template_id: null, sort_order: 4, is_builtin: true },
  ],
  tags: [
    { id: 'tag-family', name: 'family' },
    { id: 'tag-mosque', name: 'مسجد' },
    { id: 'tag-travel', name: 'travel' },
  ],
  chapters: [
    { id: 'ch-junior', name: 'Junior year', description: 'Back at school', start_date: daysAgo(40), end_date: null, color_token: 'olive' },
    { id: 'ch-summer', name: 'Summer', description: '', start_date: daysAgo(130), end_date: daysAgo(41), color_token: 'flame' },
  ],
  templates: [
    {
      id: SPIRITUAL_TPL,
      name: 'Spiritual',
      body_rich: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'What I noticed' }] },
          { type: 'paragraph' },
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Impressions' }] },
          { type: 'paragraph' },
        ],
      },
    },
  ],
}

const doc = (paras: string[]) => ({
  type: 'doc',
  content: paras.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
})

function sample(
  n: number, daysBack: number, title: string, paras: string[],
  extra: Partial<EntryContent> = {},
): [string, Row] {
  const id = `00000000-0000-4000-8000-${String(900 + n).padStart(12, '0')}`
  const text = paras.join('\n\n')
  const when = new Date(Date.now() - daysBack * 86_400_000).toISOString()
  return [id, {
    revision: 1, updated_at: when, created_at: when,
    content: {
      id, entry_date: daysAgo(daysBack), title, body_rich: doc(paras), body_text: text, language: 'en',
      word_count: text.split(/\s+/).length, track_id: 'tr-daily', fields: {}, tag_ids: [], ...extra,
    },
  }]
}

function seed() {
  if (localStorage.getItem(SERVER) && localStorage.getItem(SEED_KEY) === SEED_VERSION) return
  localStorage.setItem(SEED_KEY, SEED_VERSION)
  const rows = Object.fromEntries([
    sample(1, 1, 'Morning by the window', [
      'Read Alma 32 this morning. The seed comparison landed differently today, slower and warmer than I remembered.',
      'الحمد لله على كل حال. كتبت هذه الفقرة بالعربية داخل صفحة إنجليزية.',
    ], { track_id: 'tr-spiritual', tag_ids: ['tag-mosque'], fields: { scripture: 'Alma 32', answered_later: false } }),
    sample(2, 3, 'Fireworks', ['Loud, bright, and my little cousin covered his ears the whole time and still refused to leave.'], { tag_ids: ['tag-family'] }),
    sample(3, 5, '', ['A dream about a lighthouse that kept turning toward me no matter which way I walked on the shore.'], { track_id: 'tr-dreams' }),
    sample(4, 9, 'To me, at graduation', ['Open this when you walk. You were more afraid than you let on, and it turned out fine.'], { track_id: 'tr-letters' }),
    sample(5, 16, 'عن الصبر', ['الصبر ليس انتظارًا فقط، بل هو كيف نتصرف أثناء الانتظار.'], { language: 'ar' }),
    sample(6, 38, 'The long road home', [
      'We left before sunrise and the fields were still grey. Dad drove, I mostly watched the light arrive.',
      'Somewhere past the second town the radio gave up and we just talked, the way you only can in a car.',
    ], { tag_ids: ['tag-travel', 'tag-family'] }),
    sample(7, 70, 'First week of summer', ['Slow mornings. The garden finally did something.']),
    sample(8, 2, '', ['Short one. Tired, but the good kind. The walk home smelled like rain before it rained.']),
    sample(9, 2, 'Evening notes', ['Called grandma. She told the lentil soup story again and I did not mind at all.'], { tag_ids: ['tag-family'] }),
    sample(10, 6, 'Patience', ['Trying to practise patience this week. It is mostly noticing how quickly I reach for my phone.'], { track_id: 'tr-spiritual', fields: { scripture: 'James 1:4' } }),
    sample(11, 7, 'Market day', ['Bought far too many oranges. Argued about the price, lost, was happy anyway.'], { tag_ids: ['tag-travel'] }),
    sample(12, 12, 'الدعاء', ['اللهم اجعل هذا اليوم خيرًا من الأمس. جلست بعد الفجر أفكر في كل ما مضى.'], { language: 'ar', track_id: 'tr-spiritual', tag_ids: ['tag-mosque'] }),
    sample(13, 19, 'A dream, again', ['The lighthouse again, but this time someone was inside waving.'], { track_id: 'tr-dreams' }),
    sample(14, 23, 'Quiet', ['Nothing much. Read, cooked, slept early.']),
    sample(15, 27, 'Letters I will not send', ['Dear you, the thing I wanted to say was simple, and it took me a month to find the words.'], { track_id: 'tr-letters' }),
    sample(16, 45, 'Back to school', ['First day. The campus smelled like cut grass and photocopier toner.']),
    sample(17, 52, 'Lake day', ['Cold water, warm rocks, the kind of afternoon that rearranges your week.'], { tag_ids: ['tag-travel', 'tag-family'] }),
    sample(18, 60, 'عن الأسرة', ['جلسنا كلنا حول المائدة وضحكنا حتى نسينا الوقت.'], { language: 'ar', tag_ids: ['tag-family'] }),
    sample(19, 90, 'Midsummer', ['Longest day of the year. I stayed outside until the last light went.']),
    sample(20, 110, 'Packing', ['Boxes everywhere. Found the letter from my grandmother at the bottom of one.'], { tag_ids: ['tag-family'] }),
  ])
  writeDb({ rows, versions: [] })
}

// ---- simulated server -------------------------------------------------------------------------------------------

async function save(content: EntryContent, base: number, displaced: EntryContent[]): Promise<SaveResult> {
  await sleep(150)
  if (isOffline()) throw new OfflineError('preview offline')
  const db = readDb()
  const cur = db.rows[content.id]
  const now = new Date().toISOString()
  let conflict = false
  let revision = 1
  if (cur) {
    if (sameContent(cur.content, content) && displaced.length === 0) {
      return { id: content.id, revision: cur.revision, updated_at: cur.updated_at, conflict: false, created: false }
    }
    if (cur.revision !== base) {
      db.versions.push({ id: crypto.randomUUID(), entry_id: content.id, content: cur.content, at: now })
      conflict = true
    }
    revision = cur.revision + 1
  }
  for (const d of displaced) {
    db.versions.push({ id: crypto.randomUUID(), entry_id: content.id, content: d, at: now })
    conflict = true
  }
  db.rows[content.id] = { content, revision, updated_at: now, created_at: cur?.created_at ?? now }
  writeDb(db)
  return { id: content.id, revision, updated_at: now, conflict, created: !cur }
}

async function fetchEntry(id: string): Promise<EntryRow | null> {
  await sleep(60)
  if (isOffline()) throw new OfflineError('preview offline')
  const r = readDb().rows[id]
  return r ? { ...r.content, revision: r.revision, updated_at: r.updated_at, created_at: r.created_at, deleted_at: null } : null
}

const summary = (r: Row): EntrySummary => ({
  id: r.content.id, entry_date: r.content.entry_date, title: r.content.title, body_text: r.content.body_text,
  word_count: r.content.word_count, updated_at: r.updated_at,
})

const allRows = () => Object.values(readDb().rows)

// ---- photos: a simulated Storage bucket (IndexedDB) and media table ----------------------------------------------

const blobs = createStore('daftar-preview', 'blobs')
const urlFor = new Map<string, string>()

const photoBackend: PhotoBackend & MediaApi = {
  async upload(path, blob) {
    await sleep(350)
    if (isOffline()) throw new PhotoRetry('preview offline')
    await idbSet(path, blob, blobs)
  },
  async register(a) {
    await sleep(200)
    if (isOffline()) throw new PhotoRetry('preview offline')
    const db = readDb()
    const entry = db.rows[a.entryId]
    if (!entry) throw new PhotoRetry('entry_not_found') // the text hasn't been saved yet
    const media = (db.media ??= [])
    const same = media.find((m) => m.entry_id === a.entryId && m.sha256 === a.sha256)
    if (same) return { id: same.id, duplicate: true, remapped: same.id !== a.id }
    if (media.some((m) => m.id === a.id)) return { id: a.id, duplicate: true, remapped: false }
    if (media.filter((m) => m.entry_id === a.entryId).length >= 12) throw new PhotoRejected('limit', 'photo_limit')
    const path = photoPath('preview-user', a.entryId, a.id) // where the queue uploaded it, exactly as the real server expects
    const blob = await idbGet<Blob>(path, blobs)
    if (!blob) throw new PhotoRetry('upload_missing')
    media.push({ id: a.id, entry_id: a.entryId, path, bytes: blob.size, sha256: a.sha256, width: a.width, height: a.height, created_at: new Date().toISOString() })
    writeDb(db)
    return { id: a.id, duplicate: false, remapped: false }
  },
  async listMedia(entryId) {
    return (readDb().media ?? []).filter((m) => m.entry_id === entryId).map(toRow)
  },
  async listMediaMany(ids) {
    return (readDb().media ?? []).filter((m) => ids.includes(m.entry_id)).map(toRow)
  },
  async signedUrls(paths) {
    const out: Record<string, string> = {}
    for (const p of paths) {
      if (!urlFor.has(p)) {
        const b = await idbGet<Blob>(p, blobs)
        if (b) urlFor.set(p, URL.createObjectURL(b))
      }
      const u = urlFor.get(p)
      if (u) out[p] = u
    }
    return out
  },
  async softDelete(id) {
    const db = readDb()
    db.media = (db.media ?? []).filter((m) => m.id !== id)
    writeDb(db)
  },
}
const toRow = (m: SimMedia): MediaRow => ({ id: m.id, entry_id: m.entry_id, storage_path: m.path, thumb_path: null, width: m.width, height: m.height, bytes: m.bytes, sha256: m.sha256 })

/** Paint a small landscape (sky, sun, hills) so the sample journal has photos to show. */
async function samplePhoto(hue: number): Promise<Blob> {
  const W = 1600, H = 1067
  const c = new OffscreenCanvas(W, H)
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, `hsl(${hue}, 55%, 62%)`)
  sky.addColorStop(0.55, `hsl(${hue + 18}, 70%, 78%)`)
  sky.addColorStop(1, `hsl(${hue + 30}, 80%, 86%)`)
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)
  g.fillStyle = 'rgba(255, 244, 214, 0.95)'
  g.beginPath()
  g.arc(W * 0.7, H * 0.42, 90, 0, Math.PI * 2)
  g.fill()
  const hills = [['#7b5b3a', 0.62], ['#5d4630', 0.72], ['#3b2c1f', 0.84]] as const
  hills.forEach(([col, base], i) => {
    g.fillStyle = col
    g.beginPath()
    g.moveTo(0, H)
    for (let x = 0; x <= W; x += 20) g.lineTo(x, H * base + Math.sin(x / (170 - i * 30) + i * 2) * (46 - i * 8) + Math.sin(x / 61 + i) * 9)
    g.lineTo(W, H)
    g.fill()
  })
  return c.convertToBlob({ type: 'image/webp', quality: 0.8 })
}

async function seedPhotos() {
  if (localStorage.getItem('daftar.preview.photos') === SEED_VERSION) return
  const db = readDb()
  const media: SimMedia[] = (db.media = [])
  const put = async (entryId: string, n: number, hue: number) => {
    const row = db.rows[entryId]
    if (!row) return
    const blob = await samplePhoto(hue)
    const id = `00000000-0000-4000-8000-0000000c${String(n).padStart(4, '0')}`
    const path = photoPath('preview-user', entryId, id)
    await idbSet(path, blob, blobs)
    media.push({ id, entry_id: entryId, path, bytes: blob.size, sha256: await sha256Hex(blob), width: 1600, height: 1067, created_at: row.created_at })
    const doc = row.content.body_rich as { content: unknown[] }
    doc.content.splice(1, 0, { type: 'photo', attrs: { mediaId: id, width: 1600, height: 1067 } })
  }
  await put('00000000-0000-4000-8000-000000000901', 1, 28)
  await put('00000000-0000-4000-8000-000000000906', 2, 205)
  await put('00000000-0000-4000-8000-000000000906', 3, 345)
  writeDb(db)
  localStorage.setItem('daftar.preview.photos', SEED_VERSION)
}

// ---- the badge -------------------------------------------------------------------------------------------------

function Badge() {
  const [offline, setOffline] = useState(isOffline())
  return (
    <div className="preview-badge" role="region" aria-label="Preview mode">
      <span>Preview · sample data</span>
      <button
        onClick={() => {
          localStorage.setItem(OFFLINE, offline ? '0' : '1')
          setOffline(!offline)
          if (offline) window.dispatchEvent(new Event('online'))
        }}
        aria-pressed={offline}
      >
        {offline ? 'Offline' : 'Online'}
      </button>
      <button
        onClick={() => {
          localStorage.removeItem(SERVER)
          localStorage.removeItem('daftar.preview.photos')
          sessionStorage.removeItem(FLAG)
          location.href = '/?preview=1'
        }}
      >
        Reset
      </button>
    </div>
  )
}

// ---- install ---------------------------------------------------------------------------------------------------

export async function maybeInstallPreview() {
  const q = new URLSearchParams(location.search).get('preview')
  if (q === '0') sessionStorage.removeItem(FLAG)
  if (q === '1') sessionStorage.setItem(FLAG, '1')
  if (sessionStorage.getItem(FLAG) !== '1') return

  seed()
  await seedPhotos()
  const auth: AuthState = {
    session: { user: { id: 'preview-user', email: 'you@example.com' } } as unknown as Session,
    profile: {
      id: 'preview-user', display_name: 'Justin', timezone: 'UTC', default_language: 'en',
      last_export_at: new Date(Date.now() - 12 * 86_400_000).toISOString(),
      // dev only: /?preview=1&used=2147400000 pretends the account is almost full (to see the cap message)
      storage_bytes_used: Number(new URLSearchParams(location.search).get('used') ?? 184_233_000),
      created_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
    },
    license: {
      user_id: 'preview-user', trial_started_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      trial_ends_at: new Date(Date.now() + 12 * 86_400_000).toISOString(), status: 'trial', unlocked_at: null,
    },
    refresh: async () => {},
    signOut: async () => {
      sessionStorage.removeItem(FLAG)
      location.href = '/?preview=0'
    },
  }

  Object.assign(syncDeps, { save, fetch: fetchEntry, isOnline: () => !isOffline() })
  Object.assign(preview, {
    active: true,
    photos: photoBackend,
    auth,
    organize,
    Badge,
    recent: async (limit: number) =>
      allRows().map(summary).sort((a, b) => (b.entry_date + b.updated_at).localeCompare(a.entry_date + a.updated_at)).slice(0, limit),
    range: async (start: string, end: string | null) =>
      allRows().map(summary).filter((e) => e.entry_date >= start && (!end || e.entry_date <= end)).sort((a, b) => b.entry_date.localeCompare(a.entry_date)),
    browse: async (f: BrowseFilters, offset: number) => {
      await sleep(120)
      const all = allRows()
        .filter((r) => matchesFilters(r.content, f))
        .map((r): BrowseRow => ({
          id: r.content.id, entry_date: r.content.entry_date, title: r.content.title || null, snippet: makeSnippet(r.content.body_text, f.q),
          word_count: r.content.word_count, updated_at: r.updated_at, track_id: r.content.track_id ?? null, language: r.content.language,
          tag_ids: r.content.tag_ids ?? [],
        }))
        .sort((a, b) => (b.entry_date + b.updated_at).localeCompare(a.entry_date + a.updated_at))
      return { rows: all.slice(offset, offset + PAGE_SIZE), total: all.length }
    },
    monthDays: async (start: string, end: string) => {
      const out: Record<string, number> = {}
      for (const r of allRows()) {
        const d = r.content.entry_date
        if (d >= start && d <= end) out[d] = (out[d] ?? 0) + 1
      }
      return out
    },
    allDates: async () => [...new Set(allRows().map((r) => r.content.entry_date))].sort(),
    day: async (date: string): Promise<DayEntry[]> =>
      allRows()
        .filter((r) => r.content.entry_date === date)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => ({
          id: r.content.id, entry_date: date, title: r.content.title, body_rich: r.content.body_rich, body_text: r.content.body_text,
          language: r.content.language, word_count: r.content.word_count, track_id: r.content.track_id ?? null, tag_ids: r.content.tag_ids ?? [],
        })),
    remoteToday: async (today: string) => {
      const r = allRows().filter((x) => x.content.entry_date === today).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
      return r ? { id: r.content.id, updated_at: r.updated_at } : null
    },
    rpc: async (fn: string) => {
      if (fn !== 'export_journal') throw new Error("Restore isn't available in preview mode. It runs against the real server.")
      const db = readDb()
      void README, FORMAT, SCHEMA_VERSION, APP_VERSION
      return {
        account: { display_name: 'Justin', timezone: 'UTC', default_language: 'en' },
        tracks: organize.tracks.map((t) => ({ ...t, hidden: false, updated_at: new Date().toISOString() })),
        tags: organize.tags.map((t) => ({ ...t, updated_at: new Date().toISOString() })),
        chapters: organize.chapters.map((c) => ({ ...c, updated_at: new Date().toISOString() })),
        entries: Object.values(db.rows).map((r) => ({
          id: r.content.id, entry_date: r.content.entry_date, title: r.content.title, track_id: r.content.track_id ?? null,
          tag_ids: r.content.tag_ids ?? [], language: r.content.language, body_text: r.content.body_text, body_rich: r.content.body_rich,
          word_count: r.content.word_count, fields: r.content.fields ?? {}, letter: null,
          media: (db.media ?? []).filter((m) => m.entry_id === r.content.id).map((m) => ({ id: m.id, mime: 'image/webp', width: m.width, height: m.height, bytes: m.bytes, sha256: m.sha256, file: `media/${r.content.id.slice(0, 8)}/${m.id}.webp` })),
          created_at: r.created_at, updated_at: r.updated_at,
        })),
        entry_versions: [],
      }
    },
  })
}
