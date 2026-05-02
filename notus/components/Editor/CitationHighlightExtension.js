import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const citationHighlightPluginKey = new PluginKey('citationHighlight');

function normalizeRange(range, doc) {
  const max = doc.content.size;
  const from = Math.max(0, Math.min(Number(range?.from), max));
  const to = Math.max(from, Math.min(Number(range?.to), max));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;

  return {
    from,
    to,
    persistent: Boolean(range?.persistent),
  };
}

function buildDecorationSet(doc, ranges = []) {
  const decorations = ranges
    .map((range) => normalizeRange(range, doc))
    .filter(Boolean)
    .map((range) => Decoration.inline(
      range.from,
      range.to,
      {
        class: range.persistent ? 'citation-highlight-persistent' : 'citation-highlight',
        'data-citation-highlight': range.persistent ? 'persistent' : 'flash',
      }
    ));

  return DecorationSet.create(doc, decorations);
}

export const CitationHighlight = Extension.create({
  name: 'citationHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: citationHighlightPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, oldSet) {
            const meta = tr.getMeta(citationHighlightPluginKey);
            if (meta?.type === 'clear') return DecorationSet.empty;
            if (meta?.type === 'set') return buildDecorationSet(tr.doc, meta.ranges || []);
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return citationHighlightPluginKey.getState(state);
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setCitationHighlight: (ranges = []) => ({ state, dispatch }) => {
        const input = Array.isArray(ranges) ? ranges : [ranges];
        const normalized = input.map((range) => normalizeRange(range, state.doc)).filter(Boolean);

        if (dispatch) {
          dispatch(state.tr.setMeta(citationHighlightPluginKey, {
            type: 'set',
            ranges: normalized,
          }));
        }

        return true;
      },
      clearCitationHighlight: () => ({ state, dispatch }) => {
        if (dispatch) {
          dispatch(state.tr.setMeta(citationHighlightPluginKey, { type: 'clear' }));
        }

        return true;
      },
    };
  },
});
