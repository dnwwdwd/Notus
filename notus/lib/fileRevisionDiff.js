const crypto = require('crypto');
const { createDiffHunks, normalizeRevisionContent } = require('../utils/lineDiff');

function hashRevisionContent(content = '') {
  return crypto.createHash('sha256').update(normalizeRevisionContent(content), 'utf8').digest('hex');
}

module.exports = { createDiffHunks, hashRevisionContent, normalizeRevisionContent };
