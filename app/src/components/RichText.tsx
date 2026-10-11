import type { ReactNode } from 'react'

type PMNode = { type: string; content?: PMNode[]; text?: string; marks?: { type: string }[]; attrs?: { level?: number } }

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

function block(n: PMNode, key: number): ReactNode {
  const kids = (n.content ?? []).map((c, i) => inline(c, i))
  switch (n.type) {
    case 'paragraph':
      return <p key={key} dir="auto">{kids}</p>
    case 'heading':
      return n.attrs?.level === 3 ? <h3 key={key} dir="auto">{kids}</h3> : <h2 key={key} dir="auto">{kids}</h2>
    case 'bulletList':
      return <ul key={key}>{(n.content ?? []).map(block)}</ul>
    case 'orderedList':
      return <ol key={key}>{(n.content ?? []).map(block)}</ol>
    case 'listItem':
      return <li key={key}>{(n.content ?? []).map(block)}</li>
    case 'blockquote':
      return <blockquote key={key}>{(n.content ?? []).map(block)}</blockquote>
    default:
      return null
  }
}

/** Read-only view of a saved entry. Built from the ProseMirror JSON as React elements: no HTML is ever injected. */
export function RichText({ doc }: { doc: unknown }) {
  const nodes = ((doc as PMNode | null)?.content ?? []).map(block)
  return <div className="rich">{nodes}</div>
}
