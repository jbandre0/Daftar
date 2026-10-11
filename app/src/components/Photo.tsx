import { X } from '@phosphor-icons/react'
import { usePhoto } from '../lib/photoRuntime'

const WAIT: Record<string, string> = {
  cap: 'Storage is full. Kept on this device.',
  paused: 'Trial ended. Kept on this device.',
  refused: "Couldn't save yet. Kept on this device.",
}

/** One photo. Shows the device copy at once, then swaps in the server's. Never throws away what isn't uploaded. */
export function PhotoFigure({
  entryId, mediaId, width, height, onRemove,
}: {
  entryId: string
  mediaId: string
  width?: number | null
  height?: number | null
  onRemove?: () => void
}) {
  const v = usePhoto(entryId, mediaId)
  const w = width ?? v.width
  const h = height ?? v.height
  return (
    <figure className="photo" data-state={v.state} contentEditable={false}>
      <div className="photo-frame" style={w && h ? { aspectRatio: `${w} / ${h}` } : undefined}>
        {v.src ? (
          <img src={v.src} alt="A photo in this entry" width={w ?? undefined} height={h ?? undefined} decoding="async" draggable={false} />
        ) : (
          <div className="photo-wait" role="img" aria-label={v.state === 'missing' ? 'This photo is not available' : 'Photo loading'}>
            {v.state === 'missing' ? 'Photo not available' : ''}
          </div>
        )}
        {v.state === 'local' && (
          <span className="photo-status" role="status">
            {v.blocked ? WAIT[v.blocked] : 'Saving photo…'}
          </span>
        )}
        {onRemove && (
          <button type="button" className="photo-remove" aria-label="Remove this photo" onClick={onRemove}>
            <X size={16} weight="light" />
          </button>
        )}
      </div>
    </figure>
  )
}
