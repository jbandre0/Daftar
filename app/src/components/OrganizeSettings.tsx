import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth'
import { useOrganize } from '../organize'
import {
  archiveTrack, COLOR_TOKENS, createTag, createTrack, deleteTag, DuplicateError, LANGUAGES, renameTag,
  setDefaultLanguage, updateTrack, type Tag, type Track,
} from '../lib/organize'

function useAction() {
  const [error, setError] = useState('')
  return {
    error,
    run: async (fn: () => Promise<void>, dupMessage = 'That name is already in use.') => {
      setError('')
      try {
        await fn()
      } catch (e) {
        setError(e instanceof DuplicateError ? dupMessage : "Couldn't save that. Check your connection and try again.")
      }
    },
  }
}

function TrackRow({ t, canArchive, onChanged }: { t: Track; canArchive: boolean; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(t.name)
  const { error, run } = useAction()
  return (
    <li style={{ ['--c' as string]: `var(--${t.color_token})` }}>
      <div className="org-row">
        <span className="org-dot" aria-hidden />
        <input
          className="name"
          dir="auto"
          aria-label={`Name of track ${t.name}`}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name.trim() !== t.name
              ? void run(async () => { await updateTrack(t.id, { name: name.trim() }); await onChanged() })
              : setName(t.name)
          }
        />
        <select
          aria-label={`Colour of ${t.name}`}
          value={t.color_token}
          onChange={(e) => void run(async () => { await updateTrack(t.id, { color_token: e.target.value }); await onChanged() })}
        >
          {COLOR_TOKENS.map((c) => <option key={c} value={c}>{c.replace('-soft', '')}</option>)}
        </select>
        <button className="btn btn-quiet" disabled={!canArchive} onClick={() => void run(async () => { await archiveTrack(t.id); await onChanged() })}>
          Hide
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </li>
  )
}

export function TracksCard() {
  const { session } = useAuth()
  const { tracks, refresh } = useOrganize()
  const [name, setName] = useState('')
  const { error, run } = useAction()

  function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    void run(async () => {
      await createTrack(session!.user.id, name, 'flame', (tracks.at(-1)?.sort_order ?? 0) + 1)
      setName('')
      await refresh()
    })
  }

  return (
    <div className="card">
      <h2>Tracks</h2>
      <p>What kind of writing it is. Rename them, recolour them, add your own.</p>
      <ul className="org-list">
        {tracks.map((t) => <TrackRow key={t.id + t.name + t.color_token} t={t} canArchive={tracks.length > 1} onChanged={refresh} />)}
      </ul>
      <form className="add-row" onSubmit={add}>
        <label className="field">
          <span className="sr-only">New track name</span>
          <input dir="auto" placeholder="New track" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={!name.trim()}>Add</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}

function TagRow({ t, onChanged }: { t: Tag; onChanged: () => Promise<void> }) {
  const [name, setName] = useState(t.name)
  const { error, run } = useAction()
  return (
    <li>
      <div className="org-row">
        <input
          className="name"
          dir="auto"
          aria-label={`Name of tag ${t.name}`}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name.trim() !== t.name
              ? void run(async () => { await renameTag(t.id, name.trim()); await onChanged() }, 'You already have a tag with that name.')
              : setName(t.name)
          }
        />
        <button
          className="btn btn-quiet"
          onClick={() => {
            if (!confirm(`Delete the tag “${t.name}”? It comes off every entry; the entries stay.`)) return
            void run(async () => { await deleteTag(t.id); await onChanged() })
          }}
        >
          Delete
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </li>
  )
}

export function TagsCard() {
  const { session } = useAuth()
  const { tags, refresh } = useOrganize()
  const [name, setName] = useState('')
  const { error, run } = useAction()
  return (
    <div className="card">
      <h2>Tags</h2>
      <p>What an entry is about. Add them from the entry itself, or here.</p>
      {tags.length === 0 && <p className="empty">No tags yet.</p>}
      <ul className="org-list">
        {tags.map((t) => <TagRow key={t.id + t.name} t={t} onChanged={refresh} />)}
      </ul>
      <form
        className="add-row"
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          void run(async () => { await createTag(session!.user.id, name); setName(''); await refresh() }, 'You already have that tag.')
        }}
      >
        <label className="field">
          <span className="sr-only">New tag name</span>
          <input dir="auto" placeholder="New tag" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={!name.trim()}>Add</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}

export function LanguageCard() {
  const { session, profile, refresh } = useAuth()
  const { error, run } = useAction()
  return (
    <div className="card">
      <h2>Default language</h2>
      <p style={{ marginBlockEnd: 'var(--sp-3)' }}>New entries start in this language. Text direction follows what you type, so this is for organizing.</p>
      <label className="field">
        <span className="sr-only">Default language</span>
        <select
          className="select"
          value={profile?.default_language ?? 'en'}
          onChange={(e) => void run(async () => { await setDefaultLanguage(session!.user.id, e.target.value); await refresh() })}
        >
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}
