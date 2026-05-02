const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fixtures = fs.readFileSync(path.join(__dirname, 'knowledge', 'fixtures.jsonl'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((item) => item.suite === 'routing');

const {
  buildRuleBasedPlan,
} = require('../lib/queryPlanner');
const {
  clearKnowledgeHelperCache,
} = require('../lib/knowledgeHelperCache');

function loadQueryPlannerWithMockedLlm(completeChat) {
  const llmPath = require.resolve('../lib/llm');
  const plannerPath = require.resolve('../lib/queryPlanner');
  const originalLlmModule = require.cache[llmPath];

  delete require.cache[plannerPath];
  require.cache[llmPath] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: { completeChat },
  };

  const planner = require('../lib/queryPlanner');

  return {
    planner,
    restore() {
      delete require.cache[plannerPath];
      if (originalLlmModule) {
        require.cache[llmPath] = originalLlmModule;
      } else {
        delete require.cache[llmPath];
      }
    },
  };
}

async function runTests() {
  const clarifyFixture = fixtures.find((item) => item.id === 'route_clarify_pronoun');
  const clarifyPlan = buildRuleBasedPlan(clarifyFixture.query, clarifyFixture.history, { enableClarify: true });
  assert.strictEqual(clarifyPlan.intent, clarifyFixture.expected_intent);
  assert.strictEqual(clarifyPlan.clarify_needed, true);
  assert.ok(clarifyPlan.clarity_score < 0.75);
  assert.ok(clarifyPlan.clarify_question.includes('哪篇笔记') || clarifyPlan.clarify_question.includes('哪个对象'));

  const followUpFixture = fixtures.find((item) => item.id === 'route_follow_up_resolved');
  const followUpPlan = buildRuleBasedPlan(followUpFixture.query, followUpFixture.history, { enableClarify: true });
  assert.strictEqual(followUpPlan.intent, followUpFixture.expected_intent);
  assert.strictEqual(followUpPlan.clarify_needed, false);
  assert.strictEqual(followUpPlan.rewrite_strategy, followUpFixture.expected_rewrite_strategy);
  assert.ok(followUpPlan.standalone_query.includes('上一轮问题'));
  assert.ok(followUpPlan.standalone_query.includes('当前追问'));

  const missingCounterpartFixture = fixtures.find((item) => item.id === 'route_missing_counterpart');
  const missingCounterpartPlan = buildRuleBasedPlan(
    missingCounterpartFixture.query,
    missingCounterpartFixture.history,
    { enableClarify: true }
  );
  assert.strictEqual(missingCounterpartPlan.clarify_needed, true);
  assert.ok(missingCounterpartPlan.ambiguity_flags.length > 0);

  const helperFixture = fixtures.find((item) => item.id === 'route_helper_rewrite');
  let helperCalls = 0;
  clearKnowledgeHelperCache();
  const { planner, restore } = loadQueryPlannerWithMockedLlm(async () => {
    helperCalls += 1;
    return {
      message: {
        content: JSON.stringify({
          intent: 'comparison',
          is_follow_up: false,
          standalone_query: '对比本地缓存和 Redis 缓存的差异',
          expanded_query: '对比本地缓存和 Redis 缓存的差异，重点关注适用场景、网络开销和一致性',
          keywords: ['本地缓存', 'Redis 缓存', '适用场景', '一致性'],
          title_hints: ['本地缓存方案', 'Redis 缓存方案'],
        }),
      },
    };
  });

  try {
    const plan1 = await planner.buildKnowledgeQueryPlan({
      query: helperFixture.query,
      history: helperFixture.history,
      llmConfig: { llmModel: 'qwen3-max' },
      allowLlmRewrite: true,
      enableClarify: true,
      cacheContext: {
        conversation_id: 1,
        query: helperFixture.query,
        active_file_id: 0,
        reference_mode: 'auto',
        reference_file_ids: [],
        history_hash: 'route-helper',
      },
    });

    assert.strictEqual(plan1.intent, helperFixture.expected_intent);
    assert.strictEqual(plan1.helper_call_type, 'rewrite');
    assert.strictEqual(plan1.helper_call_triggered, true);
    assert.strictEqual(plan1.helper_call_cache_hit, false);
    assert.strictEqual(plan1.helper_call_failed, false);
    assert.strictEqual(plan1.rewrite_strategy, 'llm_rewrite');
    assert.ok(plan1.standalone_query.includes('本地缓存'));

    const plan2 = await planner.buildKnowledgeQueryPlan({
      query: helperFixture.query,
      history: helperFixture.history,
      llmConfig: { llmModel: 'qwen3-max' },
      allowLlmRewrite: true,
      enableClarify: true,
      cacheContext: {
        conversation_id: 1,
        query: helperFixture.query,
        active_file_id: 0,
        reference_mode: 'auto',
        reference_file_ids: [],
        history_hash: 'route-helper',
      },
    });

    assert.strictEqual(plan2.helper_call_triggered, true);
    assert.strictEqual(plan2.helper_call_cache_hit, true);
    assert.strictEqual(plan2.helper_call_failed, false);
    assert.strictEqual(helperCalls, 1);
  } finally {
    restore();
    clearKnowledgeHelperCache();
  }

  console.log('knowledge routing tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
