import type { ReactNode } from 'react'
import { PhotoFigure } from './Photo'

type PMNode = { type: string; content?: PMNode[]; text?: string; marks?: { type: string }[]; attrs?: { level?: number; mediaId?: string; width?: number | null; height?: number | null } }

function inline(n: PMNode, key: number): ReactNode {
  if (n.type === 'hardBreak') return <br key={key} />
  if (n.type !== 'text') return null
  let el: ReactNode = n.text ?? ''
  for (const m of n.marks ?? []) {
    if (m.type === 'bold') el = <strong>{el}</strong>
    else if (m.type === 'italic') el = <em>{el}</em>
  }
  return <span key={key}>{el}</span>
}

function block(n: PMNode, key: number, entryId?: string): ReactNode {
  const kids = (n.content ?? []).map((c, i) => inline(c, i))
  switch (n.type) {
    case 'paragraph':
      return <p key={key} dir="auto">{kids}</p>
    case 'heading':
      return n.attrs?.level === 3 ? <h3 key={key} dir="auto">{kids}</h3> : <h2 key={key} dir="auto">{kids}</h2>
    case 'photo':
      return entryId && n.attrs?.mediaId ? (
        <PhotoFigure key={key} entryId={entryId} mediaId={n.attrs.mediaId} width={n.attrs.width} height={n.attrs.height} />
      ) : null
    case 'bulletList':
      return <ul key={key}>{(n.content ?? []).map((c, i) => block(c, i, entryId))}</ul>
    case 'orderedList':
      return <ol key={key}>{(n.content ?? []).map((c, i) => block(c, i, entryId))}</ol>
    case 'listItem':
      return <li key={key}>{(n.content ?? []).map((c, i) => block(c, i, entryId))}</li>
    case 'blockquote':
      return <blockquote key={key}>{(n.content ?? []).map((c, i) => block(c, i, entryId))}</blockquote>
    default:
      return null
  }
}

/** Read-only view of a saved entry. Built from the ProseMirror JSON as React elements: no HTML is ever injected. */
export function RichText({ doc, entryId }: { doc: unknown; entryId?: string }) {
  const nodes = ((doc as PMNode | null)?.content ?? []).map((n, i) => block(n, i, entryId))
  return <div className="rich">{nodes}</div>
}
