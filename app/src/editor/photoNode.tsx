import { createContext, useContext } from 'react'
import { Node } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react'
import { PhotoFigure } from '../components/Photo'
import { backend, invalidateMedia, photoQueue } from '../lib/photoRuntime'

export const PhotoContext = createContext<{ entryId: string; editable: boolean } | null>(null)

/** Removing a photo from the page takes it out of the entry's media (the file itself is purged after 30 days). */
export async function removePhoto(entryId: string, mediaId: string) {
  if (photoQueue.has(mediaId)) await photoQueue.discard(mediaId)
  else {
    try {
      await backend().softDelete(mediaId)
      invalidateMedia(entryId)
    } catch {
      /* offline: the nightly sweep soft-deletes photos that are no longer on their page */
    }
  }
}

function PhotoView({ node, deleteNode, selected }: NodeViewProps) {
  const ctx = useContext(PhotoContext)
  const { mediaId, width, height } = node.attrs as { mediaId: string; width: number | null; height: number | null }
  if (!ctx) return null
  return (
    <NodeViewWrapper as="div" className={`photo-node${selected ? ' is-selected' : ''}`} data-drag-handle>
      <PhotoFigure
        entryId={ctx.entryId}
        mediaId={mediaId}
        width={width}
        height={height}
        onRemove={
          ctx.editable
            ? () => {
                deleteNode()
                void removePhoto(ctx.entryId, mediaId)
              }
            : undefined
        }
      />
    </NodeViewWrapper>
  )
}

/** A photo on the page. Saved in the entry's JSON as {type:'photo', attrs:{mediaId, width, height}}. */
export const Photo = Node.create({
  name: 'photo',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return { mediaId: { default: null }, width: { default: null }, height: { default: null } }
  },
  parseHTML() {
    return [{ tag: 'figure[data-photo]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['figure', { 'data-photo': '', 'data-media-id': HTMLAttributes.mediaId }]
  },
  renderText() {
    return ''
  },
  addNodeView() {
    return ReactNodeViewRenderer(PhotoView)
  },
})
