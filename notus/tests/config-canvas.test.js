const assert = require('assert');
const { applySettings } = require('../lib/config');

function runTests() {
  const baseConfig = {
    canvasEnableStyleExtraction: true,
    canvasEnableArticleAnalysis: false,
    canvasGlobalEditSoftMaxBlocks: 12,
    canvasGlobalEditHardMaxBlocks: 20,
    styleExtractionModel: '',
  };

  const next = applySettings(baseConfig, {
    canvas_enable_style_extraction: 'false',
    canvas_enable_article_analysis: 'true',
    canvas_global_edit_soft_max_blocks: '16',
    canvas_global_edit_hard_max_blocks: '24',
    style_extraction_model: 'qwen-plus',
  });

  assert.strictEqual(next.canvasEnableStyleExtraction, false);
  assert.strictEqual(next.canvasEnableArticleAnalysis, true);
  assert.strictEqual(next.canvasGlobalEditSoftMaxBlocks, 16);
  assert.strictEqual(next.canvasGlobalEditHardMaxBlocks, 24);
  assert.strictEqual(next.styleExtractionModel, 'qwen-plus');

  console.log('canvas config tests passed');
}

runTests();
