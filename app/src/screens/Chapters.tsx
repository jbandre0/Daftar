import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { useOrganize } from '../organize'
import { EntryList } from '../components/EntryList'
import { entriesInRange, localDate, type EntrySummary } from '../lib/entries'
import { COLOR_TOKENS, createChapter, deleteChapter, updateChapter, type Chapter } from '../lib/organize'

function monthYear(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d))
}
export const rangeText = (c: Pick<Chapter, 'start_date' | 'end_date'>) =>
  `${monthYear(c.start_date)} – ${c.end_date ? monthYear(c.end_date) : 'ongoing'}`

function ChapterForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Chapter
  submitLabel: string
  onSubmit: (c: Omit<Chapter, 'id'>) => Promise<void>
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [start, setStart] = useState(initial?.start_date ?? localDate())
  const [ongoing, setOngoing] = useState(initial ? initial.end_date === null : true)
  const [end, setEnd] = useState(initial?.end_date ?? '')
  const [color, setColor] = useState(initial?.color_token ?? 'olive')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!ongoing && end && end < start) {
      setError('A chapter can’t end before it starts.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await onSubmit({
        name: name.trim(), description: description.trim(), start_date: start,
        end_date: ongoing || !end ? null : end, color_token: color,
      })
    } catch {
      setError("Couldn't save that. Check your connection and try again.")
    }
    setBusy(false)
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <label className="field">
        <span className="label">Name</span>
        <input dir="auto" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Junior year" />
      </label>
      <label className="field">
        <span className="label">Note (optional)</span>
        <input dir="auto" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="row">
        <label className="field">
          <span className="label">Starts</span>
          <input type="date" required value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Ends</span>
          <input type="date" disabled={ongoing} value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <label className="check-desk">
          <input type="checkbox" checked={ongoing} onChange={(e) => setOngoing(e.target.checked)} />
          <span>Ongoing</span>
        </label>
      </div>
      <fieldset className="swatch-pick">
        <legend className="label">Colour</legend>
        {COLOR_TOKENS.map((t) => (
          <label key={t} className="swatch-radio" style={{ ['--c' as string]: `var(--${t})` }}>
            <input type="radio" name="color" checked={color === t} onChange={() => setColor(t)} />
            <span className="sr-only">{t}</span>
            <i aria-hidden />
          </label>
        ))}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

export function Chapters() {
  const { session } = useAuth()
  const { chapters, refresh } = useOrganize()
  const [creating, setCreating] = useState(false)

  return (
    <div className="screen">
      <h1 className="screen-title">Chapters</h1>
      <p className="screen-sub">Name the parts of your life. An entry belongs to a chapter when its date falls inside it.</p>

      {chapters.length === 0 && !creating && <p className="empty">No chapters yet. A chapter is a name and a start date, and that's all.</p>}

      {chapters.length > 0 && (
        <ul className="chapter-list">
          {chapters.map((c) => (
            <li key={c.id} style={{ ['--c' as string]: `var(--${c.color_token})` }}>
              <Link to={`/chapters/${c.id}`}>
                <span className="chapter-name" dir="auto">{c.name}</span>
                <span className="chapter-range">{rangeText(c)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <ChapterForm
          submitLabel="Create chapter"
          onCancel={() => setCreating(false)}
          onSubmit={async (c) => {
            await createChapter(session!.user.id, c)
            await refresh()
            setCreating(false)
          }}
        />
      ) : (
        <div className="row" style={{ marginBlockStart: 'var(--sp-5)' }}>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            New chapter
          </button>
        </div>
      )}
    </div>
  )
}

export function ChapterDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { chapters, refresh } = useOrganize()
  const chapter = chapters.find((c) => c.id === id)
  const [entries, setEntries] = useState<EntrySummary[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [offline, setOffline] = useState(false)

  const key = chapter ? `${chapter.start_date}|${chapter.end_date}` : ''
  useEffect(() => {
    if (!chapter) return
    let cancelled = false
    setEntries(null)
    entriesInRange(chapter.start_date, chapter.end_date).then(
      (e) => !cancelled && (setEntries(e), setOffline(false)),
      () => !cancelled && (setEntries([]), setOffline(true)),
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  if (!chapter) {
    return (
      <div className="screen">
        <p className="screen-sub">That chapter isn't here.</p>
        <Link className="btn btn-quiet" to="/chapters">All chapters</Link>
      </div>
    )
  }

  return (
    <div className="screen">
      <Link className="back" to="/chapters">← Chapters</Link>
      <h1 className="screen-title" dir="auto">{chapter.name}</h1>
      <p className="screen-sub">
        {rangeText(chapter)}
        {chapter.description && <> · <span dir="auto">{chapter.description}</span></>}
      </p>

      {editing ? (
        <ChapterForm
          initial={chapter}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (c) => {
            await updateChapter(chapter.id, c)
            await refresh()
            setEditing(false)
          }}
        />
      ) : (
        <div className="row" style={{ marginBlockEnd: 'var(--sp-5)' }}>
          <button className="btn btn-quiet" onClick={() => setEditing(true)}>Rename or change dates</button>
          <button
            className="btn btn-quiet"
            onClick={async () => {
              if (!confirm('Delete this chapter? Your entries stay exactly where they are.')) return
              await deleteChapter(chapter.id)
              await refresh()
              navigate('/chapters', { replace: true })
            }}
          >
            Delete
          </button>
        </div>
      )}

      {offline && <p className="empty">Entries load when you're online.</p>}
      {entries && entries.length === 0 && !offline && <p className="empty">Nothing written in these dates yet.</p>}
      {entries && entries.length > 0 && (
        <>
          <h2 className="section-label">{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</h2>
          <EntryList entries={entries} />
        </>
      )}
    </div>
  )
}
