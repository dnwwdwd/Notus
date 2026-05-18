import { Extension, mergeAttributes } from '@tiptap/core';
import Paragraph from '@tiptap/extension-paragraph';
import Heading from '@tiptap/extension-heading';
import markdownitContainer from 'markdown-it-container';

function buildTextAlignAttribute() {
  return {
    default: null,
    parseHTML: (element) => {
      const attrValue = String(
        element.getAttribute('data-text-align')
        || element.parentElement?.getAttribute?.('data-text-align')
        || element.style.textAlign
        || element.parentElement?.style?.textAlign
        || ''
      ).trim().toLowerCase();
      return attrValue === 'center' ? 'center' : null;
    },
    renderHTML: (attributes) => {
      if (attributes.textAlign !== 'center') return {};
      return {
        'data-text-align': 'center',
        style: 'text-align: center;',
      };
    },
  };
}

function addTextAlignAttribute(base = {}) {
  return {
    ...base,
    textAlign: buildTextAlignAttribute(),
  };
}

function installCenterBlockParser(markdownit) {
  markdownit.use(markdownitContainer, 'align-center', {
    render(tokens, index) {
      return tokens[index].nesting === 1
        ? '<div data-text-align="center">'
        : '</div>';
    },
  });
}

function withCenterMarkdownSerialization(renderInner) {
  return (node, helpers, context = {}) => {
    const output = renderInner(node, helpers, context);
    if (node?.attrs?.textAlign !== 'center' || !output) return output;
    return `<div data-text-align="center">\n${output}\n</div>`;
  };
}

const TextAlignCenter = Extension.create({
  name: 'textAlignCenter',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          textAlign: buildTextAlignAttribute(),
        },
      },
    ];
  },

  addCommands() {
    return {
      toggleTextAlignCenter: () => ({ editor, commands }) => {
        const nextValue = editor.isActive({ textAlign: 'center' }) ? null : 'center';
        const heading = [1, 2, 3, 4, 5, 6].find((level) => editor.isActive('heading', { level }));
        return commands.updateAttributes(heading ? 'heading' : 'paragraph', { textAlign: nextValue });
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdownit) {
            installCenterBlockParser(markdownit);
          },
        },
      },
    };
  },
});

const CenterParagraph = Paragraph.extend({
  addAttributes() {
    return addTextAlignAttribute(this.parent?.() || {});
  },
  renderHTML({ HTMLAttributes }) {
    return ['p', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
  renderMarkdown(node, helpers, context) {
    return withCenterMarkdownSerialization(Paragraph.config.renderMarkdown)(node, helpers, context);
  },
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdownit) {
            installCenterBlockParser(markdownit);
          },
        },
      },
    };
  },
});

const CenterHeading = Heading.extend({
  addAttributes() {
    return addTextAlignAttribute(this.parent?.() || {});
  },
  renderHTML({ node, HTMLAttributes }) {
    const hasLevel = this.options.levels.includes(node.attrs.level);
    const level = hasLevel ? node.attrs.level : this.options.levels[0];
    return [`h${level}`, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
  renderMarkdown(node, helpers, context) {
    return withCenterMarkdownSerialization(Heading.config.renderMarkdown)(node, helpers, context);
  },
  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdownit) {
            installCenterBlockParser(markdownit);
          },
        },
      },
    };
  },
});

export {
  TextAlignCenter,
  CenterParagraph,
  CenterHeading,
};
