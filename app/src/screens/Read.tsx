import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { useAuth } from '../auth'
import { useOrganize } from '../organize'
import { PageStage, type TurnDirection } from '../components/PageStage'
import { RichText } from '../components/RichText'
import { fetchAllDates, fetchDay, type DayEntry } from '../lib/browse'
import { chaptersFor } from '../lib/organize'
import { buildSpreads, quietLabel, spreadIndexFor, spreadKey, type Spread } from '../lib/readModel'

const longDate = (iso: string) =>
  new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)))
const shortDate = (iso: string) =>
  new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)))

const typing = (el: Element | null) => !!el && (el.matches('input, textarea, select, [contenteditable="true"]') || !!el.closest('[contenteditable="true"]'))

function DaySpread({ date, entries, loading }: { date: string; entries: DayEntry[] | null; loading: boolean }) {
  const { tracks, tags, chapters } = useOrganize()
  const chapterNames = chaptersFor(date, chapters).map((c) => c.name)
  return (
    <article className="page spread" aria-label={longDate(date)}>
      <header className="spread-head">
        <h1 className="page-date">{longDate(date)}</h1>
        {chapterNames.length > 0 && <p className="meta chapter-line">{chapterNames.join(' · ')}</p>}
      </header>
      {loading && !entries && <p className="meta" role="status">Turning to this day…</p>}
      {entries && entries.length === 0 && <p className="meta">The page is blank. That's allowed.</p>}
      {entries?.map((e, i) => {
        const track = tracks.find((t) => t.id === e.track_id)
        const tagNames = e.tag_ids.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean) as string[]
        return (
          <section key={e.id} className={`spread-entry${i > 0 ? ' later' : ''}`}>
            {e.title && <h2 className="spread-title" dir="auto">{e.title}</h2>}
            {(track || tagNames.length > 0) && (
              <div className="spread-meta">
                {track && (
                  <span className="pill" data-color={track.color_token}>
                    <span className="pill-dot" style={{ background: `var(--${track.color_token === 'ash-soft' ? 'ink-soft' : track.color_token})` }} aria-hidden />
                    {track.name}
                  </span>
                )}
                {tagNames.map((n) => <span key={n} className="tag-chip static" dir="auto">{n}</span>)}
              </div>
            )}
            {e.body_text.trim() ? <RichText doc={e.body_rich} /> : <p className="meta">Nothing written here.</p>}
            <p className="spread-foot">
              <span>{e.word_count} {e.word_count === 1 ? 'word' : 'words'}{e.unsynced ? ' · on this device' : ''}</span>
              <Link className="btn btn-quiet" to={`/write/${e.id}`}>Open to edit</Link>
            </p>
          </section>
        )
      })}
    </article>
  )
}

function QuietSpread({ s }: { s: Extract<Spread, { kind: 'quiet' }> }) {
  return (
    <article className="page spread quiet" aria-label={quietLabel(s)}>
      <h1 className="quiet-title">{quietLabel(s)}</h1>
      <p className="meta">{s.days === 1 ? shortDate(s.from) : `${shortDate(s.from)} to ${shortDate(s.to)}`}</p>
      <p className="quiet-note">Nothing written. That's allowed.</p>
    </article>
  )
}

export function Read() {
  const { session } = useAuth()
  const userId = session!.user.id
  const [sp, setSp] = useSearchParams()
  const wanted = sp.get('date')

  const [dates, setDates] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    fetchAllDates(userId).then((d) => live && setDates(d))
    const again = () => void fetchAllDates(userId).then((d) => live && setDates(d))
    window.addEventListener('online', again)
    return () => {
      live = false
      window.removeEventListener('online', again)
    }
  }, [userId])

  const spreads = useMemo(() => buildSpreads(dates ?? []), [dates])
  const [index, setIndex] = useState(-1)
  const [direction, setDirection] = useState<TurnDirection>('none')

  // first arrival: the requested date, else the most recent page
  useEffect(() => {
    if (!dates || spreads.length === 0) return
    setIndex((cur) => (cur >= 0 ? cur : wanted ? spreadIndexFor(spreads, wanted) : spreads.length - 1))
  }, [dates, spreads, wanted])

  const current = index >= 0 ? spreads[index] : null
  const key = current ? spreadKey(current) : 'none'

  // the day's entries
  const [entries, setEntries] = useState<DayEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!current || current.kind !== 'day') {
      setEntries(null)
      return
    }
    let live = true
    setLoading(true)
    fetchDay(userId, current.date).then((e) => {
      if (!live) return
      setEntries(e)
      setLoading(false)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, userId])

  const moveTo = useCallback(
    (i: number, dir: TurnDirection) => {
      if (i < 0 || i >= spreads.length) return
      setDirection(dir)
      setIndex(i)
      const s = spreads[i]
      setSp((prev) => { const n = new URLSearchParams(prev); n.set('date', s.kind === 'day' ? s.date : s.from); return n }, { replace: true })
      window.scrollTo({ top: 0 })
    },
    [spreads, setSp],
  )
  const next = useCallback(() => moveTo(index + 1, 'next'), [moveTo, index])
  const prev = useCallback(() => moveTo(index - 1, 'prev'), [moveTo, index])

  // keyboard: ← earlier, → later (never while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(document.activeElement)) return
      if (e.key === 'ArrowRight') { e.preventDefault(); next() }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev])

  // swipe: a deliberate horizontal drag. Swipe left = the next page, like a book.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touch.current = { x: t.clientX, y: t.clientY, t: Date.now() }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current
    touch.current = null
    if (!s) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - s.t < 800 && !window.getSelection()?.toString()) {
      dx < 0 ? next() : prev()
    }
  }

  // jump to date
  const [jump, setJump] = useState('')
  const first = dates?.[0]
  const last = dates?.[dates.length - 1]

  if (dates === null) return <div className="screen"><p className="sr-only" role="status">Opening the book…</p></div>

  if (spreads.length === 0) {
    return (
      <div className="screen">
        <article className="page spread quiet">
          <h1 className="quiet-title">Nothing to read yet</h1>
          <p className="quiet-note">Your pages will gather here, one day at a time.</p>
          <p><Link className="btn btn-primary" to="/write">Write today</Link></p>
        </article>
      </div>
    )
  }

  return (
    <div className="screen read">
      <nav className="read-bar" aria-label="Turn pages">
        <button className="btn btn-tint" onClick={prev} disabled={index <= 0} aria-label="Earlier page">
          <CaretLeft size={18} weight="light" aria-hidden /> <span className="btn-label">Earlier</span>
        </button>
        <form
          className="jump"
          onSubmit={(e) => {
            e.preventDefault()
            if (jump) moveTo(spreadIndexFor(spreads, jump), 'jump')
          }}
        >
          <label>
            <span className="sr-only">Jump to a date</span>
            <input type="date" value={jump} min={first} max={last} onChange={(e) => setJump(e.target.value)} />
          </label>
          <button className="btn btn-tint" disabled={!jump}>Go</button>
        </form>
        <button className="btn btn-tint" onClick={next} disabled={index >= spreads.length - 1} aria-label="Later page">
          <span className="btn-label">Later</span> <CaretRight size={18} weight="light" aria-hidden />
        </button>
      </nav>

      <div className="stage-wrap" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <PageStage spreadKey={key} direction={direction}>
          {current?.kind === 'quiet' ? <QuietSpread s={current} /> : current ? <DaySpread date={current.date} entries={entries} loading={loading} /> : null}
        </PageStage>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {current ? (current.kind === 'day' ? longDate(current.date) : quietLabel(current)) : ''}
      </p>
    </div>
  )
}
