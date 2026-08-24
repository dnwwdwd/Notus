const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderAgentLoopPrompt } = require('../lib/prompt/agent-loop/render');

const casesPath = path.join(__dirname, '..', 'tests', 'evals', 'agent-prompt-offline.jsonl');
const cases = fs.readFileSync(casesPath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(JSON.parse);
const session = { id: 1, goal: '离线评测', tool_profile: 'read_only', search_knowledge_limit: 5 };

for (const item of cases) {
  const material = item.material_repeat ? String(item.material_repeat).repeat(Number(item.repeat || 1)) : String(item.material || '');
  let rendered = null;
  let error = null;
  try {
    rendered = renderAgentLoopPrompt(session, {
      contextWindowTokens: item.context_window_tokens || 60_000,
      taskMaterials: [{ sourceType: item.source_type, sourceId: item.id, content: material }],
    });
  } catch (nextError) {
    error = nextError;
  }
  if (item.expect_error) {
    assert.ok(error && item.expect_error.includes(error.code), `${item.id}: expected ${item.expect_error}, got ${error?.code}`);
    continue;
  }
  assert.ifError(error);
  (item.expected_modules || []).forEach((id) => assert.ok(rendered.moduleIds.includes(id), `${item.id}: missing module ${id}`));
  if (item.required_text) assert.ok(rendered.text.includes(item.required_text), `${item.id}: missing required text`);
  if (item.forbidden_literal) assert.ok(!rendered.text.includes(item.forbidden_literal), `${item.id}: leaked forbidden literal`);
}

console.log(`agent prompt offline eval passed (${cases.length} cases)`);
