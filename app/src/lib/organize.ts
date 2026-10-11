import { supabase } from './supabase'

export type Track = {
  id: string
  name: string
  slug: string
  color_token: string
  default_template_id: string | null
  sort_order: number
  is_builtin: boolean
}
export type Tag = { id: string; name: string }
export type Chapter = {
  id: string
  name: string
  description: string
  start_date: string
  end_date: string | null
  color_token: string
}
export type Template = { id: string; name: string; body_rich: unknown }

export type Organize = { tracks: Track[]; tags: Tag[]; chapters: Chapter[]; templates: Template[] }

export const EMPTY: Organize = { tracks: [], tags: [], chapters: [], templates: [] }

/** Colour tokens a track or chapter may use (all exist in both themes). */
export const COLOR_TOKENS = ['flame', 'olive', 'seal', 'ash-soft'] as const

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'Arabic' },
  { code: 'ur', label: 'Urdu' },
  { code: 'fa', label: 'Persian' },
  { code: 'he', label: 'Hebrew' },
  { code: 'tr', label: 'Turkish' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'hi', label: 'Hindi' },
  { code: 'sw', label: 'Swahili' },
]
export const languageLabel = (code: string) => LANGUAGES.find((l) => l.code === code)?.label ?? code.toUpperCase()

const CACHE = 'daftar.organize.'

export function cachedOrganize(userId: string): Organize {
  try {
    const raw = localStorage.getItem(CACHE + userId)
    if (raw) return { ...EMPTY, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return EMPTY
}

function cache(userId: string, o: Organize) {
  try {
    localStorage.setItem(CACHE + userId, JSON.stringify(o))
  } catch {
    /* ignore */
  }
}

export async function loadOrganize(userId: string): Promise<Organize> {
  const [tracks, tags, chapters, templates] = await Promise.all([
    supabase.from('tracks').select('id, name, slug, color_token, default_template_id, sort_order, is_builtin').is('deleted_at', null).order('sort_order').order('name'),
    supabase.from('tags').select('id, name').is('deleted_at', null).order('name'),
    supabase.from('chapters').select('id, name, description, start_date, end_date, color_token').is('deleted_at', null).order('start_date', { ascending: false }),
    supabase.from('templates').select('id, name, body_rich').is('deleted_at', null),
  ])
  const err = tracks.error ?? tags.error ?? chapters.error ?? templates.error
  if (err) throw err
  const o: Organize = {
    tracks: tracks.data as Track[],
    tags: tags.data as Tag[],
    chapters: chapters.data as Chapter[],
    templates: templates.data as Template[],
  }
  cache(userId, o)
  return o
}

export const slugify = (name: string) =>
  name.trim().toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'track'

/** An entry is in a chapter when its date falls inside the range. Chapters are not joined to entries. */
export function inChapter(entryDate: string, c: Pick<Chapter, 'start_date' | 'end_date'>): boolean {
  return entryDate >= c.start_date && (c.end_date === null || entryDate <= c.end_date)
}

export function chaptersFor(entryDate: string, chapters: Chapter[]): Chapter[] {
  return chapters.filter((c) => inChapter(entryDate, c))
}

// ---- writes (online only; they are small, and the server enforces the trial) ---------------------------------

export class DuplicateError extends Error {}

function check(error: { code?: string; message: string } | null) {
  if (!error) return
  if (error.code === '23505') throw new DuplicateError(error.message)
  throw error
}

export async function createTrack(userId: string, name: string, color: string, sort: number) {
  const slug = slugify(name)
  const { data, error } = await supabase
    .from('tracks')
    .insert({ user_id: userId, name: name.trim(), slug: `${slug}-${Math.random().toString(36).slice(2, 6)}`, color_token: color, sort_order: sort })
    .select('id, name, slug, color_token, default_template_id, sort_order, is_builtin')
    .single()
  check(error)
  return data as Track
}

export async function updateTrack(id: string, patch: Partial<Pick<Track, 'name' | 'color_token'>>) {
  check((await supabase.from('tracks').update(patch).eq('id', id)).error)
}

export async function archiveTrack(id: string) {
  check((await supabase.from('tracks').update({ deleted_at: new Date().toISOString() }).eq('id', id)).error)
}

export async function createTag(userId: string, name: string): Promise<Tag> {
  const clean = name.trim().replace(/^#/, '')
  const { data, error } = await supabase
    .from('tags')
    .insert({ id: crypto.randomUUID(), user_id: userId, name: clean })
    .select('id, name')
    .single()
  check(error)
  return data as Tag
}

export async function renameTag(id: string, name: string) {
  check((await supabase.from('tags').update({ name: name.trim() }).eq('id', id)).error)
}

export async function deleteTag(id: string) {
  check((await supabase.from('tags').update({ deleted_at: new Date().toISOString() }).eq('id', id)).error)
}

export type ChapterInput = Omit<Chapter, 'id'>

export async function createChapter(userId: string, c: ChapterInput): Promise<Chapter> {
  const { data, error } = await supabase
    .from('chapters')
    .insert({ user_id: userId, ...c })
    .select('id, name, description, start_date, end_date, color_token')
    .single()
  check(error)
  return data as Chapter
}

export async function updateChapter(id: string, c: Partial<ChapterInput>) {
  check((await supabase.from('chapters').update(c).eq('id', id)).error)
}

export async function deleteChapter(id: string) {
  check((await supabase.from('chapters').update({ deleted_at: new Date().toISOString() }).eq('id', id)).error)
}

export async function setDefaultLanguage(userId: string, code: string) {
  check((await supabase.from('profiles').update({ default_language: code }).eq('id', userId)).error)
}
