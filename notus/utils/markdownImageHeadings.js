// tiptap-markdown uses ProseMirror's inline-image serializer for block images.
// Close the image block so the next heading or paragraph starts on a new line.
function serializeBlockImageMarkdown(state, node) {
  const alt = state.esc(node.attrs.alt || '');
  const src = String(node.attrs.src || '').replace(/[()]/g, '\\$&');
  const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : '';
  state.write(`![${alt}](${src}${title})`);
  state.closeBlock(node);
}

// Repair the exact image/heading concatenation previously written by the editor.
// Fenced and indented code remain literal Markdown source.
function repairImageHeadingMarkdown(content = '') {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  let fence = null;
  let changed = false;
  const repaired = lines.map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      const next = { char: marker[1][0], length: marker[1].length };
      if (!fence) fence = next;
      else if (
        fence.char === next.char
        && next.length >= fence.length
        && /^[ \t]*$/.test(line.slice(marker[0].length))
      ) fence = null;
      return line;
    }
    if (fence) return line;
    const match = line.match(/^([ \t]{0,3}(?:!\[[^\]\n]*\]\([^\n]*?\))+)(?:\\)?(#{1,6}[ \t]+.+)$/);
    if (!match) return line;
    changed = true;
    return `${match[1]}\n\n${match[2]}`;
  });
  return changed ? repaired.join('\n') : String(content || '');
}

module.exports = { serializeBlockImageMarkdown, repairImageHeadingMarkdown };
