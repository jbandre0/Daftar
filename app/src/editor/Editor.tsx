import { useEffect, useRef } from 'react'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { TextB, TextItalic, TextHTwo, ListBullets, ListNumbers, Image as ImageIcon } from '@phosphor-icons/react'
import { DirAuto } from './dirAuto'

const ICON = { size: 20, weight: 'light' as const }

type Props = {
  /** ProseMirror JSON. Only read on mount and when `contentVersion` changes (another tab wrote). */
  content: unknown
  contentVersion: number
  editable: boolean
  onChange: (doc: { body_rich: unknown; body_text: string }) => void
  onBlur: () => void
}

export function Editor({ content, contentVersion, editable, onChange, onBlur }: Props) {
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  onChangeRef.current = onChange
  onBlurRef.current = onBlur

  const editor = useEditor({
    extensions: [
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
    },
    onUpdate: ({ editor }) =>
      onChangeRef.current({ body_rich: editor.getJSON(), body_text: editor.getText({ blockSeparator: '\n\n' }) }),
    onBlur: () => onBlurRef.current(),
  })

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
          <button type="button" aria-label="Add a photo (coming soon)" disabled title="Photos arrive in a later update">
            <ImageIcon {...ICON} />
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  )
}
