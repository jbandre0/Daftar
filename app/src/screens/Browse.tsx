import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CaretLeft, CaretRight, MagnifyingGlass, X } from '@phosphor-icons/react'
import { useAuth } from '../auth'
import { useOrganize } from '../organize'
import { chaptersFor, LANGUAGES, languageLabel, type Chapter } from '../lib/organize'
import { activeFilterCount, browseEntries, fetchMonthDays, NO_FILTERS, PAGE_SIZE, type BrowseFilters, type BrowseRow } from '../lib/browse'
import { localDate } from '../lib/entries'

type View = 'cal' | 'list'

// ---- URL <-> state (so Back from an entry lands where you were) --------------------------------------------

function readParams(sp: URLSearchParams) {
  const f: BrowseFilters = {
    q: sp.get('q') ?? '',
    track: sp.get('track'),
    tags: (sp.get('tags') ?? '').split(',').filter(Boolean),
    language: sp.get('lang'),
    from: sp.get('from'),
    to: sp.get('to'),
  }
  return { f, chapter: sp.get('chapter'), view: (sp.get('view') === 'list' ? 'list' : 'cal') as View, month: sp.get('month'), day: sp.get('day') }
}

// ---- search highlight (no HTML injection: split and wrap) --------------------------------------------------

function Highlight({ text, q }: { text: string; q: string }): ReactNode {
  const needle = q.trim()
  if (!needle) return text
  const at = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

function shortDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  if (y !== new Date().getFullYear()) opts.year = 'numeric'
  return new Intl.DateTimeFormat('en', opts).format(new Date(y, m - 1, d))
}

function Results({ rows, q, empty }: { rows: BrowseRow[]; q: string; empty: ReactNode }) {
  const { tracks, tags } = useOrganize()
  const { profile } = useAuth()
  if (rows.length === 0) return <>{empty}</>
  return (
    <ul className="entry-list result-list">
      {rows.map((r) => {
        const track = tracks.find((t) => t.id === r.track_id)
        const tagNames = r.tag_ids.map((id) => tags.find((t) => t.id === id)?.name).filter(Boolean)
        const meta = [
          track?.name,
          tagNames.length ? tagNames.join(', ') : null,
          r.language !== (profile?.default_language ?? 'en') ? languageLabel(r.language) : null,
          r.unsynced ? 'on this device' : null,
        ].filter(Boolean)
        return (
          <li key={r.id}>
            <Link to={`/write/${r.id}`}>
              <span className="entry-date">{shortDate(r.entry_date)}</span>
              <span className="entry-main">
                <span className="entry-title" dir="auto">
                  {r.title ? <Highlight text={r.title} q={q} /> : r.snippet ? <Highlight text={r.snippet.slice(0, 70)} q={q} /> : 'Untitled'}
                </span>
                {r.snippet === null ? (
                  <span className="entry-snippet sealed-note">A sealed letter</span>
                ) : (
                  r.title && (
                    <span className="entry-snippet" dir="auto">
                      <Highlight text={r.snippet} q={q} />
                    </span>
                  )
                )}
                {meta.length > 0 && (
                  <span className="entry-meta" dir="auto">
                    {track && <i className="entry-dot" style={{ ['--c' as string]: `var(--${track.color_token})` }} aria-hidden />}
                    {meta.join(' · ')}
                  </span>
                )}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

// ---- calendar ------------------------------------------------------------------------------------------

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const pad = (n: number) => String(n).padStart(2, '0')

function Calendar({
  year, month0, counts, chapters, selected, onSelect, onMonth,
}: {
  year: number
  month0: number
  counts: Record<string, number>
  chapters: Chapter[]
  selected: string | null
  onSelect: (d: string) => void
  onMonth: (y: number, m0: number) => void
}) {
  const first = new Date(year, month0, 1)
  const days = new Date(year, month0 + 1, 0).getDate()
  const today = localDate()
  const title = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(first)
  const shift = (n: number) => {
    const d = new Date(year, month0 + n, 1)
    onMonth(d.getFullYear(), d.getMonth())
  }
  const cells: (number | null)[] = [...Array(first.getDay()).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  return (
    <div className="card calendar">
      <div className="cal-head">
        <button className="cal-nav" onClick={() => shift(-1)} aria-label="Previous month"><CaretLeft size={20} weight="light" /></button>
        <h2 aria-live="polite">{title}</h2>
        <button className="cal-nav" onClick={() => shift(1)} aria-label="Next month"><CaretRight size={20} weight="light" /></button>
      </div>
      <div className="cal-grid" role="grid" aria-label={title}>
        {WEEKDAYS.map((w, i) => (
          <span key={i} className="cal-dow" aria-hidden>{w}</span>
        ))}
        {cells.map((n, i) => {
          if (n === null) return <span key={`b${i}`} />
          const iso = `${year}-${pad(month0 + 1)}-${pad(n)}`
          const c = counts[iso] ?? 0
          const bars = chaptersFor(iso, chapters).slice(0, 2)
          return (
            <button
              key={iso}
              className="cal-day"
              data-today={iso === today || undefined}
              data-has={c > 0 || undefined}
              aria-pressed={iso === selected}
              aria-label={`${new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric' }).format(new Date(year, month0, n))}${c ? `, ${c} ${c === 1 ? 'entry' : 'entries'}` : ''}`}
              onClick={() => onSelect(iso)}
            >
              <span className="cal-num">{n}</span>
              <span className="cal-dots" aria-hidden>
                {Array.from({ length: Math.min(c, 3) }, (_, k) => <i key={k} />)}
              </span>
              <span className="cal-bars" aria-hidden>
                {bars.map((b) => <i key={b.id} style={{ ['--c' as string]: `var(--${b.color_token})` }} />)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---- screen --------------------------------------------------------------------------------------------

export function Browse() {
  const { session } = useAuth()
  const userId = session!.user.id
  const { tracks, tags, chapters } = useOrganize()
  const [sp, setSp] = useSearchParams()
  const { f: urlF, chapter: chapterId, view: urlView, month, day } = readParams(sp)

  const chapter = chapters.find((c) => c.id === chapterId) ?? null
  const filters: BrowseFilters = chapter ? { ...urlF, from: chapter.start_date, to: chapter.end_date } : urlF
  const filtersOn = activeFilterCount(filters) > 0
  const searching = filters.q.trim().length > 0
  const view: View = searching || filtersOn ? 'list' : urlView

  const update = useCallback(
    (patch: Record<string, string | null>) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v))
          return next
        },
        { replace: true },
      )
    },
    [setSp],
  )

  // search box: local text, pushed to the URL after a short pause
  const [qInput, setQInput] = useState(urlF.q)
  useEffect(() => {
    if (qInput === urlF.q) return
    const t = setTimeout(() => update({ q: qInput.trim() ? qInput : null }), 250)
    return () => clearTimeout(t)
  }, [qInput, urlF.q, update])

  const [showFilters, setShowFilters] = useState(filtersOn)

  // the list
  const [rows, setRows] = useState<BrowseRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [more, setMore] = useState(false)
  const [offline, setOffline] = useState(false)
  const req = useRef(0)
  const filterKey = JSON.stringify(filters)

  useEffect(() => {
    if (view !== 'list') return
    const id = ++req.current
    setLoading(true)
    browseEntries(userId, filters, 0).then((p) => {
      if (id !== req.current) return
      setRows(p.rows)
      setTotal(p.total)
      setOffline(p.offline)
      setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, view, userId])

  async function loadMore() {
    setMore(true)
    const p = await browseEntries(userId, filters, rows.length)
    setRows((r) => [...r, ...p.rows.filter((x) => !r.some((y) => y.id === x.id))])
    setMore(false)
  }

  // the calendar
  const now = new Date()
  const [cy, cm] = (month ?? '').match(/^(\d{4})-(\d{2})$/) ? [Number(month!.slice(0, 4)), Number(month!.slice(5, 7)) - 1] : [now.getFullYear(), now.getMonth()]
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    if (view !== 'cal') return
    let live = true
    fetchMonthDays(userId, cy, cm).then((c) => live && setCounts(c))
    return () => {
      live = false
    }
  }, [view, userId, cy, cm])

  const [dayRows, setDayRows] = useState<BrowseRow[]>([])
  useEffect(() => {
    if (view !== 'cal' || !day) {
      setDayRows([])
      return
    }
    let live = true
    browseEntries(userId, { ...NO_FILTERS, from: day, to: day }, 0).then((p) => live && setDayRows(p.rows))
    return () => {
      live = false
    }
  }, [view, day, userId, counts])

  const clearAll = () => {
    setQInput('')
    update({ q: null, track: null, tags: null, lang: null, from: null, to: null, chapter: null })
  }

  const usedTagIds = filters.tags
  const dayLabel = day ? new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))) : ''

  return (
    <div className="screen browse">
      <h1 className="screen-title">Browse</h1>
      <p className="screen-sub">Find anything you've written.</p>

      <div className="search">
        <MagnifyingGlass size={20} weight="light" aria-hidden />
        <input
          type="search"
          dir="auto"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="Search words, or part of a word"
          aria-label="Search your entries"
        />
        {qInput && (
          <button className="search-clear" aria-label="Clear search" onClick={() => { setQInput(''); update({ q: null }) }}>
            <X size={18} weight="light" />
          </button>
        )}
      </div>

      <div className="browse-controls">
        <div className="seg" role="group" aria-label="View">
          <button aria-pressed={view === 'cal'} disabled={searching || filtersOn} title={searching || filtersOn ? 'The calendar shows everything. Clear the search or filters to use it.' : undefined} onClick={() => update({ view: null })}>
            Calendar
          </button>
          <button aria-pressed={view === 'list'} onClick={() => update({ view: 'list' })}>
            List
          </button>
        </div>
        <button className="btn btn-tint" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
          Filters{activeFilterCount(filters) ? ` · ${activeFilterCount(filters)}` : ''}
        </button>
        {(searching || filtersOn) && (
          <button className="btn btn-quiet" onClick={clearAll}>
            Clear all
          </button>
        )}
      </div>

      {showFilters && (
        <div className="card filters">
          <label className="field">
            <span className="label">Track</span>
            <select className="select" value={filters.track ?? ''} onChange={(e) => update({ track: e.target.value || null })}>
              <option value="">Any track</option>
              {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">Language</span>
            <select className="select" value={filters.language ?? ''} onChange={(e) => update({ lang: e.target.value || null })}>
              <option value="">Any language</option>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="label">Chapter</span>
            <select className="select" value={chapter?.id ?? ''} onChange={(e) => update({ chapter: e.target.value || null, from: null, to: null })}>
              <option value="">Any time</option>
              {chapters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <div className="field-pair">
            <label className="field">
              <span className="label">From</span>
              <input type="date" value={filters.from ?? ''} disabled={!!chapter} onChange={(e) => update({ from: e.target.value || null })} />
            </label>
            <label className="field">
              <span className="label">To</span>
              <input type="date" value={filters.to ?? ''} disabled={!!chapter} min={filters.from ?? undefined} onChange={(e) => update({ to: e.target.value || null })} />
            </label>
          </div>
          <div className="field">
            <span className="label">Tags (entries with all of these)</span>
            <div className="chip-row">
              {tags.map((t) => (
                <button
                  key={t.id}
                  className="chip"
                  aria-pressed={usedTagIds.includes(t.id)}
                  onClick={() => update({ tags: (usedTagIds.includes(t.id) ? usedTagIds.filter((x) => x !== t.id) : [...usedTagIds, t.id]).join(',') || null })}
                >
                  <span dir="auto">{t.name}</span>
                </button>
              ))}
              {tags.length === 0 && <span className="fine">No tags yet.</span>}
            </div>
          </div>
        </div>
      )}

      {offline && <p className="empty">You're offline, so this is only what's on this device.</p>}

      {view === 'cal' ? (
        <>
          <Calendar
            year={cy} month0={cm} counts={counts} chapters={chapters} selected={day}
            onSelect={(d) => update({ day: d === day ? null : d })}
            onMonth={(y, m0) => update({ month: `${y}-${pad(m0 + 1)}`, day: null })}
          />
          {day && (
            <section aria-labelledby="day-h" className="day-panel">
              <div className="row day-head">
                <h2 id="day-h" className="section-label">{dayLabel}</h2>
                {dayRows.length > 0 && <Link className="btn btn-tint" to={`/read?date=${day}`}>Read this day</Link>}
              </div>
              <Results rows={dayRows} q="" empty={<p className="empty">Nothing written this day. The page is blank. That's allowed.</p>} />
            </section>
          )}
        </>
      ) : (
        <section aria-label="Entries">
          {!loading && (
            <p className="count" role="status" aria-live="polite">
              {total === 0 ? '' : searching ? `${total.toLocaleString()} ${total === 1 ? 'match' : 'matches'}` : `${total.toLocaleString()} ${total === 1 ? 'entry' : 'entries'}`}
            </p>
          )}
          {loading ? (
            <p className="sr-only" role="status">Searching…</p>
          ) : (
            <Results
              rows={rows}
              q={filters.q}
              empty={
                searching || filtersOn ? (
                  <div className="empty-block">
                    <p>Nothing matches that.</p>
                    <button className="btn btn-tint" onClick={clearAll}>Clear the search and filters</button>
                  </div>
                ) : (
                  <div className="empty-block">
                    <p>Your first entry will appear here.</p>
                    <Link className="btn btn-primary" to="/write">Write today</Link>
                  </div>
                )
              }
            />
          )}
          {!loading && rows.length < total && !offline && (
            <div className="row" style={{ justifyContent: 'center', marginBlockStart: 'var(--sp-4)' }}>
              <button className="btn btn-tint" onClick={() => void loadMore()} disabled={more}>
                {more ? 'Loading…' : `Show more (${Math.min(PAGE_SIZE, total - rows.length)} of ${(total - rows.length).toLocaleString()} left)`}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
