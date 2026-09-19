// Provider reasoning fields are handled separately; tagged reasoning must also
// stay out of both streamed drafts and final answers, including split tags.
function visibleText(raw = '') {
  let source = String(raw || '');
  const tagStart = source.lastIndexOf('<');
  if (tagStart >= 0) {
    const tail = source.slice(tagStart).toLowerCase();
    if (['<think>', '</think>', '<thinking>', '</thinking>'].some((tag) => tag.startsWith(tail))) {
      source = source.slice(0, tagStart);
    }
  }
  const tags = /<(\/?)(think|thinking)>/gi;
  const stack = [];
  let result = '';
  let offset = 0;
  for (const match of source.matchAll(tags)) {
    if (!stack.length) result += source.slice(offset, match.index);
    if (!match[1]) stack.push(match[2].toLowerCase());
    else if (stack.at(-1) === match[2].toLowerCase()) stack.pop();
    offset = match.index + match[0].length;
  }
  if (!stack.length) result += source.slice(offset);
  return result;
}

function createVisibleTextStream() {
  let raw = '';
  let visible = '';
  return {
    push(chunk = '') {
      raw += String(chunk || '');
      const next = visibleText(raw);
      const delta = next.slice(visible.length);
      visible = next;
      return delta;
    },
    text() { return visible; },
  };
}

module.exports = { createVisibleTextStream, visibleText };
