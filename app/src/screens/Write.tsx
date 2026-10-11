import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { chaptersFor } from '../lib/organize'
import { Editor } from '../editor/Editor'
import { useEntrySession, useSessionState } from '../editor/useEntrySession'
import { EMPTY_DOC, countWords, docToText, localDate, trackOf, type EntryContent } from '../lib/entries'
import type { Track } from '../lib/organize'
import { EntryMeta } from '../editor/EntryMeta'
import { useOrganize } from '../organize'
import { STATUS_TEXT } from '../lib/sync'
import { writeState } from '../lib/account'
import { findTodaysEntry } from '../lib/today'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(y, m - 1, d),
  )
}

/** /write: open today's entry, or start one. /write/new: always start one. */
export function WriteToday({ fresh = false }: { fresh?: boolean }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (!session) return
    let cancelled = false
    ;(async () => {
      const existing = fresh ? null : await findTodaysEntry(session.user.id)
      if (cancelled) return
      if (existing) navigate(`/write/${existing}`, { replace: true })
      else navigate(`/write/${crypto.randomUUID()}`, { replace: true, state: { isNew: true } })
    })()
    return () => {
      cancelled = true
    }
  }, [session, fresh, navigate])
  return <p className="sr-only" role="status">Opening today's page…</p>
}

export function Write() {
  const { id = '' } = useParams()
  const location = useLocation()
  const { session: auth, profile, license } = useAuth()
  const isNew = !!(location.state as { isNew?: boolean } | null)?.isNew
  const userId = auth!.user.id
  const lang = profile?.default_language ?? 'en'
  const { tracks, templates, chapters } = useOrganize()
  const defaultTrack = tracks[0]?.id ?? null

  const blank = useCallback(
    (): EntryContent => ({
      id, entry_date: localDate(), title: '', body_rich: EMPTY_DOC, body_text: '', language: lang, word_count: 0,
      track_id: defaultTrack, fields: {}, tag_ids: [],
    }),
    [id, lang, defaultTrack],
  )
  const { session, error } = useEntrySession(id, userId, blank, isNew)
  useSessionState(session)

  const state = writeState(license)
  // The server decides; this only avoids inviting typing that can't be saved.
  const editable = !!session && !session.unavailable && state !== 'readonly' && !(state === 'grace' && session.status === 'idle')

  const [title, setTitle] = useState('')
  const [titleVersion, setTitleVersion] = useState(-1)
  if (session && titleVersion !== session.remoteVersion) {
    setTitle(session.content.title)
    setTitleVersion(session.remoteVersion)
  }

  const onChange = useMemo(
    () => (doc: { body_rich: unknown; body_text: string }) =>
      session?.change({ ...doc, word_count: countWords(doc.body_text) }),
    [session],
  )
  const onBlur = useCallback(() => void session?.flush(), [session])

  /** Switching track on a page that is still blank (or still just the old template) swaps in the new template. */
  const onTrack = (t: Track) => {
    if (!session) return
    const c = session.content
    const prev = tracks.find((x) => x.id === trackOf(c))
    const prevTpl = templates.find((x) => x.id === prev?.default_template_id)
    const untouched = !c.body_text.trim() || (!!prevTpl && c.body_text === docToText(prevTpl.body_rich))
    const tpl = templates.find((x) => x.id === t.default_template_id)
    if (untouched && (tpl || prevTpl)) {
      const body_rich = tpl ? tpl.body_rich : EMPTY_DOC
      const body_text = tpl ? docToText(tpl.body_rich) : ''
      session.replaceContent({ track_id: t.id, body_rich, body_text, word_count: countWords(body_text) })
    } else {
      session.change({ track_id: t.id })
    }
  }

  if (!UUID.test(id)) return <Navigate to="/write" replace />
  if (error) return <div className="screen"><p className="screen-sub">Couldn't open this entry. Your words are safe on this device.</p></div>
  if (!session) return <p className="sr-only" role="status">Opening…</p>

  const c = session.content
  const chapterNames = chaptersFor(c.entry_date, chapters).map((x) => x.name)
  const trialLine =
    state === 'readonly'
      ? 'Your trial has ended. You can still read and export everything. Unlock Daftar for $49, once, to keep writing.'
      : state === 'grace' && session.status === 'idle'
        ? 'Your trial has ended, so new entries are paused. You can still finish anything already started, and read and export everything.'
        : null

  return (
    <div className="screen write">
      <article className="page" aria-label="Journal page">
        <header className="page-head">
          <h1 className="page-date">{formatDate(c.entry_date)}</h1>
          <input
            className="page-title"
            dir="auto"
            placeholder="Untitled"
            aria-label="Title"
            value={title}
            readOnly={!editable}
            onChange={(e) => {
              setTitle(e.target.value)
              session.change({ title: e.target.value })
            }}
            onBlur={onBlur}
          />
          <EntryMeta
            content={c}
            editable={editable}
            onTrack={onTrack}
            onLanguage={(language) => session.change({ language })}
            onTags={(tag_ids) => session.change({ tag_ids })}
            onFields={(fields) => session.change({ fields })}
          />
          {chapterNames.length > 0 && <p className="meta chapter-line">{chapterNames.join(' · ')}</p>}
        </header>
        <p className="save-status" role="status" aria-live="polite">
          {session.unavailable
            ? "This entry isn't on this device yet. Connect to open it."
            : trialLine ?? STATUS_TEXT[session.status]}
          {session.note && <span className="save-note"> {session.note}</span>}
        </p>
        {!session.unavailable && (
          <Editor
            key={session.id}
            content={c.body_rich}
            contentVersion={session.remoteVersion}
            editable={editable}
            onChange={onChange}
            onBlur={onBlur}
          />
        )}
        <div className="write-foot">
          <span>{c.word_count} {c.word_count === 1 ? 'word' : 'words'}</span>
          <Link className="btn btn-quiet" to="/write/new">
            New entry
          </Link>
        </div>
      </article>
    </div>
  )
}
