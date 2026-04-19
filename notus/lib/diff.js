function cloneArticle(article) {
  return {
    ...article,
    blocks: (article.blocks || []).map((block) => ({ ...block })),
  };
}

function computeDiff(oldContent = '', newContent = '') {
  const oldLines = String(oldContent).split('\n');
  const newLines = String(newContent).split('\n');
  const max = Math.max(oldLines.length, newLines.length);
  const diff = [];

  for (let index = 0; index < max; index += 1) {
    const before = oldLines[index];
    const after = newLines[index];
    if (before === after && before !== undefined) {
      diff.push({ type: 'context', text: before });
    } else {
      if (before !== undefined) diff.push({ type: 'remove', text: before });
      if (after !== undefined) diff.push({ type: 'add', text: after });
    }
  }

  return diff;
}

function applyOperation(article, operation) {
  const nextArticle = cloneArticle(article);
  const { blocks } = nextArticle;
  const index = blocks.findIndex((block) => block.id === operation.block_id);

  if (operation.op !== 'insert' && index === -1) {
    return { success: false, error: 'BLOCK_NOT_FOUND' };
  }

  if (operation.op === 'replace') {
    if (operation.old && String(blocks[index].content).trim() !== String(operation.old).trim()) {
      return { success: false, error: 'OLD_MISMATCH' };
    }
    blocks[index].content = operation.new || '';
    return { success: true, article: nextArticle };
  }

  if (operation.op === 'delete') {
    if (operation.old && String(blocks[index].content).trim() !== String(operation.old).trim()) {
      return { success: false, error: 'OLD_MISMATCH' };
    }
    blocks.splice(index, 1);
    return { success: true, article: nextArticle };
  }

  if (operation.op === 'insert') {
    const newBlock = {
      id: operation.new_block_id || `b_${Date.now()}`,
      type: operation.type || 'paragraph',
      content: operation.new || '',
    };
    if (typeof operation.position === 'number') {
      blocks.splice(operation.position, 0, newBlock);
    } else if (operation.position === 'before' && index >= 0) {
      blocks.splice(index, 0, newBlock);
    } else if (index >= 0) {
      blocks.splice(index + 1, 0, newBlock);
    } else {
      blocks.push(newBlock);
    }
    return { success: true, article: nextArticle };
  }

  return { success: false, error: 'UNSUPPORTED_OPERATION' };
}

module.exports = {
  applyOperation,
  computeDiff,
};
