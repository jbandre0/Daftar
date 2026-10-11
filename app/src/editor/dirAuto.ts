import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * Every block takes its direction from its first strong character (spec §8, "RTL and mixed text").
 * Done with view decorations, not node attributes, so the saved JSON stays free of dir noise.
 */
function build(doc: PMNode) {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock || node.type.name === 'listItem') {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { dir: 'auto' }))
    }
    return !node.isTextblock
  })
  return DecorationSet.create(doc, decos)
}

const key = new PluginKey<DecorationSet>('dirAuto')

export const DirAuto = Extension.create({
  name: 'dirAuto',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state),
        },
      }),
    ]
  },
})
