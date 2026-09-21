import { Extension } from '@tiptap/core';
import { splitBareUrlLabel } from '../../utils/markdownLinks.js';

const configuredParsers = new WeakSet();

// Change only Markdown auto-links, never explicit destinations or code.
export const MarkdownLinkBoundary = Extension.create({
  name: 'markdownLinkBoundary',
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(md) {
            if (configuredParsers.has(md)) return;
            configuredParsers.add(md);
            md.core.ruler.after('linkify', 'notus_autolink_boundary', (state) => {
              for (const block of state.tokens) {
                const tokens = block.children || [];
                for (let i = 0; i < tokens.length - 2; i++) {
                  const [open, text, close] = tokens.slice(i, i + 3);
                  if (open.type !== 'link_open' || !['autolink', 'linkify'].includes(open.markup)
                    || text.type !== 'text' || close.type !== 'link_close') continue;
                  const split = splitBareUrlLabel(text.content);
                  if (!split) continue;
                  open.attrSet('href', md.normalizeLink(split.url));
                  text.content = split.url;
                  const suffix = new state.Token('text', '', 0);
                  suffix.content = split.suffix;
                  suffix.level = close.level;
                  tokens.splice(i + 3, 0, suffix);
                  i += 3;
                }
              }
            });
          },
        },
      },
    };
  },
});
