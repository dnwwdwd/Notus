function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function deriveAiReadiness({
  appStatus,
  appStatusLoading,
  llmConfigs = [],
  llmConfigsLoading = false,
  requireIndexedFiles = false,
}) {
  const setup = appStatus?.setup || {};
  const index = appStatus?.index || {};
  const llmConfigured = Boolean(setup.llm_configured) || (!llmConfigsLoading && llmConfigs.length > 0);
  const embeddingConfigured = Boolean(setup.embedding_configured ?? setup.model_configured);
  const totalFiles = toNumber(index.total ?? setup.total_files);
  const indexedFiles = toNumber(index.indexed ?? setup.indexed_files);
  const hasImportedFiles = totalFiles > 0;
  const hasIndexedFiles = indexedFiles > 0;
  const loading = Boolean(appStatusLoading || llmConfigsLoading);
  const configReady = !loading && llmConfigured && embeddingConfigured;
  const indexReady = !requireIndexedFiles || !hasImportedFiles || hasIndexedFiles;
  const ready = configReady && indexReady;

  let reason = null;
  if (!llmConfigured) reason = 'llm';
  else if (!embeddingConfigured) reason = 'embedding';
  else if (!indexReady) reason = 'index';

  return {
    ready,
    loading,
    reason,
    llmConfigured,
    embeddingConfigured,
    hasImportedFiles,
    hasIndexedFiles,
  };
}
