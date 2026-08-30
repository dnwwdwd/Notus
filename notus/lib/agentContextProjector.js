const { getFileById, getFileByPath } = require('./files');
const { formatAttachmentsForPrompt, loadAttachments } = require('./parsedAttachmentStore');
const { formatTurnFrameForPrompt } = require('./agentSemanticRuntime');

function selectedAttachments(frame = {}) {
  const sourceMessageId = Number(frame?.source_message_id || frame?.facts?.source_message_id || 0) || null;
  const conversationId = Number(frame?.conversation_id || 0) || null;
  if (!conversationId) return [];
  const resourceMessageIds = new Set((Array.isArray(frame?.facts?.parsed_resources) ? frame.facts.parsed_resources : [])
    .map((item) => Number(item?.message_id || 0))
    .filter((id) => id > 0));
  return loadAttachments(conversationId).filter((item) => (
    resourceMessageIds.has(Number(item.id))
    || (sourceMessageId && Number(item.sourceMessageId || 0) === sourceMessageId)
  ));
}

function buildCurrentFileMaterial(frame = {}) {
  if (!frame?.intent?.material_policy?.use_current_file) return null;
  const fileId = Number(frame?.intent?.material_policy?.active_file_id || frame?.facts?.active_file?.id || 0) || null;
  if (!fileId) return null;
  const file = getFileById(fileId);
  if (!file) return null;
  return {
    sourceType: 'current_file',
    sourceId: `file-${file.id}-${file.hash || frame?.facts?.active_file?.hash || 'current'}`,
    content: [`当前文件：${file.path}`, `标题：${file.title || ''}`, '', String(file.content || '')].join('\n'),
  };
}

function buildRuntimeSearchMaterial(frame = {}) {
  const search = frame?.facts?.runtime_search;
  if (!search) return null;
  return {
    sourceType: 'web',
    sourceId: `runtime-search-${search.mission_fingerprint || frame.fingerprint}`,
    content: [
      '运行时已执行本轮联网研究。',
      `状态：${search.status || 'unknown'}`,
      search.receipt?.result_ref ? `完整脱敏结果：${search.receipt.result_ref}` : '完整结果载荷不可用。',
      search.receipt?.summary ? `摘要：${search.receipt.summary}` : '',
      '需要查看具体来源时调用 read_tool_result，不要重复发起同一搜索任务。',
    ].filter(Boolean).join('\n'),
  };
}

function buildMentionMaterials(frame = {}) {
  return (Array.isArray(frame?.facts?.mentions) ? frame.facts.mentions : []).flatMap((mention) => {
    if (mention?.type === 'file' && mention.path) {
      let file = null;
      try { file = getFileByPath(mention.path); } catch {}
      if (!file) return [];
      return [{
        sourceType: 'mention',
        sourceId: `file-${file.id}-${file.hash || 'current'}`,
        content: [`显式 Mention 文件：${file.path}`, `标题：${file.title || ''}`, '', String(file.content || '')].join('\n'),
      }];
    }
    if (mention?.type === 'folder' && mention.path) {
      return [{ sourceType: 'mention', sourceId: `folder-${mention.id || mention.path}`, content: `显式 Mention 目录：${mention.path}` }];
    }
    return [];
  });
}

function projectAgentContext(frame = null) {
  if (!frame) return { taskMaterials: [], taskMaterialContext: '' };
  const attachments = selectedAttachments(frame);
  const attachmentContext = formatAttachmentsForPrompt(attachments);
  const materials = [
    ...buildMentionMaterials(frame),
    attachmentContext ? {
      sourceType: 'attachment',
      sourceId: `message-${frame.source_message_id}-attachments`,
      content: attachmentContext,
    } : null,
    buildCurrentFileMaterial(frame),
    buildRuntimeSearchMaterial(frame),
  ].filter(Boolean);
  return {
    taskMaterials: materials,
    taskMaterialContext: formatTurnFrameForPrompt(frame),
  };
}

module.exports = {
  buildCurrentFileMaterial,
  buildMentionMaterials,
  projectAgentContext,
  selectedAttachments,
};
