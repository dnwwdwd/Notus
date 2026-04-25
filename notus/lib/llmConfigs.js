const { getDb, removeSettings, setSettings } = require('./db');
const { readEnvConfig } = require('./config');

const LLM_SETTING_KEYS = [
  'llm_provider',
  'llm_model',
  'llm_base_url',
  'llm_api_key',
];

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function mapRow(row, { includeSecret = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    base_url: row.base_url,
    api_key: includeSecret ? row.api_key : undefined,
    api_key_set: Boolean(row.api_key),
    is_active: Boolean(row.is_active),
    last_test_latency_ms: row.last_test_latency_ms === null ? null : Number(row.last_test_latency_ms),
    last_tested_at: row.last_tested_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listLlmConfigs(options = {}) {
  const rows = getDb().prepare(`
    SELECT id, name, provider, model, base_url, api_key, is_active, last_test_latency_ms, last_tested_at, created_at, updated_at
    FROM llm_configs
    ORDER BY is_active DESC, updated_at DESC, id DESC
  `).all();
  return rows.map((row) => mapRow(row, options));
}

function getLlmConfigById(id, options = {}) {
  const row = getDb().prepare(`
    SELECT id, name, provider, model, base_url, api_key, is_active, last_test_latency_ms, last_tested_at, created_at, updated_at
    FROM llm_configs
    WHERE id = ?
  `).get(Number(id));
  return mapRow(row, options);
}

function getActiveLlmConfig(options = {}) {
  const row = getDb().prepare(`
    SELECT id, name, provider, model, base_url, api_key, is_active, last_test_latency_ms, last_tested_at, created_at, updated_at
    FROM llm_configs
    WHERE is_active = 1
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `).get();
  return mapRow(row, options);
}

function syncActiveConfigToSettings(config) {
  if (!config) {
    removeSettings(LLM_SETTING_KEYS);
    return;
  }

  setSettings({
    llm_provider: config.provider,
    llm_model: config.model,
    llm_base_url: config.base_url,
    llm_api_key: config.api_key,
  });
}

function setActiveLlmConfig(id) {
  const database = getDb();
  const normalizedId = Number(id);
  const existing = database.prepare('SELECT id FROM llm_configs WHERE id = ?').get(normalizedId);
  if (!existing) throw new Error('LLM 配置不存在');

  database.transaction(() => {
    database.prepare('UPDATE llm_configs SET is_active = 0, updated_at = datetime(\'now\') WHERE is_active = 1').run();
    database.prepare('UPDATE llm_configs SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(normalizedId);
  })();

  const nextActive = getLlmConfigById(normalizedId, { includeSecret: true });
  syncActiveConfigToSettings(nextActive);
  return getLlmConfigById(normalizedId);
}

function createLlmConfig(input = {}) {
  const database = getDb();
  const name = String(input.name || '').trim();
  const provider = String(input.provider || '').trim();
  const model = String(input.model || '').trim();
  const baseUrl = normalizeBaseUrl(input.base_url);
  const apiKey = String(input.api_key || '').trim();
  const setDefault = Boolean(input.set_default);
  const latency = input.last_test_latency_ms === undefined || input.last_test_latency_ms === null
    ? null
    : Number(input.last_test_latency_ms);

  if (!name) throw new Error('配置名称不能为空');
  if (!provider) throw new Error('LLM Provider 不能为空');
  if (!model) throw new Error('LLM 模型不能为空');
  if (!baseUrl) throw new Error('LLM Base URL 不能为空');
  if (!apiKey) throw new Error('LLM API Key 不能为空');

  const hasActive = database.prepare('SELECT id FROM llm_configs WHERE is_active = 1 LIMIT 1').get();
  const shouldActivate = setDefault || !hasActive;

  const result = database.transaction(() => {
    if (shouldActivate) {
      database.prepare('UPDATE llm_configs SET is_active = 0, updated_at = datetime(\'now\') WHERE is_active = 1').run();
    }

    return database.prepare(`
      INSERT INTO llm_configs (
        name, provider, model, base_url, api_key, is_active, last_test_latency_ms, last_tested_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      name,
      provider,
      model,
      baseUrl,
      apiKey,
      shouldActivate ? 1 : 0,
      Number.isFinite(latency) ? latency : null
    );
  })();

  const created = getLlmConfigById(result.lastInsertRowid, { includeSecret: true });
  if (created?.is_active) syncActiveConfigToSettings(created);
  return getLlmConfigById(result.lastInsertRowid);
}

function updateLlmConfig(id, input = {}) {
  const database = getDb();
  const normalizedId = Number(id);
  const existing = getLlmConfigById(normalizedId, { includeSecret: true });
  if (!existing) throw new Error('LLM 配置不存在');

  const next = {
    name: String(input.name ?? existing.name).trim(),
    provider: String(input.provider ?? existing.provider).trim(),
    model: String(input.model ?? existing.model).trim(),
    base_url: normalizeBaseUrl(input.base_url ?? existing.base_url),
    api_key: String(input.api_key || '').trim() || existing.api_key,
    set_default: input.set_default === undefined ? existing.is_active : Boolean(input.set_default),
    last_test_latency_ms: input.last_test_latency_ms === undefined
      ? existing.last_test_latency_ms
      : Number(input.last_test_latency_ms),
  };

  if (!next.name) throw new Error('配置名称不能为空');
  if (!next.provider) throw new Error('LLM Provider 不能为空');
  if (!next.model) throw new Error('LLM 模型不能为空');
  if (!next.base_url) throw new Error('LLM Base URL 不能为空');
  if (!next.api_key) throw new Error('LLM API Key 不能为空');

  database.transaction(() => {
    if (next.set_default) {
      database.prepare('UPDATE llm_configs SET is_active = 0, updated_at = datetime(\'now\') WHERE is_active = 1 AND id != ?').run(normalizedId);
    }

    database.prepare(`
      UPDATE llm_configs
      SET
        name = ?,
        provider = ?,
        model = ?,
        base_url = ?,
        api_key = ?,
        is_active = ?,
        last_test_latency_ms = ?,
        last_tested_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      next.name,
      next.provider,
      next.model,
      next.base_url,
      next.api_key,
      next.set_default ? 1 : 0,
      Number.isFinite(next.last_test_latency_ms) ? next.last_test_latency_ms : null,
      normalizedId
    );
  })();

  const updated = getLlmConfigById(normalizedId, { includeSecret: true });
  if (updated?.is_active) syncActiveConfigToSettings(updated);
  return getLlmConfigById(normalizedId);
}

function deleteLlmConfig(id) {
  const database = getDb();
  const normalizedId = Number(id);
  const existing = getLlmConfigById(normalizedId, { includeSecret: true });
  if (!existing) throw new Error('LLM 配置不存在');

  database.prepare('DELETE FROM llm_configs WHERE id = ?').run(normalizedId);

  if (existing.is_active) {
    const fallback = database.prepare(`
      SELECT id
      FROM llm_configs
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get();

    if (fallback?.id) {
      return setActiveLlmConfig(fallback.id);
    }

    syncActiveConfigToSettings(null);
  }

  return null;
}

function resolveLlmRuntimeConfig({ llmConfigId, model } = {}) {
  const selected = llmConfigId
    ? getLlmConfigById(llmConfigId, { includeSecret: true })
    : getActiveLlmConfig({ includeSecret: true });

  if (!selected) return null;

  return {
    ...readEnvConfig(),
    llmProvider: selected.provider,
    llmModel: String(model || selected.model).trim() || selected.model,
    llmBaseUrl: selected.base_url,
    llmApiKey: selected.api_key,
  };
}

module.exports = {
  listLlmConfigs,
  getLlmConfigById,
  getActiveLlmConfig,
  createLlmConfig,
  updateLlmConfig,
  deleteLlmConfig,
  setActiveLlmConfig,
  resolveLlmRuntimeConfig,
};
