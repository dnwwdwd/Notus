function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function resolveAgentFileLinkFromState({ files = [], operationSets = [], fileId } = {}) {
  const available = (Array.isArray(files) ? files : []).filter(file => positiveId(file?.id));
  const current = available.find(file => positiveId(file.id) === positiveId(fileId));
  if (current) return current;

  // Only an applied create in this session can correct an invented model ID.
  // Link text and paths are never used as file identity.
  const createdIds = new Set();
  for (const set of operationSets || []) {
    if (['rolled_back', 'discarded', 'superseded'].includes(String(set?.status || ''))) continue;
    for (const patch of Array.isArray(set?.patches) ? set.patches : []) {
      if (String(patch?.change_type || patch?.type || patch?.op || '').toLowerCase() !== 'create'
        || !['applied', 'auto_applied'].includes(patch?.status)) continue;
      const recordedId = positiveId(patch.file_id);
      if (recordedId && available.some(file => positiveId(file.id) === recordedId)) createdIds.add(recordedId);
    }
  }
  if (createdIds.size !== 1) return null;
  return available.find(file => positiveId(file.id) === [...createdIds][0]) || null;
}

function normalizeFinalAgentFileLinks(text, sessionId, state = null) {
  const source = String(text || '');
  if (!source.includes('notus://file/')) return source;
  const files = state?.files || require('./files').getAllFiles();
  const operationSets = state?.operationSets || (positiveId(sessionId)
    ? require('./canvasOperationSets').listOperationSetsBySession(sessionId, { includeDiff: false, skipCleanup: true })
    : []);
  return source.split(/(```[\s\S]*?```)/g).map((segment) => {
    if (segment.startsWith('```')) return segment;
    return segment.replace(/\[([^\]\n]+)\]\(notus:\/\/file\/([1-9]\d*)(?:[?#][^)]*)?\)/gi, (_whole, label, fileId) => {
      const file = resolveAgentFileLinkFromState({ files, operationSets, fileId });
      return file ? `[${label}](notus://file/${file.id})` : label;
    });
  }).join('');
}

function safeNormalizeFinalAgentFileLinks(text, sessionId, state = null) {
  try {
    return normalizeFinalAgentFileLinks(text, sessionId, state);
  } catch {
    return String(text || '').replace(/\[([^\]\n]+)\]\(notus:\/\/file\/[1-9]\d*(?:[?#][^)]*)?\)/gi, '$1');
  }
}

module.exports = { resolveAgentFileLinkFromState, normalizeFinalAgentFileLinks, safeNormalizeFinalAgentFileLinks };
