import { useCallback, useEffect, useRef } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TextB, TextItalic, TextHTwo, ListBullets, ListNumbers, Image as ImageIcon } from '@phosphor-icons/react'
import { DirAuto } from './dirAuto'
import { Photo, PhotoContext } from './photoNode'
import { photoQueue } from '../lib/photoRuntime'
import {
  PHOTO_MESSAGES, PHOTOS_PER_ENTRY, PhotoError, processImage, THUMB_ESTIMATE_BYTES, validateFile, wouldFit,
} from '../lib/photos'

const ICON = { size: 20, weight: 'light' as const }

type Props = {
  /** ProseMirror JSON. Only read on mount and when `contentVersion` changes (another tab wrote). */
  content: unknown
  contentVersion: number
  editable: boolean
  onChange: (doc: { body_rich: unknown; body_text: string }) => void
  onBlur: () => void
  /** Photos need to know whose entry they belong to, and how full the account is. */
  entryId: string
  userId: string
  usedBytes: number
  /** A short, plain message for the writer ("An entry holds up to 12 photos."). null clears it. */
  onNotice: (message: string | null) => void
}

export function Editor({ content, contentVersion, editable, onChange, onBlur, entryId, userId, usedBytes, onNotice }: Props) {
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  onChangeRef.current = onChange
  onBlurRef.current = onBlur

  // Adding photos: process in the browser, write to the device, then put the photo on the page right away.
  const addFilesRef = useRef<(files: File[]) => void>(() => {})
  const fileInput = useRef<HTMLInputElement>(null)
  const busy = useRef(false)

  const editor = useEditor({
    extensions: [
      Photo,
      StarterKit.configure({
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        strike: false,
        underline: false,
        link: false,
      }),
      Placeholder.configure({ placeholder: "The page is blank. That's allowed." }),
      DirAuto,
    ],
    content: content as object,
    editable,
    editorProps: {
      attributes: { class: 'prose', 'aria-label': 'Entry text', spellcheck: 'true' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        event.preventDefault()
        addFilesRef.current(files)
        return true
      },
      handleDrop: (_view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return false
        event.preventDefault()
        addFilesRef.current(files)
        return true
      },
    },
    onUpdate: ({ editor }) =>
      onChangeRef.current({ body_rich: editor.getJSON(), body_text: editor.getText({ blockSeparator: '\n\n' }) }),
    onBlur: () => onBlurRef.current(),
  })

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!editor || busy.current || files.length === 0) return
      busy.current = true
      onNotice(null)
      try {
        let used = usedBytes + photoQueue.pending().reduce((n, r) => n + r.full.size + r.thumb.size, 0)
        for (const file of files) {
          let onPage = 0
          editor.state.doc.descendants((n) => {
            if (n.type.name === 'photo') onPage++
          })
          if (onPage >= PHOTOS_PER_ENTRY) throw new PhotoError('limit', PHOTO_MESSAGES.limit)
          validateFile(file)
          // a quick, honest check before doing the work; the server has the final say
          if (!wouldFit(used, file.size / 6 + THUMB_ESTIMATE_BYTES)) throw new PhotoError('cap', PHOTO_MESSAGES.cap)
          const p = await processImage(file)
          if (!wouldFit(used, p.full.size + p.thumb.size)) throw new PhotoError('cap', PHOTO_MESSAGES.cap)
          const id = crypto.randomUUID()
          await photoQueue.enqueue({ id, userId, entryId, full: p.full, thumb: p.thumb, width: p.width, height: p.height, sha256: p.sha256 })
          used += p.full.size + p.thumb.size
          // the photo, then an empty line: the cursor lands after it (a lone selected photo would be replaced by the next)
          editor
            .chain()
            .focus()
            .insertContent([{ type: 'photo', attrs: { mediaId: id, width: p.width, height: p.height } }, { type: 'paragraph' }])
            .run()
        }
      } catch (e) {
        onNotice(e instanceof PhotoError ? e.message : PHOTO_MESSAGES.decode)
      } finally {
        busy.current = false
      }
    },
    [editor, entryId, userId, usedBytes, onNotice],
  )
  useEffect(() => {
    addFilesRef.current = (f) => void addFiles(f)
  }, [addFiles])

  // Another tab wrote newer text: show it, keeping the cursor roughly where it was.
  const lastVersion = useRef(contentVersion)
  useEffect(() => {
    if (!editor || contentVersion === lastVersion.current) return
    lastVersion.current = contentVersion
    const { from, to } = editor.state.selection
    editor.commands.setContent(content as object, { emitUpdate: false })
    const max = editor.state.doc.content.size
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) })
  }, [editor, content, contentVersion])

  useEffect(() => {
    // setEditable() emits an update by default, which would look like typing.
    if (editor && editor.isEditable !== editable) editor.setEditable(editable, false)
  }, [editor, editable])

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            h2: e.isActive('heading', { level: 2 }),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
          }
        : null,
  })

  if (!editor) return null

  return (
    <div className="editor">
      {editable && (
        <div className="toolbar" role="toolbar" aria-label="Formatting">
          <button type="button" aria-label="Bold" aria-pressed={!!active?.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
            <TextB {...ICON} />
          </button>
          <button type="button" aria-label="Italic" aria-pressed={!!active?.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
            <TextItalic {...ICON} />
          </button>
          <button type="button" aria-label="Heading" aria-pressed={!!active?.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
            <TextHTwo {...ICON} />
          </button>
          <button type="button" aria-label="Bulleted list" aria-pressed={!!active?.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}>
            <ListBullets {...ICON} />
          </button>
          <button type="button" aria-label="Numbered list" aria-pressed={!!active?.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
            <ListNumbers {...ICON} />
          </button>
          <button type="button" aria-label="Add a photo" onClick={() => fileInput.current?.click()}>
            <ImageIcon {...ICON} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              void addFiles(files)
            }}
          />
        </div>
      )}
      <PhotoContext.Provider value={{ entryId, editable }}>
        <EditorContent editor={editor} />
      </PhotoContext.Provider>
    </div>
  )
}
