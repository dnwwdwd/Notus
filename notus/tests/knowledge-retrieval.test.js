const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtures = fs.readFileSync(path.join(__dirname, 'knowledge', 'fixtures.jsonl'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((item) => item.suite === 'retrieval');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notus-knowledge-'));
}

function loadKnowledgeModules(tempDir) {
  process.env.NOTUS_RUNTIME_TARGET = 'web';
  process.env.NOTUS_DATA_ROOT = tempDir;

  [
    '../lib/db',
    '../lib/config',
    '../lib/retrieval',
    '../lib/queryPlanner',
    '../lib/knowledgeRuntime',
    '../lib/knowledgeHelperCache',
    '../lib/platform/paths',
    '../lib/platform/profile',
    '../lib/platform/target',
  ].forEach(resetModule);

  const { getDb } = require('../lib/db');
  const { buildSearchText } = require('../lib/tokenizer');
  const retrieval = require('../lib/retrieval');
  const planner = require('../lib/queryPlanner');
  const runtime = require('../lib/knowledgeRuntime');
  const helperCache = require('../lib/knowledgeHelperCache');

  return {
    db: getDb(),
    buildSearchText,
    retrieval,
    planner,
    runtime,
    helperCache,
  };
}

function seedFixtures(db, buildSearchText) {
  const insertFile = db.prepare(`
    INSERT INTO files (path, title, hash, indexed, indexed_at, updated_at)
    VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (file_id, content, type, position, line_start, line_end, heading_path, search_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function addDocument(doc) {
    const fileResult = insertFile.run(doc.path, doc.title, `${doc.title}-hash`);
    const fileId = Number(fileResult.lastInsertRowid);
    let currentHeading = '';
    let line = 1;

    doc.blocks.forEach((block, index) => {
      if (block.type === 'heading') {
        currentHeading = block.content;
      }
      const headingPath = block.type === 'heading' ? block.content : currentHeading;
      const textForSearch = [doc.title, doc.path, headingPath, block.content].filter(Boolean).join('\n');
      insertChunk.run(
        fileId,
        block.content,
        block.type,
        index,
        line,
        line,
        headingPath,
        buildSearchText(textForSearch)
      );
      line += 1;
    });

    return fileId;
  }

  return {
    localCache: addDocument({
      title: '本地缓存方案',
      path: 'notes/cache/local-cache.md',
      blocks: [
        { type: 'heading', content: '本地缓存' },
        { type: 'paragraph', content: '本地缓存延迟低，适合单机读取，但跨实例一致性较弱。' },
        { type: 'paragraph', content: '它通常配合进程内 LRU 策略使用，命中速度快。' },
      ],
    }),
    redisCache: addDocument({
      title: 'Redis 缓存方案',
      path: 'notes/cache/redis-cache.md',
      blocks: [
        { type: 'heading', content: 'Redis 缓存' },
        { type: 'paragraph', content: 'Redis 缓存适合多实例共享，需要关注网络开销和失效策略。' },
        { type: 'paragraph', content: '它更适合跨服务复用和集中失效控制。' },
      ],
    }),
    oidcGuide: addDocument({
      title: 'OIDC 接入说明',
      path: 'notes/auth/oidc-guide.md',
      blocks: [
        { type: 'heading', content: '回调地址' },
        { type: 'paragraph', content: 'OIDC 回调地址需要配置为 https://notus.example.com/api/auth/callback。' },
        { type: 'paragraph', content: '部署时还要同步配置 issuer、client id 和 client secret。' },
      ],
    }),
    oidcIncident: addDocument({
      title: 'OIDC 排查记录',
      path: 'notes/auth/oidc-incident.md',
      blocks: [
        { type: 'heading', content: '登录失败排查' },
        { type: 'paragraph', content: '这篇记录只讨论 OIDC 登录失败和会话失效，不提供地址配置。' },
      ],
    }),
    grayRollout: addDocument({
      title: '灰度开关方案',
      path: 'notes/release/gray-rollout.md',
      blocks: [
        { type: 'heading', content: '灰度开关' },
        { type: 'paragraph', content: '待补正文。' },
      ],
    }),
    releaseFlow: addDocument({
      title: '发布流程复盘',
      path: 'notes/release/release-flow.md',
      blocks: [
        { type: 'heading', content: '发布流程' },
        { type: 'paragraph', content: '第一步准备发布清单，确认版本号、变更范围和回滚方案。' },
        { type: 'paragraph', content: '第二步在预发环境验证数据库迁移、权限配置和监控告警。' },
        { type: 'paragraph', content: '第三步正式发布后观察核心指标，并记录问题和后续处理。' },
      ],
    }),
    apiLimitA: addDocument({
      title: '接口限流说明 A',
      path: 'notes/api/rate-limit-a.md',
      blocks: [
        { type: 'heading', content: '默认限流' },
        { type: 'paragraph', content: '公开 API 默认限流为每分钟 60 次。' },
      ],
    }),
    apiLimitB: addDocument({
      title: '接口限流说明 B',
      path: 'notes/api/rate-limit-b.md',
      blocks: [
        { type: 'heading', content: '默认限流' },
        { type: 'paragraph', content: '公开 API 默认限流为每分钟 120 次。' },
      ],
    }),
  };
}

function makeHelperPlan(fixture) {
  return {
    intent: 'comparison',
    is_follow_up: false,
    standalone_query: '对比本地缓存和 Redis 缓存的差异',
    expanded_query: '对比本地缓存和 Redis 缓存的差异，重点关注适用场景、网络开销和一致性',
    keywords: ['本地缓存', 'Redis 缓存', '适用场景', '一致性'],
    title_hints: ['本地缓存方案', 'Redis 缓存方案'],
    used_llm: true,
    model: 'qwen3-max',
    clarity_score: 0.62,
    ambiguity_flags: ['broad_scope'],
    clarify_needed: false,
    clarify_question: '',
    rewrite_strategy: 'llm_rewrite',
    helper_call_type: 'rewrite',
    helper_call_triggered: true,
    helper_call_cache_hit: false,
    helper_call_failed: false,
    helper_call_latency_ms: 12,
    fallback_reason: '',
    query: fixture.query,
  };
}

function computeReciprocalRank(rankedTitles, expectedTitles) {
  if (expectedTitles.length === 0) return null;
  const index = rankedTitles.findIndex((title) => expectedTitles.includes(title));
  return index === -1 ? 0 : 1 / (index + 1);
}

async function runTests() {
  const tempDir = createTempWorkspace();
  const {
    db,
    buildSearchText,
    retrieval,
    planner,
    runtime,
    helperCache,
  } = loadKnowledgeModules(tempDir);
  const fileIds = seedFixtures(db, buildSearchText);

  const titleToId = {
    '本地缓存方案': fileIds.localCache,
    'Redis 缓存方案': fileIds.redisCache,
    'OIDC 接入说明': fileIds.oidcGuide,
    'OIDC 排查记录': fileIds.oidcIncident,
    '灰度开关方案': fileIds.grayRollout,
    '发布流程复盘': fileIds.releaseFlow,
    '接口限流说明 A': fileIds.apiLimitA,
    '接口限流说明 B': fileIds.apiLimitB,
  };

  const features = {
    enableClarify: true,
    enableConditionalRerank: true,
    enableWeakEvidenceSupplement: true,
    enableConflictMode: true,
  };

  const metrics = {
    hitCount: 0,
    rankedCases: 0,
    reciprocalRankSum: 0,
    clarifyPredicted: 0,
    clarifyCorrect: 0,
    weakPredicted: 0,
    weakCorrect: 0,
    expectedConflict: 0,
    detectedConflict: 0,
    falseGrounded: 0,
    helperTriggered: 0,
    llmCalls: 0,
    requestCount: 0,
  };

  for (const fixture of fixtures) {
    let queryPlan;
    if (fixture.expect_helper) {
      queryPlan = makeHelperPlan(fixture);
    } else {
      queryPlan = buildRuleBasedPlanCompat(planner, fixture.query, fixture.history);
    }

    metrics.requestCount += 1;
    if (queryPlan.clarify_needed) {
      metrics.clarifyPredicted += 1;
      if (fixture.expected_clarify_needed) {
        metrics.clarifyCorrect += 1;
      }
    }
    if (queryPlan.helper_call_triggered) {
      metrics.helperTriggered += 1;
    }

    let answerMode = 'clarify_needed';
    let knowledgeContext = {
      sections: [],
      chunks: [],
      matched_files: [],
      stats: {},
      sufficiency: false,
    };

    if (!queryPlan.clarify_needed) {
      knowledgeContext = await retrieval.retrieveKnowledgeContext(queryPlan, {
        topK: 5,
        activeFileId: fixture.active_file_title ? titleToId[fixture.active_file_title] : null,
        fileIds: Array.isArray(fixture.reference_file_titles)
          ? fixture.reference_file_titles.map((title) => titleToId[title]).filter(Boolean)
          : [],
        restrictToFileIds: fixture.reference_mode === 'manual',
      });

      if (fixture.force_conflict_group) {
        knowledgeContext.sections = knowledgeContext.sections.map((section, index) => (
          index < 2
            ? {
              ...section,
              conflict_group: fixture.force_conflict_group,
              evidence_strength: 0.84,
            }
            : section
        ));
      }

      const answerMeta = runtime.decideKnowledgeAnswerMode({
        queryPlan,
        knowledgeContext,
        features,
        rerankResult: fixture.force_conflict_group ? { rerank_applied: true } : null,
      });
      answerMode = answerMeta.answer_mode;

      if (answerMode === 'weak_evidence') {
        metrics.weakPredicted += 1;
        if (fixture.expected_answer_mode === 'weak_evidence') {
          metrics.weakCorrect += 1;
        }
      }
      if (fixture.expected_answer_mode === 'conflicting_evidence') {
        metrics.expectedConflict += 1;
        if (answerMode === 'conflicting_evidence') {
          metrics.detectedConflict += 1;
        }
      }
      if (answerMode === 'grounded' && fixture.expected_answer_mode !== 'grounded') {
        metrics.falseGrounded += 1;
      }
    }

    assert.strictEqual(answerMode, fixture.expected_answer_mode, `${fixture.id} answer mode mismatch`);

    const rankedTitles = [
      ...knowledgeContext.sections.map((section) => section.file_title),
      ...knowledgeContext.matched_files.map((file) => file.file_title),
      ...knowledgeContext.chunks.map((chunk) => chunk.file_title),
    ].filter(Boolean);

    const expectedTitles = Array.isArray(fixture.expected_titles) ? fixture.expected_titles : [];
    if (expectedTitles.length > 0) {
      metrics.rankedCases += 1;
      if (rankedTitles.some((title) => expectedTitles.includes(title))) {
        metrics.hitCount += 1;
      }
      metrics.reciprocalRankSum += computeReciprocalRank(rankedTitles, expectedTitles);
    }

    if (fixture.expected_top_title) {
      assert.strictEqual(
        knowledgeContext.chunks[0]?.file_title,
        fixture.expected_top_title,
        `${fixture.id} top result mismatch`
      );
    }

    if (Array.isArray(fixture.expected_only_reference_titles)) {
      const allowedTitles = new Set(fixture.expected_only_reference_titles);
      const touchedTitles = [
        ...knowledgeContext.sections.map((section) => section.file_title),
        ...knowledgeContext.chunks.map((chunk) => chunk.file_title),
      ];
      assert.ok(touchedTitles.length > 0, `${fixture.id} should return at least one reference-bound result`);
      assert.ok(
        touchedTitles.every((title) => allowedTitles.has(title)),
        `${fixture.id} returned results outside manual reference scope`
      );
    }

    if (Array.isArray(fixture.expected_section_contains)) {
      const sectionText = knowledgeContext.sections[0]?.content || '';
      fixture.expected_section_contains.forEach((snippet) => {
        assert.ok(sectionText.includes(snippet), `${fixture.id} missing expected section content: ${snippet}`);
      });
    }

    const requestLlmCalls = Number(Boolean(queryPlan.helper_call_triggered))
      + Number(['grounded', 'weak_evidence', 'conflicting_evidence'].includes(answerMode));
    metrics.llmCalls += requestLlmCalls;
  }

  helperCache.clearKnowledgeHelperCache();

  const hitAtK = metrics.rankedCases > 0 ? metrics.hitCount / metrics.rankedCases : 0;
  const mrr = metrics.rankedCases > 0 ? metrics.reciprocalRankSum / metrics.rankedCases : 0;
  const clarifyPrecision = metrics.clarifyPredicted > 0 ? metrics.clarifyCorrect / metrics.clarifyPredicted : 1;
  const weakEvidencePrecision = metrics.weakPredicted > 0 ? metrics.weakCorrect / metrics.weakPredicted : 1;
  const conflictDetectionRate = metrics.expectedConflict > 0 ? metrics.detectedConflict / metrics.expectedConflict : 1;
  const falseGroundedRate = metrics.requestCount > 0 ? metrics.falseGrounded / metrics.requestCount : 0;
  const helperTriggerRate = metrics.requestCount > 0 ? metrics.helperTriggered / metrics.requestCount : 0;
  const avgLlmCallsPerRequest = metrics.requestCount > 0 ? metrics.llmCalls / metrics.requestCount : 0;

  assert.ok(hitAtK >= 0.85, `Hit@K too low: ${hitAtK}`);
  assert.ok(mrr >= 0.75, `MRR too low: ${mrr}`);
  assert.strictEqual(clarifyPrecision, 1, `clarify_precision should be 1, got ${clarifyPrecision}`);
  assert.strictEqual(weakEvidencePrecision, 1, `weak_evidence_precision should be 1, got ${weakEvidencePrecision}`);
  assert.strictEqual(conflictDetectionRate, 1, `conflict_detection_rate should be 1, got ${conflictDetectionRate}`);
  assert.strictEqual(falseGroundedRate, 0, `false_grounded_rate should be 0, got ${falseGroundedRate}`);
  assert.ok(helperTriggerRate <= 0.3, `helper_trigger_rate too high: ${helperTriggerRate}`);
  assert.ok(avgLlmCallsPerRequest <= 1.3, `avg_llm_calls_per_request too high: ${avgLlmCallsPerRequest}`);

  console.log('knowledge retrieval tests passed');
  console.log(JSON.stringify({
    hit_at_k: Number(hitAtK.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
    clarify_precision: Number(clarifyPrecision.toFixed(4)),
    weak_evidence_precision: Number(weakEvidencePrecision.toFixed(4)),
    conflict_detection_rate: Number(conflictDetectionRate.toFixed(4)),
    false_grounded_rate: Number(falseGroundedRate.toFixed(4)),
    helper_trigger_rate: Number(helperTriggerRate.toFixed(4)),
    avg_llm_calls_per_request: Number(avgLlmCallsPerRequest.toFixed(4)),
  }));
}

function buildRuleBasedPlanCompat(planner, query, history) {
  return planner.buildRuleBasedPlan(query, history, { enableClarify: true });
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
