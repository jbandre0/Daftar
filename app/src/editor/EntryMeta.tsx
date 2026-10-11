import { useId, useState, type FormEvent } from 'react'
import { X } from '@phosphor-icons/react'
import { useOrganize } from '../organize'
import { useAuth } from '../auth'
import { createTag, DuplicateError, LANGUAGES, type Track } from '../lib/organize'
import type { EntryContent } from '../lib/entries'
import { fieldsOf, tagsOf, trackOf } from '../lib/entries'

type Props = {
  content: EntryContent
  editable: boolean
  onTrack: (t: Track) => void
  onLanguage: (code: string) => void
  onTags: (ids: string[]) => void
  onFields: (f: Record<string, unknown>) => void
}

export function EntryMeta({ content, editable, onTrack, onLanguage, onTags, onFields }: Props) {
  const { tracks, tags, refresh } = useOrganize()
  const { session } = useAuth()
  const track = tracks.find((t) => t.id === trackOf(content))
  const tagIds = tagsOf(content)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const listId = useId()

  async function addTag(e: FormEvent) {
    e.preventDefault()
    const name = draft.trim().replace(/^#/, '')
    if (!name) return
    setNote('')
    let tag = tags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (!tag) {
      try {
        tag = await createTag(session!.user.id, name)
        await refresh()
      } catch (err) {
        if (err instanceof DuplicateError) {
          await refresh()
          setNote('That tag already exists. Try again.')
        } else {
          setNote("New tags need a connection. Existing tags still work offline.")
        }
        return
      }
    }
    if (!tagIds.includes(tag.id)) onTags([...tagIds, tag.id])
    setDraft('')
  }

  const f = fieldsOf(content)
  const spiritual = track?.slug === 'spiritual'

  return (
    <>
      <div className="page-pills">
        <label className="pill pill-select" data-color={track?.color_token ?? 'ash-soft'}>
          <span className="pill-dot" aria-hidden />
          <span className="sr-only">Track</span>
          <select
            value={track?.id ?? ''}
            disabled={!editable}
            onChange={(e) => {
              const t = tracks.find((x) => x.id === e.target.value)
              if (t) onTrack(t)
            }}
          >
            {!track && <option value="">No track</option>}
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pill pill-select">
          <span className="sr-only">Language</span>
          <select value={content.language} disabled={!editable} onChange={(e) => onLanguage(e.target.value)} aria-label="Language">
            {!LANGUAGES.some((l) => l.code === content.language) && <option value={content.language}>{content.language.toUpperCase()}</option>}
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.code.toUpperCase()} · {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tag-bar">
        <ul className="tag-list" aria-label="Tags">
          {tagIds.map((id) => {
            const t = tags.find((x) => x.id === id)
            if (!t) return null
            return (
              <li key={id} className="tag-chip">
                <span dir="auto">{t.name}</span>
                {editable && (
                  <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => onTags(tagIds.filter((x) => x !== id))}>
                    <X size={14} weight="light" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {editable && (
          <form onSubmit={addTag} className="tag-add">
            <input
              dir="auto"
              list={listId}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a tag"
              aria-label="Add a tag"
              maxLength={40}
            />
            <datalist id={listId}>
              {tags.filter((t) => !tagIds.includes(t.id)).map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
          </form>
        )}
        {note && <p className="tag-note" role="status">{note}</p>}
      </div>

      {spiritual && (
        <div className="fields">
          <label className="field-row">
            <span>Scripture</span>
            <input
              dir="auto"
              value={String(f.scripture ?? '')}
              readOnly={!editable}
              placeholder="Alma 32"
              onChange={(e) => onFields({ ...f, scripture: e.target.value })}
            />
          </label>
          <div className="field-row">
            <label className="check">
              <input
                type="checkbox"
                checked={f.answered_later === true}
                disabled={!editable}
                onChange={(e) =>
                  onFields({
                    ...f,
                    answered_later: e.target.checked,
                    answered_on: e.target.checked ? f.answered_on ?? null : null,
                  })
                }
              />
              <span>Answered later?</span>
            </label>
            {f.answered_later === true && (
              <label className="field-inline">
                <span className="sr-only">Answered on</span>
                <input
                  type="date"
                  value={String(f.answered_on ?? '')}
                  disabled={!editable}
                  onChange={(e) => onFields({ ...f, answered_on: e.target.value || null })}
                />
              </label>
            )}
          </div>
        </div>
      )}
    </>
  )
}
