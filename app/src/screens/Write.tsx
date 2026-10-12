import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { chaptersFor } from '../lib/organize'
import { Editor } from '../editor/Editor'
import { useEntrySession, useSessionState } from '../editor/useEntrySession'
import { EMPTY_DOC, countWords, docToText, localDate, trackOf, type EntryContent } from '../lib/entries'
import type { Track } from '../lib/organize'
import { EntryMeta } from '../editor/EntryMeta'
import { LetterPanel } from '../editor/LetterPanel'
import { SealedCard } from '../components/Seal'
import { isSealedNow, unlockInstant } from '../lib/seal'
import { useOrganize } from '../organize'
import { STATUS_TEXT } from '../lib/sync'
import { writeState } from '../lib/account'
import { findTodaysEntry } from '../lib/today'
import { photoQueue } from '../lib/photoRuntime'
import type { PromptHandoff } from '../components/PromptDie'

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
  const location = useLocation()
  const letter = new URLSearchParams(location.search).get('letter') === '1'
  const prompt = (location.state as { prompt?: PromptHandoff } | null)?.prompt ?? null
  useEffect(() => {
    if (!session) return
    let cancelled = false
    ;(async () => {
      const existing = fresh || letter ? null : await findTodaysEntry(session.user.id)
      if (cancelled) return
      if (existing) navigate(`/write/${existing}`, { replace: true })
      else navigate(`/write/${crypto.randomUUID()}`, { replace: true, state: { isNew: true, letter, prompt } })
    })()
    return () => {
      cancelled = true
    }
  }, [session, fresh, letter, prompt, navigate])
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
  const handoff = (location.state as { prompt?: PromptHandoff | null } | null)?.prompt ?? null
  const asLetter = !!(location.state as { letter?: boolean } | null)?.letter || handoff?.track_hint === 'letters'
  const lettersTrack = tracks.find((t) => t.slug === 'letters')?.id ?? null
  // a prompt that suggests a track starts the page there (a prompt for a letter, a prayer, a dream)
  const hintedTrack = handoff?.track_hint ? tracks.find((t) => t.slug === handoff.track_hint)?.id ?? null : null
  const defaultTrack = hintedTrack ?? (asLetter && lettersTrack ? lettersTrack : (tracks[0]?.id ?? null))
  const promptText = handoff?.text ?? null

  const blank = useCallback(
    (): EntryContent => ({
      id, entry_date: localDate(), title: '', body_rich: EMPTY_DOC, body_text: '', language: lang, word_count: 0,
      track_id: defaultTrack, fields: promptText ? { prompt: promptText } : {}, tag_ids: [], is_letter: asLetter, letter_to: null, sealed: false, unlock_at: null,
    }),
    [id, lang, defaultTrack, asLetter, promptText],
  )
  const { session, error } = useEntrySession(id, userId, blank, isNew)
  useSessionState(session)

  // A photo can only be registered once its entry's text is on the server, so the moment a save lands, try again.
  const saveStatus = session?.status
  useEffect(() => {
    if (saveStatus === 'saved' && photoQueue.pending(id).length > 0) photoQueue.retryNow()
  }, [saveStatus, id])

  const state = writeState(license)
  // The server decides; this only avoids inviting typing that can't be saved.
  const editable = !!session && !session.unavailable && state !== 'readonly' && !(state === 'grace' && session.status === 'idle')

  const [photoNotice, setPhotoNotice] = useState<string | null>(null)
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
    // the Letters track is the one that makes a page a letter (a sealed or addressed one stays a letter)
    if (t.slug === 'letters') session.change({ is_letter: true })
    else if (!c.sealed && !c.letter_to) session.change({ is_letter: false })
  }

  /** Seal the letter for a day. Returns a plain-words problem, or null when it worked. */
  const sealLetter = async (day: string): Promise<string | null> => {
    if (!session) return 'Something went wrong. Try again.'
    if (!session.content.body_text.trim()) return 'Write something first.'
    session.change({ is_letter: true, sealed: true, unlock_at: unlockInstant(day) })
    await session.flush()
    if (session.status === 'sealed') {
      // the server refused the date: take the seal back off, the words are untouched
      session.change({ sealed: false, unlock_at: null })
      return "That day didn't work. Pick one that hasn't come yet."
    }
    return null
  }

  if (!UUID.test(id)) return <Navigate to="/write" replace />
  if (error) return <div className="screen"><p className="screen-sub">Couldn't open this entry. Your words are safe on this device.</p></div>
  if (!session) return <p className="sr-only" role="status">Opening…</p>

  const c = session.content

  // A sealed letter whose day hasn't come: a wax seal, and nothing of what it says. The editor is never mounted.
  if (isSealedNow(c)) {
    return (
      <div className="screen write">
        <article className="page spread quiet sealed-page" aria-label="A sealed letter">
          <SealedCard to={c.letter_to ?? null} until={c.unlock_at!} big note="Sealed means hidden until the day, not encrypted." />
          <p className="quiet-note">It will open on its own, on the day.</p>
          <p>
            <Link className="btn btn-tint" to="/letters">Back to letters</Link>
          </p>
        </article>
      </div>
    )
  }
  const showLetter = !!c.is_letter || !!c.sealed || tracks.find((t) => t.id === trackOf(c))?.slug === 'letters'
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
          {showLetter && (
            <LetterPanel content={c} editable={editable} onTo={(letter_to) => session.change({ letter_to, is_letter: true })} onSeal={sealLetter} />
          )}
          {chapterNames.length > 0 && <p className="meta chapter-line">{chapterNames.join(' · ')}</p>}
        </header>
        {typeof c.fields?.prompt === 'string' && c.fields.prompt && (
          <p className="page-prompt" dir="auto">{c.fields.prompt}</p>
        )}
        <p className="save-status" role="status" aria-live="polite">
          {session.unavailable
            ? "This entry isn't on this device yet. Connect to open it."
            : trialLine ?? STATUS_TEXT[session.status]}
          {session.note && <span className="save-note"> {session.note}</span>}
          {session.status === 'sealed' && session.sealRejection === 'sealed' && (
            <button type="button" className="btn btn-quiet" onClick={() => window.location.reload()}>Open it again</button>
          )}
          {photoNotice && <span className="save-note photo-notice"> {photoNotice}</span>}
        </p>
        {!session.unavailable && (
          <Editor
            key={session.id}
            content={c.body_rich}
            contentVersion={session.remoteVersion}
            editable={editable}
            onChange={onChange}
            onBlur={onBlur}
            entryId={session.id}
            userId={userId}
            usedBytes={profile?.storage_bytes_used ?? 0}
            onNotice={setPhotoNotice}
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
