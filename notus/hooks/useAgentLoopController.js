import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentLoopReasonLabel, getAgentToolLabel } from '../utils/agentDisplay';
import { dispatchAgentResourceChange } from '../utils/agentResourceEvents';
import { rememberAgentSessionToken } from '../utils/agentSessionTokens';

function toPositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function makeMessageId(prefix = 'agent-loop') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readSse(response, onEvent) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('服务未返回可读取的流');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find((item) => item.trim().startsWith('data:'));
      if (!line) continue;
      const raw = line.replace(/^data:\s*/, '').trim();
      if (!raw) continue;
      await onEvent(JSON.parse(raw));
    }
  }

  if (buffer.trim()) {
    const line = buffer.split('\n').find((item) => item.trim().startsWith('data:'));
    if (line) {
      const raw = line.replace(/^data:\s*/, '').trim();
      if (raw) await onEvent(JSON.parse(raw));
    }
  }
}

async function readErrorResponse(response, fallback) {
  const text = await response.text().catch(() => '');
  const parsed = parseJson(text, null);
  const requestId = String(response.headers?.get('x-request-id') || '').trim();
  const suffix = requestId ? `（请求编号：${requestId}）` : '';
  const message = String(parsed?.error || parsed?.code || '').trim();
  if (message && !/<\/?[a-z][^>]*>/i.test(message)) return `${message}${suffix}`;

  // Next.js 的兜底 500 页、反向代理错误页等非 JSON 内容不能作为聊天正文渲染。
  // 仅向用户提供 HTTP 状态与可用于查日志的请求编号。
  const status = Number(response.status || 0);
  const statusSuffix = status ? `（HTTP ${status}${requestId ? `，请求编号：${requestId}` : ''}）` : suffix;
  return `${fallback}${statusSuffix}`;
}

function finishRunningStep(step = {}) {
  const finished = { ...step, status: 'done' };
  if (step.kind === 'segment') {
    return {
      ...finished,
      detail: '本执行段已完成。',
      open: false,
    };
  }
  return finished;
}

function upsertStep(list = [], step = null) {
  if (!step) return list;
  const next = Array.isArray(list) ? list.map((item) => (
    step.status === 'running' && item.status === 'running' && item.id !== step.id
      ? finishRunningStep(item)
      : item
  )) : [];
  const index = next.findIndex((item) => item.id === step.id);
  const now = new Date().toISOString();
  if (index >= 0) {
    const previous = next[index];
    const appendDetail = Boolean(step.appendDetail);
    const nextDetail = appendDetail
      ? `${String(previous.detail || '')}${String(step.detail || '')}`
      : step.detail;
    next[index] = {
      ...previous,
      ...step,
      ...(appendDetail ? { detail: nextDetail } : {}),
      createdAt: next[index].createdAt || step.createdAt || now,
      updatedAt: step.updatedAt || now,
    };
  } else {
    next.push({
      ...step,
      createdAt: step.createdAt || now,
      updatedAt: step.updatedAt || step.createdAt || now,
    });
  }
  return next;
}

function completeSteps(list = [], { resolveOperationConfirmations = false } = {}) {
  return (Array.isArray(list) ? list : []).map((step) => {
    if (step.status === 'running') return finishRunningStep(step);
    if (
      resolveOperationConfirmations
      && step.status === 'waiting'
      && (step.id?.startsWith('operation-confirmation-') || step.kind === 'operation_batch')
    ) {
      return {
        ...step,
        status: 'done',
        label: step.kind === 'operation_batch' ? '修改批次已处理' : '已确认文件修改',
        detail: step.kind === 'operation_batch'
          ? '该批修改已处理。'
          : '修改确认已处理。',
        open: false,
      };
    }
    return step;
  });
}

function toolLabel(name = '') {
  return getAgentToolLabel(name) || '执行工具';
}

function reasonLabel(reason = '') {
  return getAgentLoopReasonLabel(reason);
}

function executionSegmentFields(event = {}) {
  const executionSegmentId = toPositiveInt(event.execution_segment_id || event.executionSegmentId);
  const sequenceNo = Number(event.segment_sequence_no || event.segmentSequenceNo || 0) || 0;
  return {
    executionSegmentId,
    segmentSequenceNo: sequenceNo,
  };
}

function executionSegmentLabel(event = {}) {
  const { segmentSequenceNo } = executionSegmentFields(event);
  return segmentSequenceNo ? `第 ${segmentSequenceNo} 个执行段` : '当前执行段';
}

function mediaKey(item = {}) {
  return String(item?.id || item?.stored_name || item?.storedName || item?.name || '');
}

function buildUserMessageMedia(input = {}, conversationId = null) {
  const images = Array.isArray(input.images) ? input.images : [];
  const imagesByKey = new Map(images.map((image) => [mediaKey(image), image]).filter(([key]) => key));
  const mediaItems = Array.isArray(input.media_items)
    ? input.media_items
    : Array.isArray(input.mediaItems)
      ? input.mediaItems
      : Array.isArray(input.attachments)
        ? input.attachments
        : [];
  const seenImages = new Set();
  const merged = mediaItems.map((item) => {
    const key = mediaKey(item);
    const image = imagesByKey.get(key);
    if (!image) return { ...item, conversation_id: conversationId || item?.conversation_id || item?.conversationId || null };
    seenImages.add(key);
    return {
      ...item,
      ...image,
      source_kind: 'image',
      media_kind: 'image',
      conversation_id: conversationId || image?.conversation_id || image?.conversationId || null,
    };
  });
  images.forEach((image) => {
    const key = mediaKey(image);
    if (key && seenImages.has(key)) return;
    merged.push({
      ...image,
      source_kind: 'image',
      media_kind: 'image',
      conversation_id: conversationId || image?.conversation_id || image?.conversationId || null,
    });
  });
  return merged.sort((left, right) => Number(left?.upload_order || 0) - Number(right?.upload_order || 0));
}

function buildEventStep(event = {}) {
  const loop = Number(event.loop_index || 0) || 0;
  if (event.type === 'task_state') {
    // 队列状态和轮次属于实现细节，不作为用户的工具调用记录。
    return null;
  }
  if (event.type === 'progress') return buildEventStep({ ...event, type: event.stage || 'thinking' });
  if (event.type === 'artifact' && event.artifact_type === 'interaction') {
    return buildEventStep({ ...event, type: 'interaction_request' });
  }
  if (event.type === 'artifact' && event.artifact_type === 'limit_confirmation') {
    return buildEventStep({ ...event, type: 'loop_done', reason: event.reason || 'hard_limit_reached' });
  }
  if (event.type === 'artifact' && event.artifact_type === 'operation_confirmation') {
    const segment = executionSegmentFields(event);
    return {
      id: `operation-confirmation-${event.execution_segment_id || event.loop_index || 'current'}`,
      kind: 'operation_confirmation',
      ...segment,
      label: '等待确认文件修改',
      status: 'waiting',
      detail: event.text || '已保存这批修改预览，可手动应用或废弃。',
      tool: 'preview_patch_files',
      result: event.operation_set_id ? `修改批次 #${event.operation_set_id}` : '修改预览已生成',
      open: true,
    };
  }
  if (event.type === 'artifact' && event.artifact_type === 'run_error') {
    const segment = executionSegmentFields(event);
    const actionRequired = event.error_category === 'action_required';
    const errorMessage = event.message || event.error || '模型请求失败，当前任务进度已保留。';
    return {
      id: `llm-retry-${event.execution_segment_id || event.segment_sequence_no || event.loop_index || 'current'}`,
      kind: 'llm_error',
      ...segment,
      label: actionRequired ? '模型服务需要处理' : '模型请求失败',
      status: 'error',
      detail: actionRequired ? '请处理模型服务配置后再继续，或重新发送这条任务。' : '任务进度已保留，可以重新发送这条任务。',
      tool: 'llm_request',
      result: event.retry_attempts > 0 ? `已重试 ${event.retry_attempts} 次` : (event.error_code || ''),
      open: true,
      action: event.resumable ? 'resume_agent' : '',
      actionLabel: actionRequired ? '配置完成后继续' : '继续任务',
      errorType: 'agent',
      errorMessage,
      errorCode: event.error_code || '',
      requestId: event.request_id || event.requestId || '',
      diagnostics: event.diagnostics || null,
    };
  }
  if (event.type === 'final') {
    return null;
  }
  if (event.type === 'session_created') {
    return null;
  }
  if (event.type === 'session_resumed') {
    return null;
  }
  if (event.type === 'snapshot_done') {
    return null;
  }
  if (event.type === 'attachment_parse_start') {
    const source = String(event.source || '附件');
    return {
      id: `attachment-${source}`,
      label: event.source_kind === 'url' ? '解析网页链接' : '解析上传附件',
      status: 'running',
      detail: `正在读取：${source}`,
      tool: event.source_kind === 'url' ? 'parse_url' : 'parse_document',
      input: source,
    };
  }
  if (event.type === 'attachment_parse_done') {
    const source = String(event.source || '附件');
    const failed = event.status === 'error';
    const duplicate = Boolean(event.duplicate);
    return {
      id: `attachment-${source}`,
      label: event.source_kind === 'url' ? '解析网页链接' : '解析上传附件',
      status: failed ? 'error' : 'done',
      detail: failed
        ? (event.warning || '解析失败')
        : duplicate
          ? '已在本次对话中导入，跳过重复解析。'
          : `已读取 ${Number(event.textLength || 0)} 字。${event.warning ? `\n${event.warning}` : ''}`,
      tool: event.source_kind === 'url' ? 'parse_url' : 'parse_document',
      result: failed ? (event.errorCode || 'PARSE_FAILED') : `${Number(event.textLength || 0)} 字`,
    };
  }
  if (event.type === 'loop_start') {
    const segment = executionSegmentFields(event);
    return {
      id: `segment-${segment.executionSegmentId || event.loop_index || 'current'}`,
      kind: 'segment',
      ...segment,
      label: executionSegmentLabel(event),
      status: 'running',
      detail: '正在等待模型响应。',
      open: true,
    };
  }
  if (event.type === 'model_requesting') {
    const segment = executionSegmentFields(event);
    return {
      id: `segment-${segment.executionSegmentId || event.loop_index || 'current'}`,
      kind: 'segment',
      ...segment,
      label: executionSegmentLabel(event),
      status: 'running',
      detail: '正在等待模型响应。',
      open: true,
    };
  }
  if (event.type === 'image_view_start' || event.type === 'image_view_done' || event.type === 'image_recognition_done') {
    const count = Number(event.image_count || event.images?.length || 0);
    const isStart = event.type === 'image_view_start';
    const failed = !isStart && event.status === 'error';
    return {
      id: `image-view-${event.message_id || loop || 'current'}`,
      label: count > 1 ? `查看 ${count} 张图片` : '查看图片',
      status: isStart ? 'running' : failed ? 'error' : 'done',
      detail: failed ? '图片查看未完成，已继续执行后续任务。' : isStart ? '正在读取本轮提交的图片。' : '已读取本轮提交的图片。',
      tool: 'view_images',
      result: failed ? (event.error || event.error_code || 'IMAGE_VIEW_FAILED') : `已查看 ${count || 1} 张图片`,
      images: Array.isArray(event.images) ? event.images : [],
      open: true,
    };
  }
  if (event.type === 'llm_retry') {
    const segment = executionSegmentFields(event);
    return {
      id: `llm-retry-${event.execution_segment_id || event.segment_sequence_no || loop || 'current'}`,
      kind: 'llm_retry',
      ...segment,
      label: '重试模型请求',
      status: 'running',
      detail: event.text || `正在进行第 ${event.retry_attempt || '?'} 次重试。`,
      tool: 'llm_request',
      result: event.retry_attempt ? `${event.retry_attempt}/${event.retry_limit || 5}` : '',
      open: true,
    };
  }
  if (event.type === 'soft_limit_notice') {
    return null;
  }
  if (event.type === 'model_progress') {
    const segment = executionSegmentFields(event);
    return {
      id: `model-progress-${segment.executionSegmentId || loop || 'current'}`,
      kind: 'model_progress',
      ...segment,
      label: '正在思考',
      status: 'running',
      detail: String(event.text || ''),
      appendDetail: true,
      open: true,
    };
  }
  if (event.type === 'thinking') {
    return null;
  }
  if (event.type === 'tool_start') {
    const segment = executionSegmentFields(event);
    const id = `tool-${segment.executionSegmentId || loop || 'x'}-${Number(event.tool_index || 0)}`;
    return {
      id,
      kind: 'tool',
      ...segment,
      label: toolLabel(event.tool_name),
      status: 'running',
      detail: '正在执行工具调用。',
      tool: event.tool_name || '',
      input: event.tool_input_summary || '',
    };
  }
  if (event.type === 'tool_done') {
    const segment = executionSegmentFields(event);
    const id = `tool-${segment.executionSegmentId || loop || 'x'}-${Number(event.tool_index || 0)}`;
    return {
      id,
      kind: 'tool',
      ...segment,
      label: toolLabel(event.tool_name),
      status: event.failed ? 'error' : 'done',
      detail: event.failed ? '工具调用失败。' : '工具调用已完成。',
      tool: event.tool_name || '',
      result: typeof event.result_summary === 'string'
        ? event.result_summary
        : JSON.stringify(event.result_summary || {}),
    };
  }
  if (event.type === 'waiting_preview_confirm') {
    return {
      id: 'waiting-preview',
      label: '等待确认修改预览',
      status: 'waiting',
      detail: '已生成文件修改预览，可手动应用或废弃。',
      tool: 'preview_patch_files',
      result: event.operation_set_id ? `预览 #${event.operation_set_id}` : '预览已生成',
    };
  }
  if (event.type === 'interaction_request') {
    const segment = executionSegmentFields(event);
    return {
      id: `question-card-${event.interaction?.id || loop || 'current'}`,
      kind: 'interaction',
      ...segment,
      label: '等待回答提问卡片',
      status: 'waiting',
      detail: '已生成提问卡片，请回答后继续执行。',
      tool: 'ask_question_card',
      result: event.interaction?.id ? `提问卡片 #${event.interaction.id}` : '提问卡片已生成',
    };
  }
  if (event.type === 'artifact' && event.artifact_type === 'operation_set') {
    const segment = executionSegmentFields(event);
    const fileCount = Number(event.change_file_count || 0);
    const directoryCount = Number(event.change_directory_count || 0);
    const countLabel = [fileCount ? `${fileCount} 个文件` : '', directoryCount ? `${directoryCount} 个目录` : ''].filter(Boolean).join('、') || '文件或目录修改';
    const applied = event.status === 'applied';
    return {
      id: `operation-batch-${event.operation_set_id || segment.executionSegmentId || loop || 'current'}`,
      kind: 'operation_batch',
      ...segment,
      label: applied ? '已应用修改批次' : '已生成修改批次',
      status: applied ? 'done' : 'waiting',
      detail: applied ? `已应用本批 ${countLabel}。` : `本批涉及 ${countLabel}，等待你决定是否应用。`,
      tool: 'preview_patch_files',
      result: event.operation_set_id ? `修改批次 #${event.operation_set_id}` : '修改批次已生成',
      open: !applied,
    };
  }
  if (event.type === 'loop_done') {
    if (['goal_achieved', 'question_card_requested', 'resource_approval_requested', 'waiting_preview_confirm'].includes(event.reason)) return null;
    return {
      id: `loop-done-${event.reason || 'done'}`,
      label: reasonLabel(event.reason),
      status: ['goal_achieved', 'hard_limit_reached'].includes(event.reason) ? 'done' : 'error',
      detail: reasonLabel(event.reason),
    };
  }
  if (event.type === 'cancelled') {
    return {
      id: 'cancelled',
      label: '任务已取消',
      status: 'stopped',
      detail: '用户停止了当前 Agent 任务。',
    };
  }
  if (event.type === 'error') {
    return {
      id: 'error',
      label: '请求失败',
      status: 'error',
      detail: '请求未完成，详细信息见下方错误卡片。',
      errorType: 'agent',
      errorMessage: event.error || 'Agent Loop 请求失败',
      errorCode: event.code || '',
      requestId: event.request_id || event.requestId || '',
    };
  }
  return null;
}

function normalizeOperationSets(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((item) => item?.id);
}

export function buildRestoredAgentTimeline(session = {}) {
  const persistedEvents = (Array.isArray(session.run_events) ? session.run_events : [])
    .map((row) => {
      const payload = row?.payload;
      if (!payload || typeof payload !== 'object' || !String(payload.type || '').trim()) return null;
      return { ...payload, created_at: row?.created_at || '' };
    })
    .filter(Boolean);
  const isCompleted = session.status === 'completed';
  const visiblePersistedEvents = persistedEvents.filter((event) => {
    // 用户已看到最终回复时，之前一次可恢复的模型请求错误已经解决；继续保留只会
    // 误导为当前任务仍待处理。真正失败的 session 不经过这条分支，仍完整展示错误。
    if (isCompleted && event.type === 'artifact' && event.artifact_type === 'run_error') return false;
    return true;
  });
  const legacyLogs = Array.isArray(session.run_logs) ? session.run_logs : [];
  const sourceEvents = visiblePersistedEvents.length > 0
    ? visiblePersistedEvents
    : legacyLogs.filter((row) => row?.tool_name && row.tool_name !== '__run_metadata__').map((row) => ({
      type: 'progress',
      stage: 'tool_done',
      loop_index: row.loop_index,
      tool_name: row.tool_name,
      // 早期 run_logs 没有按当前事件协议进行字段筛选和脱敏。为避免历史 MCP
      // 参数或结果中的凭据重现到页面，只保留工具名称和完成状态。
      tool_input_summary: '',
      result_summary: '历史工具调用已完成（原始参数和结果未显示）',
      failed: row.status === 'failed',
    }));
  let steps = sourceEvents.reduce((current, event) => {
    const step = buildEventStep(event);
    return upsertStep(current, step ? { ...step, createdAt: event.created_at || undefined, updatedAt: event.created_at || undefined } : null);
  }, []);
  steps = steps.map((step) => step.status === 'running'
    ? (isCompleted
      ? finishRunningStep(step)
      : { ...step, status: 'stopped', detail: `${step.detail || '该步骤尚未完成。'}\n连接中断后已暂停。` })
    : step);
  if (isCompleted) {
    steps = completeSteps(steps, { resolveOperationConfirmations: true });
  }

  const draftParts = persistedEvents
    .filter((event) => event.type === 'progress' && event.stage === 'thinking')
    .map((event) => String(event.text || '').trim())
    .filter((text, index, rows) => Boolean(text) && text !== rows[index - 1]);
  // 旧 run_logs 的 thinking 没有统一脱敏协议，不能作为“中断前回复”展示。

  if (['created', 'queued_resume'].includes(session.status)) {
    steps = upsertStep(steps, {
      id: 'resume-interrupted-task',
      label: '任务已暂停，执行记录已保留',
      status: 'stopped',
      detail: '连接或应用已中断，可以从保存点继续执行。',
      action: 'resume_agent',
      actionLabel: '继续任务',
      open: true,
    });
  }
  return {
    steps,
    draft: draftParts.slice(-16).join('\n\n').slice(-64 * 1024),
  };
}

export function applyAgentTimelineEvent(timeline = {}, event = {}) {
  const step = buildEventStep(event);
  let activeSteps = Array.isArray(timeline.activeSteps) ? timeline.activeSteps : [];
  let streamText = String(timeline.streamText || '');
  let sessionStatus = String(timeline.sessionStatus || '');
  let loading = Boolean(timeline.loading);
  let finishedAt = String(timeline.finishedAt || '');
  if (step) activeSteps = upsertStep(activeSteps, step);

  if (event.type === 'task_state') {
    sessionStatus = event.status || sessionStatus || 'queued';
    if (event.status === 'queued') loading = true;
  } else if (event.type === 'session_created' || event.type === 'session_resumed' || event.type === 'loop_start') {
    sessionStatus = 'running';
    loading = true;
  } else if (event.type === 'progress') {
    sessionStatus = 'running';
    loading = true;
    if (event.stage === 'thinking') {
      const text = String(event.text || '').trim();
      if (text && text !== streamText.split('\n\n').pop()) streamText = streamText ? `${streamText}\n\n${text}` : text;
    }
  } else if (event.type === 'thinking') {
    const text = String(event.text || '').trim();
    if (text) streamText = streamText ? `${streamText}\n${text}` : text;
  } else if (event.type === 'assistant_text_replace') {
    streamText = String(event.text || '').trim();
  } else if (event.type === 'waiting_preview_confirm' || event.type === 'interaction_request') {
    sessionStatus = 'waiting_confirm';
    loading = false;
    streamText = '';
  } else if (event.type === 'artifact' && event.artifact_type === 'interaction') {
    sessionStatus = 'waiting_interaction';
    loading = false;
    streamText = '';
  } else if (event.type === 'artifact' && event.artifact_type === 'limit_confirmation') {
    sessionStatus = 'waiting_limit_confirmation';
    loading = false;
    streamText = '';
  } else if (event.type === 'artifact' && event.artifact_type === 'run_error') {
    sessionStatus = event.status || (event.resumable ? 'waiting_retry' : 'failed');
    loading = false;
  } else if (event.type === 'final') {
    sessionStatus = event.status || 'completed';
    activeSteps = completeSteps(activeSteps, { resolveOperationConfirmations: true });
    loading = false;
    streamText = '';
    finishedAt = event.created_at || event.createdAt || new Date().toISOString();
  } else if (event.type === 'loop_done') {
    const waiting = ['hard_limit_reached', 'question_card_requested', 'resource_approval_requested', 'waiting_preview_confirm'].includes(event.reason);
    const failed = ['consecutive_tool_failure', 'deadloop_detected', 'no_progress', 'preview_auto_apply_failed'].includes(event.reason);
    sessionStatus = waiting ? 'waiting_confirm' : failed ? 'failed' : 'completed';
    activeSteps = completeSteps(activeSteps);
    loading = false;
    streamText = '';
    if (!waiting) finishedAt = event.created_at || event.createdAt || new Date().toISOString();
  } else if (event.type === 'cancelled') {
    sessionStatus = 'cancelled';
    activeSteps = completeSteps(activeSteps);
    loading = false;
    streamText = '';
    finishedAt = event.created_at || event.createdAt || new Date().toISOString();
  } else if (event.type === 'error') {
    sessionStatus = 'failed';
    loading = false;
    finishedAt = event.created_at || event.createdAt || new Date().toISOString();
  }

  return { ...timeline, activeSteps, streamText, sessionStatus, loading, finishedAt };
}

const FILE_MUTATION_TOOL_NAMES = new Set([
  'create_note',
  'preview_patch_files',
  'preview_file_revision',
  'preview_file_operations',
]);

export function useAgentLoopController({
  onAppendUserMessage,
  onAppendAssistantMessage,
  onConversationId,
  onConversationSettled,
  onOperationSets,
  onTaskChangeSet,
  onOperationSetHandled,
  onOperationConfirmation,
  onInteractionRequest,
  onApplySuccess,
  onRollbackSuccess,
  onFilesMayHaveChanged,
  onError,
  onSessionTimeline,
} = {}) {
  const [pendingAgentTask, setPendingAgentTask] = useState(null);
  const [activeAgentSession, setActiveAgentSessionState] = useState(null);
  const [activeSteps, setActiveSteps] = useState([]);
  const [streamText, setStreamText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  const controllersRef = useRef(new Set());
  const sessionRef = useRef(null);
  const knownSessionsRef = useRef(new Map());
  const runSequenceRef = useRef(0);
  const subscriptionEpochRef = useRef(0);
  const stepsRef = useRef([]);
  const assistantTextRef = useRef('');
  const filesMayHaveChangedRef = useRef(false);
  const newTaskSubmitInFlightRef = useRef(false);

  useEffect(() => () => {
    // 组件卸载或切换工作区时，先让当前 run 的后续事件失效，再断开本地 SSE。
    // 服务端会把断线任务保留为可恢复状态，旧事件不能继续污染下一段会话 UI。
    runSequenceRef.current += 1;
    subscriptionEpochRef.current += 1;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    knownSessionsRef.current.clear();
    controllerRef.current = null;
  }, []);

  const setActiveAgentSession = useCallback((patchOrUpdater) => {
    // SSE 的 session_created、interaction_request 与 loop_done 可能在同一批次到达。
    // 不能等 React state updater 执行后才写 ref，否则后续事件会取到空 token。
    const previous = sessionRef.current;
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(previous) : patchOrUpdater;
    const next = patch === null ? null : { ...(previous || {}), ...(patch || {}) };
    sessionRef.current = next;
    if (next?.id) knownSessionsRef.current.set(String(next.id), next);
    setActiveAgentSessionState(next);
  }, []);

  const setSteps = useCallback((updater) => {
    setActiveSteps((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      stepsRef.current = next;
      return next;
    });
  }, []);

  const appendStep = useCallback((step) => {
    if (!step) return;
    setSteps((prev) => upsertStep(prev, step));
  }, [setSteps]);

  const createAgentTask = useCallback((task) => {
    setError('');
    setPendingAgentTask({
      authorized_ops: ['modify', 'create'],
      ...task,
      goal: String(task?.goal || '').trim(),
    });
  }, []);

  const cancelAgentTask = useCallback(() => {
    setPendingAgentTask(null);
  }, []);

  const clearActiveAgentSession = useCallback(() => {
    // 这里只解除当前页面与任务流的绑定，不调用取消 API。切换对话、新建对话
    // 或页面卸载时，服务端任务仍按控制面规则进入可恢复状态。
    runSequenceRef.current += 1;
    subscriptionEpochRef.current += 1;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    knownSessionsRef.current.clear();
    controllerRef.current = null;
    setPendingAgentTask(null);
    setActiveAgentSession(null);
    setSteps((steps) => (Array.isArray(steps) && steps.length === 0 ? steps : []));
    setStreamText((text) => (String(text || '') ? '' : text));
    setLoading(false);
    setError('');
  }, [setActiveAgentSession, setSteps]);

  const registerAgentSessions = useCallback((sessions = []) => {
    (Array.isArray(sessions) ? sessions : []).forEach((session) => {
      const sessionId = String(session?.id || '');
      if (!sessionId) return;
      knownSessionsRef.current.set(sessionId, {
        ...(knownSessionsRef.current.get(sessionId) || {}),
        ...session,
      });
    });
  }, []);

  const fetchSessionDetails = useCallback(async (sessionId, access = null, options = {}) => {
    const id = toPositiveInt(sessionId);
    if (!id) return null;
    const token = typeof access === 'string' ? access : access?.token;
    const controlTicket = typeof access === 'object' ? access?.controlTicket : '';
    const response = await fetch(`/api/agent/sessions/${id}`, {
      headers: {
        ...(controlTicket ? { 'x-agent-control-ticket': controlTicket } : {}),
        ...(!controlTicket && token ? { 'x-agent-session-token': token } : {}),
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(await readErrorResponse(response, '读取 Agent 任务状态失败'));
    }
    const payload = await response.json();
    const session = payload.session ? {
      ...payload.session,
      ...(token ? { token } : {}),
      ...(controlTicket ? { control_ticket: controlTicket } : {}),
    } : null;
    if (session && options.activate !== false) setActiveAgentSession(session);
    const operationSets = normalizeOperationSets(payload.operation_sets);
    if (operationSets.length > 0) onOperationSets?.(operationSets);
    if (payload.task_change_set) {
      onTaskChangeSet?.({
        ...payload.task_change_set,
        session_status: session?.status || '',
        read_control_ticket: controlTicket || null,
        session_token: controlTicket ? null : (token || null),
      });
    }
    return { ...payload, session, operation_sets: operationSets };
  }, [onOperationSets, onTaskChangeSet, setActiveAgentSession]);

  const appendAssistant = useCallback((message) => {
    onAppendAssistantMessage?.({
      id: makeMessageId('agent-loop-assistant'),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      ...message,
    });
  }, [onAppendAssistantMessage]);

  const notifyFilesMayHaveChanged = useCallback(async (context = {}) => {
    if (!filesMayHaveChangedRef.current) return;
    filesMayHaveChangedRef.current = false;
    await onFilesMayHaveChanged?.(context);
  }, [onFilesMayHaveChanged]);

  const startAgentLoop = useCallback(async (input, options = {}) => {
    const resumeSessionId = toPositiveInt(input?.session_id || input?.id);
    const resumeToken = input?.session_token || input?.token || sessionRef.current?.token || '';
    const resumeReadTicket = input?.read_ticket || input?.readTicket || input?.control_tickets?.read || '';
    const isResume = Boolean(options.resume || resumeSessionId);
    if (!isResume && newTaskSubmitInFlightRef.current) return;
    if (!isResume) newTaskSubmitInFlightRef.current = true;
    const resumeJobId = input?.resume_job_id || input?.resumeJobId || '';
    const resumeTicket = input?.resume_ticket || input?.resumeTicket || '';
    const resumeEventCursor = Math.max(0, Number(input?.event_cursor ?? input?.eventCursor ?? 0) || 0);
    const subscribeOnly = Boolean(input?.subscribe_only || input?.subscribeOnly);
    const body = isResume
      ? {
        session_id: resumeSessionId,
        session_token: resumeToken,
        control_ticket: input?.control_ticket || input?.controlTicket || sessionRef.current?.control_ticket || undefined,
        read_ticket: resumeReadTicket || undefined,
        subscribe_only: subscribeOnly || undefined,
        interaction_id: input?.interaction_id || input?.interactionId || undefined,
        resume_job_id: resumeJobId || undefined,
        resume_ticket: resumeTicket || undefined,
        llm_config_id: input?.llm_config_id || input?.llmConfigId || undefined,
      }
      : {
        goal: input?.goal,
        user_query: input?.user_query || input?.userQuery || input?.display_query || input?.displayQuery || input?.input_text || input?.inputText || '',
        display_query: input?.display_query || input?.displayQuery || input?.user_query || input?.userQuery || '',
        input_text: input?.input_text || input?.inputText || input?.user_query || input?.userQuery || input?.display_query || input?.displayQuery || '',
        kind: input?.kind || 'agent',
        authorized_ops: input?.authorized_ops || ['modify', 'create'],
        approval_mode: input?.approval_mode || input?.approvalMode || 'auto_confirm',
        conversation_id: input?.conversation_id || undefined,
        active_file_id: input?.active_file_id || undefined,
        llm_config_id: input?.llm_config_id || input?.llmConfigId || undefined,
        attachments: Array.isArray(input?.attachments) ? input.attachments : [],
        images: Array.isArray(input?.images) ? input.images : [],
        media_items: Array.isArray(input?.media_items)
          ? input.media_items
          : (Array.isArray(input?.mediaItems) ? input.mediaItems : []),
        mentions: Array.isArray(input?.mentions) ? input.mentions : [],
        mention_segments: Array.isArray(input?.mention_segments) ? input.mention_segments : (Array.isArray(input?.mentionSegments) ? input.mentionSegments : []),
        web_search_enabled: Boolean(input?.web_search_enabled ?? input?.webSearchEnabled),
        search_provider: input?.search_provider || input?.searchProvider || undefined,
        mcp_selection: input?.mcp_selection ?? input?.mcpSelection ?? { mode: 'off' },
        tool_profile: input?.tool_profile || input?.toolProfile || undefined,
        hide_user_message_bubble: Boolean(input?.hide_user_message_bubble ?? input?.hideUserMessageBubble),
        skip_user_message_append: Boolean(input?.skip_user_message_append || input?.skipUserMessageAppend),
        existing_user_message_id: input?.rewriteUserMessageId || undefined,
      };

    const optimisticUserMessageId = !isResume && options.appendUserMessage && input?.goal && !body.skip_user_message_append
      ? makeMessageId('agent-loop-user')
      : '';

    const runSequence = runSequenceRef.current + 1;
    runSequenceRef.current = runSequence;
    const subscriptionEpoch = subscriptionEpochRef.current;
    const controller = new AbortController();
    controller.eventsConnected = false;
    controllersRef.current.add(controller);
    controllerRef.current = controller;
    assistantTextRef.current = '';
    filesMayHaveChangedRef.current = false;
    setLoading(true);
    setError('');
    setStreamText('');
    setSteps((steps) => (Array.isArray(steps) && steps.length === 0 ? steps : []));
    if (!isResume) setPendingAgentTask(null);
    let taskAccepted = false;
    // 订阅建立前若请求链路异常，恢复逻辑仍可安全使用续跑任务的 ID，
    // 不会触发尚未初始化的块级变量。
    let acceptedSessionId = Number(resumeSessionId || 0);
    let acceptedConversationId = Number(input?.conversation_id || 0) || null;
    let timeline = {
      sessionId: String(resumeSessionId || ''),
      userMessageId: null,
      activeSteps: [],
      streamText: '',
      loading: true,
      sessionStatus: isResume ? 'running' : 'queued',
      startedAt: new Date().toISOString(),
    };
    let sessionAccess = {
      token: resumeToken,
      controlTicket: resumeReadTicket,
    };
    const isSubscriptionActive = () => subscriptionEpoch === subscriptionEpochRef.current && !controller.signal.aborted;
    const isCurrentPresentation = () => isSubscriptionActive() && runSequence === runSequenceRef.current;
    const publishTimeline = (event = null, patch = {}) => {
      const baseTimeline = { ...timeline, ...patch };
      timeline = event ? applyAgentTimelineEvent(baseTimeline, event) : baseTimeline;
      if (timeline.sessionId) onSessionTimeline?.(timeline);
      return timeline;
    };

    const notifyTaskAccepted = (event = {}) => {
      if (taskAccepted || isResume || typeof input?.onTaskAccepted !== 'function') return;
      taskAccepted = true;
      input.onTaskAccepted({
        sessionId: event.session_id || null,
        conversationId: event.conversation_id || null,
      });
    };

    const recoverPersistedSession = async () => {
      const sessionId = Number(acceptedSessionId || resumeSessionId || 0);
      if (!sessionId) return false;
      try {
        const detail = await fetchSessionDetails(sessionId, sessionAccess, { activate: false });
        const persistedSession = detail?.session;
        const persistedStatus = String(persistedSession?.status || '');
        if (!persistedSession || ![
          'waiting_operation_confirmation',
          'waiting_interaction',
          'waiting_retry',
          'waiting_model_recovery',
          'queued',
          'queued_resume',
          'running',
          'completed',
          'cancelled',
          'failed',
        ].includes(persistedStatus)) return false;
        const restoredSession = {
          ...persistedSession,
          token: sessionAccess.token || persistedSession.token || '',
          control_tickets: sessionRef.current?.control_tickets || persistedSession.control_tickets || {},
          run_events: Array.isArray(detail?.run_events) ? detail.run_events : [],
        };
        const restored = buildRestoredAgentTimeline(restoredSession);
        setActiveAgentSession(restoredSession);
        setSteps(restored.steps);
        setStreamText(restoredSession.status === 'completed' ? '' : restored.draft);
        setError('');
        setLoading(false);
        publishTimeline(null, {
          sessionId: String(restoredSession.id),
          activeSteps: restored.steps,
          streamText: restoredSession.status === 'completed' ? '' : restored.draft,
          loading: false,
          sessionStatus: restoredSession.status,
          finishedAt: ['completed', 'cancelled', 'failed'].includes(restoredSession.status) ? new Date().toISOString() : '',
        });
        const finalEvent = [...restoredSession.run_events].reverse().find((row) => row?.payload?.type === 'final')?.payload;
        if (restoredSession.status === 'completed' && finalEvent && isCurrentPresentation()) {
          appendAssistant({
            content: String(finalEvent.text || finalEvent.final_text || '').trim() || reasonLabel(finalEvent.reason),
            meta: {
              agent_loop: true,
              session_id: restoredSession.id,
              status: finalEvent.status || 'completed',
              reason: finalEvent.reason || '',
              operation_set_id: finalEvent.operation_set_id || null,
              research_summary: finalEvent.research_summary || null,
              write_summary: finalEvent.write_summary || null,
              usage: finalEvent.usage || null,
            },
          });
          onConversationSettled?.(restoredSession.conversation_id || acceptedConversationId || null);
        }
        return true;
      } catch {
        return false;
      }
    };

    const appendUserMessage = (event = {}) => {
      if (!options.appendUserMessage || !input?.goal || body.skip_user_message_append) return;
      onAppendUserMessage?.({
        id: Number(event.user_message_id || event.userMessageId || 0) || optimisticUserMessageId || makeMessageId('agent-loop-user'),
        clientMessageId: event.client_message_id || optimisticUserMessageId || '',
        role: 'user',
        content: input.display_query || input.user_query || input.goal,
        createdAt: event.created_at || event.createdAt || new Date().toISOString(),
        conversationId: Number(event.conversation_id || event.conversationId || 0) || null,
        attachments: buildUserMessageMedia({
          ...input,
          // 以服务端在用户消息落库后回传的图片为准。它们已经过格式、归属
          // 和顺序校验，避免前端临时媒体对象丢失会话字段后生成失效预览地址。
          images: Array.isArray(event.images) ? event.images : input.images,
        }, Number(event.conversation_id || event.conversationId || 0) || null),
        mentions: input.mentions || [],
        mentionSegments: input.mention_segments || input.mentionSegments || [],
        meta: {
          agent_loop: true,
          route_reason: input.route_reason || '',
          attachments: input.attachments || [],
          images: input.images || [],
          mentions: input.mentions || [],
          mention_segments: input.mention_segments || input.mentionSegments || [],
          web_search_enabled: Boolean(input?.web_search_enabled ?? input?.webSearchEnabled),
          search_provider: input?.search_provider || input?.searchProvider || null,
          media_items: input.media_items || input.mediaItems || [],
          mcp_selection: input.mcp_selection || input.mcpSelection || { mode: 'off' },
          hide_user_message_bubble: Boolean(input?.hide_user_message_bubble ?? input?.hideUserMessageBubble),
        },
      });
    };

    try {
      if (optimisticUserMessageId) {
        appendUserMessage({ user_message_id: optimisticUserMessageId, client_message_id: optimisticUserMessageId });
      }
      // POST 只创建或唤醒持久化任务；真实执行由服务端 Worker 完成，之后再订阅
      // session 事件。这样断开订阅、切换会话或关闭窗口均不会取消任务。
      const endpoint = '/api/agent/loop/start';
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readErrorResponse(response, 'Agent Loop 请求失败'));
      }

      const accepted = await response.json();
      if (!isResume) newTaskSubmitInFlightRef.current = false;
      if (!isSubscriptionActive()) return;
      acceptedSessionId = Number(accepted.session_id || resumeSessionId || 0);
      if (!acceptedSessionId) throw new Error('服务未返回 Agent 任务 ID');
      controller.agentSessionId = String(acceptedSessionId);
      acceptedConversationId = Number(accepted.conversation_id || input?.conversation_id || 0) || null;
      const acceptedToken = accepted.session_token || resumeToken;
      if (acceptedToken) rememberAgentSessionToken(acceptedSessionId, acceptedToken);
      const suppliedTickets = input?.control_tickets || input?.controlTickets || {};
      const acceptedTickets = accepted.control_tickets || (isResume ? {
        ...suppliedTickets,
        read: resumeReadTicket || suppliedTickets.read || '',
        resume: input?.control_ticket || input?.controlTicket || suppliedTickets.resume || '',
      } : (sessionRef.current?.control_tickets || {}));
      sessionAccess = { token: acceptedToken, controlTicket: acceptedTickets.read || '' };
      if (!isResume) {
        appendUserMessage({
          user_message_id: accepted.user_message_id,
          conversation_id: acceptedConversationId,
          created_at: accepted.created_at,
          images: accepted.images,
          client_message_id: optimisticUserMessageId,
        });
        notifyTaskAccepted({ session_id: acceptedSessionId, conversation_id: acceptedConversationId });
      }
      const acceptedSession = {
        id: acceptedSessionId,
        token: acceptedToken,
        control_ticket: acceptedTickets.read || input?.control_ticket || input?.controlTicket || null,
        control_tickets: acceptedTickets,
        protocol_version: accepted.protocol_version || 3,
        conversation_id: acceptedConversationId,
        status: accepted.status || 'queued',
        queue_position: accepted.queue_position || null,
        user_message_id: accepted.user_message_id || null,
        loop_count: 0,
        reason: '',
      };
      // 多个 session 并行订阅时，较晚返回的后台回执只能登记凭据和时间线，
      // 不能覆盖用户当前正在查看的 session。
      knownSessionsRef.current.set(String(acceptedSessionId), acceptedSession);
      if (isCurrentPresentation()) setActiveAgentSession(acceptedSession);
      publishTimeline(null, {
        sessionId: String(acceptedSessionId),
        userMessageId: Number(accepted.user_message_id || 0) || null,
        startedAt: accepted.created_at || timeline.startedAt,
        loading: true,
        sessionStatus: accepted.status || 'queued',
      });
      if (acceptedConversationId) onConversationId?.(acceptedConversationId);
      const eventCursor = isResume && resumeEventCursor > 0 ? resumeEventCursor : (accepted.event_cursor || 0);
      const eventsResponse = await fetch(`/api/agent/sessions/${acceptedSessionId}/events?after=${encodeURIComponent(String(eventCursor))}`, {
        headers: {
          ...(acceptedToken ? { 'x-agent-session-token': acceptedToken } : {}),
          ...(!acceptedToken && acceptedTickets.read ? { 'x-agent-control-ticket': acceptedTickets.read } : {}),
        },
        signal: controller.signal,
      });
      if (!eventsResponse.ok) throw new Error(await readErrorResponse(eventsResponse, '订阅 Agent 任务进度失败'));
      controller.eventsConnected = true;
      await readSse(eventsResponse, async (event) => {
        // 任务以会话为单位订阅。同一对话中后发任务入队时，早先任务仍须继续
        // 更新它自己的执行记录；只有切换对话、卸载或显式解绑才使订阅失效。
        if (!isSubscriptionActive()) return;
        const eventSessionId = String(event.session_id || acceptedSessionId || timeline.sessionId || '');
        const streamTextBeforeEvent = timeline.streamText;
        const eventTimeline = publishTimeline(event, {
          sessionId: eventSessionId,
          userMessageId: Number(event.user_message_id || timeline.userMessageId || accepted.user_message_id || 0) || null,
        });
        if (!isCurrentPresentation()) {
          if (event.type === 'tool_done' && !event.failed) dispatchAgentResourceChange(event.tool_name);
          if (
            FILE_MUTATION_TOOL_NAMES.has(event.tool_name)
            || (Array.isArray(event.changed_files) && event.changed_files.length > 0)
          ) {
            await onFilesMayHaveChanged?.({ reason: 'background_session_event', event });
          }
          if (event.type === 'artifact' && event.artifact_type === 'interaction' && event.interaction) {
            onInteractionRequest?.({ ...event.interaction, resume_ticket: event.resume_ticket });
          }
          if (event.type === 'waiting_preview_confirm') {
            let operationSet = null;
            try {
              const detail = await fetchSessionDetails(eventSessionId, sessionAccess, { activate: false });
              operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => (
                Number(item.id) === Number(event.operation_set_id)
              )) || normalizeOperationSets(detail?.operation_sets)[0] || null;
            } catch {}
            if (!isSubscriptionActive()) return;
            appendAssistant({
              content: '已生成批量修改预览，请确认后继续。',
              meta: {
                agent_loop: true,
                session_id: eventSessionId,
                operation_set_id: event.operation_set_id || operationSet?.id || null,
              },
              operationSet,
            });
          }
          if (event.type === 'final' || event.type === 'loop_done') {
            const waiting = event.type === 'loop_done' && ['hard_limit_reached', 'question_card_requested', 'resource_approval_requested', 'waiting_preview_confirm'].includes(event.reason);
            let operationSet = null;
            if (!waiting && event.operation_set_id) {
              try {
                const detail = await fetchSessionDetails(eventSessionId, sessionAccess, { activate: false });
                operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => (
                  Number(item.id) === Number(event.operation_set_id)
                )) || null;
              } catch {}
            }
            if (!isSubscriptionActive()) return;
            if (!waiting) appendAssistant({
              content: String(event.text || event.final_text || '').trim() || streamTextBeforeEvent || eventTimeline.streamText || reasonLabel(event.reason),
              meta: {
                agent_loop: true,
                session_id: eventSessionId,
                status: eventTimeline.sessionStatus || event.status || 'completed',
                reason: event.reason || '',
                interaction_id: event.interaction_id || null,
                operation_set_id: event.operation_set_id || operationSet?.id || null,
                research_summary: event.research_summary || null,
                write_summary: event.write_summary || null,
                usage: event.usage || null,
              },
              operationSet,
            });
            onConversationSettled?.(event.conversation_id || acceptedConversationId || null);
            if (!waiting) controller.abort();
          }
          if (event.type === 'cancelled') controller.abort();
          return;
        }
        const step = buildEventStep(event);
        if (step) appendStep(step);
        if (event.type === 'tool_done' && !event.failed) dispatchAgentResourceChange(event.tool_name);
        if (event.conversation_id) {
          onConversationId?.(Number(event.conversation_id));
        }
        if (
          FILE_MUTATION_TOOL_NAMES.has(event.tool_name)
          || (Array.isArray(event.changed_files) && event.changed_files.length > 0)
        ) {
          filesMayHaveChangedRef.current = true;
        }

        if (event.type === 'task_state') {
          setActiveAgentSession((prev) => ({ status: event.status || prev?.status || 'queued', queue_position: event.queue_position || null }));
          if (event.status === 'queued') setLoading(true);
        } else if (event.type === 'session_created') {
          appendUserMessage(event);
          notifyTaskAccepted(event);
          setActiveAgentSession({
            id: event.session_id,
            token: event.session_token,
            control_ticket: event.control_ticket || null,
            protocol_version: event.protocol_version || 1,
            conversation_id: event.conversation_id || null,
            status: 'running',
            loop_count: 0,
            reason: '',
            user_message_id: event.user_message_id || event.userMessageId || null,
          });
        } else if (event.type === 'session_resumed') {
          setActiveAgentSession((prev) => ({
            id: event.session_id || resumeSessionId,
            token: resumeToken || prev?.token,
            control_ticket: input?.control_ticket || input?.controlTicket || prev?.control_ticket || null,
            protocol_version: event.protocol_version || prev?.protocol_version || 1,
            conversation_id: event.conversation_id || prev?.conversation_id || null,
            status: 'running',
            reason: '',
          }));
        } else if (event.type === 'progress') {
          setActiveAgentSession((prev) => ({
            status: 'running',
            loop_count: Number(event.loop_index || prev?.loop_count || 0),
            reason: '',
          }));
          if (event.stage === 'thinking') {
            const text = String(event.text || '').trim();
            if (text && text !== assistantTextRef.current.split('\n\n').pop()) {
              assistantTextRef.current = assistantTextRef.current
                ? `${assistantTextRef.current}\n\n${text}`
                : text;
            }
            setStreamText(assistantTextRef.current);
          }
        } else if (event.type === 'artifact') {
          if (event.artifact_type === 'interaction') {
            const interaction = event.interaction ? { ...event.interaction, resume_ticket: event.resume_ticket } : null;
            setActiveAgentSession({
              status: 'waiting_interaction',
              reason: event.reason || 'question_card_requested',
              interaction_id: interaction?.id || null,
            });
            if (interaction) onInteractionRequest?.(interaction);
            window.notusDesktop?.notifyAgent?.({ title: 'Notus Agent 等待你的回答', body: '提问卡片已准备好，回答后任务会自动继续。' }).catch?.(() => {});
            setStreamText('');
            setLoading(false);
          } else if (event.artifact_type === 'operation_set' && event.operation_set_id) {
            filesMayHaveChangedRef.current = event.status === 'applied' || filesMayHaveChangedRef.current;
            try {
              await fetchSessionDetails(eventSessionId, sessionAccess, { activate: false });
            } catch {}
          } else if (event.artifact_type === 'operation_confirmation') {
            setActiveAgentSession({
              status: 'waiting_operation_confirmation',
              reason: event.reason || 'operation_confirmation_required',
              operation_set_id: event.operation_set_id || null,
            });
            let operationSet = null;
            try {
              const detail = await fetchSessionDetails(eventSessionId, sessionAccess, { activate: false });
              operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => (
                Number(item.id) === Number(event.operation_set_id)
              )) || null;
            } catch {}
            if (!isSubscriptionActive()) return;
            if (operationSet) {
              appendAssistant({
                content: event.text || '已生成文件修改预览，请检查后决定是否应用。',
                meta: {
                  agent_loop: true,
                  session_id: eventSessionId,
                  status: 'waiting_operation_confirmation',
                  reason: event.reason || 'operation_confirmation_required',
                  operation_set_id: operationSet.id,
                },
                operationSet,
              });
              onOperationConfirmation?.(operationSet);
            }
            setStreamText('');
            setLoading(false);
          } else if (event.artifact_type === 'limit_confirmation') {
            setActiveAgentSession({ status: 'waiting_limit_confirmation', reason: event.reason || 'hard_limit_reached' });
            setStreamText('');
            setLoading(false);
          } else if (event.artifact_type === 'run_error') {
            setActiveAgentSession({
              status: event.status || (event.resumable ? 'waiting_retry' : 'failed'),
              reason: 'llm_request_failed',
              error_category: event.error_category || '',
            });
            setStreamText(assistantTextRef.current);
            // SSE Route 会在等待态继续保持心跳，不会自然结束；服务端在发出
            // run_error 前已经释放 run lease，因此这里必须立即解除 loading。
            setLoading(false);
            window.notusDesktop?.notifyAgent?.({ title: 'Notus Agent 已暂停', body: event.message || '请检查模型配置后继续任务。' }).catch?.(() => {});
          } else if (event.artifact_type === 'resume_job' && event.resume_job?.status === 'completed') {
            setActiveAgentSession({ status: 'completed', reason: 'idempotent_replay' });
          }
        } else if (event.type === 'final') {
          const current = sessionRef.current || {};
          const finalText = String(event.text || event.final_text || '').trim() || reasonLabel(event.reason);
          assistantTextRef.current = finalText;
          let operationSet = null;
          if (event.operation_set_id) {
            try {
              const detail = await fetchSessionDetails(event.session_id || current.id, {
                token: current.token || resumeToken,
                controlTicket: current.control_tickets?.read || current.control_ticket,
              }, { activate: false });
              operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => Number(item.id) === Number(event.operation_set_id)) || null;
            } catch {}
          }
          if (!isSubscriptionActive()) return;
          if (!isCurrentPresentation()) {
            appendAssistant({
              content: finalText,
              meta: {
                agent_loop: true,
                session_id: event.session_id || current.id,
                status: event.status || 'completed',
                reason: event.reason || '',
                operation_set_id: event.operation_set_id || operationSet?.id || null,
                research_summary: event.research_summary || null,
                write_summary: event.write_summary || null,
                usage: event.usage || null,
              },
              operationSet,
            });
            onConversationSettled?.(event.conversation_id || current.conversation_id || null);
            controller.abort();
            return;
          }
          setActiveAgentSession({
            status: event.status || 'completed',
            loop_count: Number(event.loop_index || current.loop_count || 0),
            reason: event.reason || '',
          });
          setSteps((prev) => completeSteps(upsertStep(prev, buildEventStep(event)), { resolveOperationConfirmations: true }));
          appendAssistant({
            content: finalText,
            meta: {
              agent_loop: true,
              session_id: event.session_id || current.id,
              status: event.status || 'completed',
              reason: event.reason || '',
              operation_set_id: event.operation_set_id || operationSet?.id || null,
              research_summary: event.research_summary || null,
              write_summary: event.write_summary || null,
              usage: event.usage || null,
            },
            operationSet,
          });
          setStreamText('');
          setLoading(false);
          onConversationSettled?.(event.conversation_id || current.conversation_id || null);
          window.notusDesktop?.notifyAgent?.({ title: event.status === 'completed' ? 'Notus Agent 已完成' : 'Notus Agent 任务已结束', body: finalText.slice(0, 120) }).catch?.(() => {});
          await notifyFilesMayHaveChanged({ reason: event.reason || 'final', event });
          controller.abort();
        } else if (event.type === 'loop_start') {
          setActiveAgentSession((prev) => ({
            status: 'running',
            loop_count: Number(event.loop_index || prev?.loop_count || 0),
            reason: '',
          }));
        } else if (event.type === 'thinking') {
          const text = String(event.text || '').trim();
          if (text) {
            assistantTextRef.current = assistantTextRef.current
              ? `${assistantTextRef.current}\n${text}`
              : text;
            setStreamText(assistantTextRef.current);
          }
        } else if (event.type === 'assistant_text_replace') {
          assistantTextRef.current = String(event.text || '').trim();
          setStreamText(assistantTextRef.current);
        } else if (event.type === 'waiting_preview_confirm') {
          const current = sessionRef.current || {};
          const token = current.token || resumeToken;
          setActiveAgentSession({
            id: event.session_id || current.id,
            token,
            conversation_id: event.conversation_id || current.conversation_id || null,
            status: 'waiting_confirm',
            reason: 'waiting_preview_confirm',
            operation_set_id: event.operation_set_id || null,
          });
          let operationSet = null;
          try {
            const detail = await fetchSessionDetails(event.session_id || current.id, token, { activate: false });
            operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => (
              Number(item.id) === Number(event.operation_set_id)
            )) || normalizeOperationSets(detail?.operation_sets)[0] || null;
          } catch {}
          if (!isSubscriptionActive()) return;
          if (!isCurrentPresentation()) {
            appendAssistant({
              content: '已生成批量修改预览，请确认后继续。',
              meta: {
                agent_loop: true,
                session_id: event.session_id || current.id,
                operation_set_id: event.operation_set_id || operationSet?.id || null,
              },
              operationSet,
            });
            return;
          }
          appendAssistant({
            content: '已生成批量修改预览，请确认后继续。',
            meta: {
              agent_loop: true,
              session_id: event.session_id || current.id,
              operation_set_id: event.operation_set_id || operationSet?.id || null,
            },
            operationSet,
          });
          setStreamText('');
          setLoading(false);
        } else if (event.type === 'interaction_request') {
          const current = sessionRef.current || {};
          const token = current.token || resumeToken;
          setActiveAgentSession({
            id: event.session_id || current.id,
            token,
            conversation_id: event.conversation_id || current.conversation_id || null,
            status: 'waiting_confirm',
            reason: event.reason || 'question_card_requested',
            interaction_id: event.interaction?.id || event.interaction_id || null,
          });
          if (event.interaction) onInteractionRequest?.(event.interaction);
          setStreamText('');
          setLoading(false);
        } else if (event.type === 'loop_done') {
          const current = sessionRef.current || {};
          const hardLimit = event.reason === 'hard_limit_reached';
          const waitingQuestionCard = event.reason === 'question_card_requested';
          const waitingResourceApproval = event.reason === 'resource_approval_requested';
          const waitingPreview = event.reason === 'waiting_preview_confirm';
          const failed = ['consecutive_tool_failure', 'deadloop_detected', 'no_progress', 'preview_auto_apply_failed'].includes(event.reason);
          let operationSet = null;
          if (event.operation_set_id) {
            try {
              const detail = await fetchSessionDetails(event.session_id || current.id, current.token || resumeToken, { activate: false });
              operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => (
                Number(item.id) === Number(event.operation_set_id)
              )) || null;
            } catch {}
          }
          if (!isSubscriptionActive()) return;
          if (!isCurrentPresentation()) {
            if (!waitingResourceApproval) appendAssistant({
              content: streamTextBeforeEvent || reasonLabel(event.reason),
              meta: {
                agent_loop: true,
                session_id: event.session_id || current.id,
                status: hardLimit || waitingQuestionCard || waitingPreview ? 'waiting_confirm' : failed ? 'failed' : 'completed',
                reason: event.reason || '',
                interaction_id: event.interaction_id || current.interaction_id || null,
                operation_set_id: event.operation_set_id || operationSet?.id || null,
                research_summary: event.research_summary || null,
                write_summary: event.write_summary || null,
              },
              operationSet,
            });
            onConversationSettled?.(event.conversation_id || current.conversation_id || null);
            if (!hardLimit && !waitingQuestionCard && !waitingResourceApproval && !waitingPreview) controller.abort();
            return;
          }
          setActiveAgentSession({
            id: event.session_id || current.id,
            token: current.token || resumeToken,
            conversation_id: event.conversation_id || current.conversation_id || null,
            status: hardLimit || waitingQuestionCard || waitingResourceApproval || waitingPreview ? 'waiting_confirm' : failed ? 'failed' : 'completed',
            loop_count: Number(event.loop_index || current.loop_count || 0),
            reason: event.reason || '',
            interaction_id: event.interaction_id || current.interaction_id || null,
          });
          setSteps((prev) => completeSteps(upsertStep(prev, buildEventStep(event))));
          if (!waitingResourceApproval) appendAssistant({
            content: assistantTextRef.current || reasonLabel(event.reason),
            meta: {
              agent_loop: true,
              session_id: event.session_id || current.id,
              status: hardLimit || waitingQuestionCard || waitingPreview ? 'waiting_confirm' : failed ? 'failed' : 'completed',
              reason: event.reason || '',
              interaction_id: event.interaction_id || current.interaction_id || null,
              operation_set_id: event.operation_set_id || operationSet?.id || null,
              research_summary: event.research_summary || null,
              write_summary: event.write_summary || null,
            },
            operationSet,
          });
          setStreamText('');
          setLoading(false);
          onConversationSettled?.(event.conversation_id || current.conversation_id || null);
          await notifyFilesMayHaveChanged({ reason: event.reason || 'loop_done', event });
          if (!hardLimit && !waitingQuestionCard && !waitingResourceApproval && !waitingPreview) controller.abort();
        } else if (event.type === 'cancelled') {
          setActiveAgentSession((prev) => ({ status: 'cancelled', reason: 'cancelled' }));
          setSteps((prev) => completeSteps(upsertStep(prev, buildEventStep(event))));
          setStreamText('');
          setLoading(false);
          await notifyFilesMayHaveChanged({ reason: 'cancelled', event });
          controller.abort();
        } else if (event.type === 'error') {
          const message = event.code === 'SESSION_RUN_CONFLICT'
            ? '当前任务正在另一条连接中执行，请稍候查看进度。'
            : (event.error || 'Agent Loop 请求失败');
          const nextError = new Error(message);
          nextError.code = event.code;
          throw nextError;
        }
      });
      if (isCurrentPresentation()) setLoading(false);
    } catch (nextError) {
      if (!isSubscriptionActive()) return;
      if (nextError.name !== 'AbortError' && await recoverPersistedSession()) return;
      const failureEvent = nextError.name === 'AbortError'
        ? { type: 'cancelled' }
        : { type: 'error', error: nextError.message || 'Agent Loop 请求失败' };
      publishTimeline(failureEvent);
      if (!isCurrentPresentation()) return;
      if (nextError.name === 'AbortError') {
        appendStep(buildEventStep({ type: 'cancelled' }));
      } else {
        const message = nextError.message || 'Agent Loop 请求失败';
        setError(message);
        setActiveAgentSession({ status: 'failed', reason: 'error' });
        appendStep(buildEventStep({ type: 'error', error: message }));
        onError?.(nextError);
      }
      setStreamText(assistantTextRef.current);
      setLoading(false);
      await notifyFilesMayHaveChanged({
        reason: nextError.name === 'AbortError' ? 'cancelled' : 'error',
        error: nextError,
      });
      if (nextError.name === 'AbortError') return;
      throw nextError;
    } finally {
      if (!isResume) newTaskSubmitInFlightRef.current = false;
      controller.eventsConnected = false;
      controllersRef.current.delete(controller);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [
    appendAssistant,
    appendStep,
    fetchSessionDetails,
    notifyFilesMayHaveChanged,
    onAppendUserMessage,
    onConversationId,
    onConversationSettled,
    onError,
    onInteractionRequest,
    onOperationConfirmation,
    onSessionTimeline,
    setActiveAgentSession,
    setSteps,
  ]);

  const confirmAgentTask = useCallback(async (task) => {
    const target = task || pendingAgentTask;
    if (!target?.goal) return;
    await startAgentLoop(target, { appendUserMessage: !Boolean(target.skip_user_message_append || target.skipUserMessageAppend) });
  }, [pendingAgentTask, startAgentLoop]);

  const runOperationSetAction = useCallback(async (operationSet, action, options = {}) => {
    const session = sessionRef.current;
    const operateTicket = session?.control_tickets?.operate;
    if (!session?.id || (!session?.token && !operateTicket)) throw new Error('缺少 Agent 任务状态，无法处理预览');
    const operationSetId = operationSet?.id || session.operation_set_id;
    if (!operationSetId) throw new Error('缺少修改预览 ID');
    const response = await fetch('/api/agent/loop/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        session_id: session.id,
        session_token: session.token,
        control_ticket: operateTicket || undefined,
        operation_set_id: operationSetId,
        current_conversation_id: options.currentConversationId || session.conversation_id || undefined,
        action,
        patch_index: options.patchIndex === undefined ? undefined : options.patchIndex,
        file_path: options.filePath || undefined,
        force: Boolean(options.force),
        approval_mode: options.approvalMode || undefined,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      if (payload.operation_set) {
        onOperationSetHandled?.(operationSetId, action, payload.operation_set);
      }
      if (payload.conflict) {
        throw new Error('文件已经变化，请检查冲突后重新确认');
      }
      throw new Error(payload.error || payload.code || '处理修改失败');
    }
    onOperationSetHandled?.(operationSetId, action, payload.operation_set || null);
    if (payload.task_change_set) onTaskChangeSet?.(payload.task_change_set);
    if (['apply', 'apply_all', 'apply_file'].includes(action)) {
      await onApplySuccess?.(payload, operationSet);
    } else if (action === 'rollback_file') {
      await onRollbackSuccess?.(payload, operationSet);
    }
    if (payload.session) setActiveAgentSession({ ...payload.session, token: session.token, control_tickets: session.control_tickets });
    // 仅自动确认模式下的高风险批次会返回 task_resumed；手动 Diff 始终为 false，
    // 因此不会在应用后重新订阅或请求无意义的模型收尾。
    if (payload.task_resumed && !controllerRef.current) {
      startAgentLoop({
        session_id: session.id,
        session_token: session.token,
        subscribe_only: true,
        read_ticket: session.control_tickets?.read || '',
        control_tickets: session.control_tickets || {},
      }, { resume: true }).catch((resumeError) => {
        setError(resumeError.message || '继续任务订阅失败');
        onError?.(resumeError);
      });
    }
    return payload;
  }, [onApplySuccess, onError, onOperationSetHandled, onRollbackSuccess, onTaskChangeSet, setActiveAgentSession, startAgentLoop]);

  const applyOperationSet = useCallback((operationSet, options = {}) => (
    runOperationSetAction(operationSet, options.action || 'apply_all', options)
  ), [runOperationSetAction]);

  const applyOperationFile = useCallback((operationSet, patchIndex, options = {}) => (
    runOperationSetAction(operationSet, 'apply_file', { ...options, patchIndex })
  ), [runOperationSetAction]);

  const rollbackOperationFile = useCallback((operationSet, patchIndex, options = {}) => (
    runOperationSetAction(operationSet, 'rollback_file', { ...options, patchIndex })
  ), [runOperationSetAction]);

  const discardPendingOperationSet = useCallback((operationSet, options = {}) => (
    runOperationSetAction(operationSet, 'discard_pending', options)
  ), [runOperationSetAction]);

  const rejectOperationSet = useCallback(async (operationSet) => {
    const session = sessionRef.current;
    if (!session?.id || !session?.token) return;
    const operationSetId = operationSet?.id || session.operation_set_id;
    const response = await fetch('/api/agent/loop/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: session.id,
        session_token: session.token,
        control_ticket: session.control_tickets?.operate || undefined,
        operation_set_id: operationSetId || undefined,
        action: 'reject',
      }),
    });
    if (!response.ok) {
      throw new Error(await readErrorResponse(response, '撤销预览失败'));
    }
    if (operationSetId) onOperationSetHandled?.(operationSetId, 'cancelled');
    setActiveAgentSession({ status: 'cancelled', reason: 'cancelled' });
  }, [onOperationSetHandled, setActiveAgentSession]);

  const extendAgentSession = useCallback(async (sessionInput = null) => {
    try {
      const session = sessionInput || sessionRef.current;
      const token = session?.token || sessionRef.current?.token;
      const extendTicket = session?.control_tickets?.extend;
      if (!session?.id || (!token && !extendTicket)) return;
      const response = await fetch('/api/agent/loop/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          session_token: token,
          control_ticket: extendTicket || undefined,
          action: 'extend',
          extra_loops: 10,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || payload.code || '继续执行失败');
      }
      await startAgentLoop({
        session_id: session.id,
        session_token: token,
        control_ticket: session.control_tickets?.resume,
      }, { resume: true });
    } catch (extendError) {
      const message = extendError.message || '继续执行失败';
      setError(message);
      onError?.(extendError);
    }
  }, [onError, startAgentLoop]);

  const rollbackAgentSession = useCallback(async (sessionInput = null) => {
    try {
      const session = sessionInput || sessionRef.current;
      const token = session?.token || sessionRef.current?.token;
      const rollbackTicket = session?.control_tickets?.rollback;
      if (!session?.id || (!token && !rollbackTicket)) return;
      const response = await fetch('/api/agent/sessions/' + session.id + '/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: token, control_ticket: rollbackTicket || undefined }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || payload.code || '回滚任务失败');
      }
      setActiveAgentSession({ status: 'rolled_back', reason: 'rolled_back' });
      await onRollbackSuccess?.(payload, session);
    } catch (rollbackError) {
      const message = rollbackError.message || '回滚任务失败';
      setError(message);
      onError?.(rollbackError);
    }
  }, [onError, onRollbackSuccess, setActiveAgentSession]);

  const markAgentSessionStatus = useCallback((sessionId, status, reason = status) => {
    const id = String(sessionId || '');
    if (!id) return;
    const known = knownSessionsRef.current.get(id)
      || (String(sessionRef.current?.id || '') === id ? sessionRef.current : null);
    const nextSession = { ...(known || { id: Number(id) || id }), status, reason };
    knownSessionsRef.current.set(id, nextSession);
    onSessionTimeline?.({ sessionId: id, sessionStatus: status, loading: false });
    if (String(sessionRef.current?.id || '') !== id) return;
    setActiveAgentSession(nextSession);
    setSteps((prev) => upsertStep(completeSteps(prev), buildEventStep({
      type: status === 'cancelled' ? 'cancelled' : 'loop_done',
      reason,
    })));
    setStreamText('');
    setLoading(false);
  }, [onSessionTimeline, setActiveAgentSession, setSteps]);

  const stopAgentLoop = useCallback(async (targetSessionId = null) => {
    const sessionId = String(targetSessionId || '');
    const session = sessionId ? knownSessionsRef.current.get(sessionId) : sessionRef.current;
    const cancelConversationSessionIds = [...knownSessionsRef.current.values()]
      .filter((item) => session?.conversation_id && String(item?.conversation_id || '') === String(session.conversation_id))
      .filter((item) => ['created', 'queued', 'running'].includes(item.status))
      .map((item) => String(item.id || ''))
      .filter(Boolean);
    const affectedSessionIds = [...new Set(cancelConversationSessionIds.length ? cancelConversationSessionIds : [String(session?.id || '')])];
    const updateAffectedSessions = (status) => {
      affectedSessionIds.forEach((affectedSessionId) => {
        const affectedSession = knownSessionsRef.current.get(affectedSessionId);
        if (!affectedSession) return;
        const nextSession = { ...affectedSession, status, reason: status };
        knownSessionsRef.current.set(affectedSessionId, nextSession);
        onSessionTimeline?.({ sessionId: affectedSessionId, sessionStatus: status, loading: false });
        if (String(sessionRef.current?.id || '') === affectedSessionId) setActiveAgentSession(nextSession);
      });
    };
    if (!session?.id) return;
    setLoading(false);
    setStreamText('');
    setSteps((prev) => upsertStep(completeSteps(prev), buildEventStep({ type: 'cancelled' })));
    updateAffectedSessions('cancelling');
    const cancelTicket = session?.control_tickets?.cancel;
    if (!session?.token && !cancelTicket) {
      updateAffectedSessions('running');
      const accessError = new Error('缺少任务取消凭据，请刷新当前对话后重试');
      setError(accessError.message);
      onError?.(accessError);
      return;
    }
    try {
      const response = await fetch('/api/agent/loop/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          session_token: session.token,
          control_ticket: cancelTicket || undefined,
          sessions: affectedSessionIds.map((affectedSessionId) => {
            const affectedSession = knownSessionsRef.current.get(affectedSessionId) || {};
            return {
              session_id: affectedSession.id || affectedSessionId,
              session_token: affectedSession.token || undefined,
              control_ticket: affectedSession.control_tickets?.cancel || undefined,
            };
          }),
        }),
      });
      if (!response.ok) throw new Error(await readErrorResponse(response, '中断 Agent 任务失败'));
      const payload = await response.json().catch(() => ({}));
      const cancelledSessionIds = Array.isArray(payload?.cancelled_session_ids) && payload.cancelled_session_ids.length
        ? payload.cancelled_session_ids.map((id) => String(id || '')).filter(Boolean)
        : affectedSessionIds;
      cancelledSessionIds.forEach((cancelledSessionId) => {
        const cancelledSession = knownSessionsRef.current.get(cancelledSessionId) || session;
        knownSessionsRef.current.set(cancelledSessionId, { ...cancelledSession, status: 'cancelled', reason: 'cancelled' });
        onSessionTimeline?.({ sessionId: cancelledSessionId, sessionStatus: 'cancelled', loading: false });
        if (String(sessionRef.current?.id || '') === cancelledSessionId) {
          setActiveAgentSession({ ...cancelledSession, status: 'cancelled', reason: 'cancelled' });
        }
      });
    } catch (error) {
      affectedSessionIds.forEach((affectedSessionId) => {
        const affectedSession = knownSessionsRef.current.get(affectedSessionId);
        if (!affectedSession) return;
        const restoredSession = { ...affectedSession, status: 'running', reason: '' };
        knownSessionsRef.current.set(affectedSessionId, restoredSession);
        onSessionTimeline?.({ sessionId: affectedSessionId, sessionStatus: 'running', loading: false });
        if (String(sessionRef.current?.id || '') === affectedSessionId) setActiveAgentSession(restoredSession);
      });
      setError(error.message || '中断 Agent 任务失败');
      onError?.(error);
    }
  }, [onError, onSessionTimeline, setActiveAgentSession, setSteps]);

  const getAgentSession = useCallback((sessionId) => (
    knownSessionsRef.current.get(String(sessionId || '')) || null
  ), []);

  const discardAgentSessions = useCallback((sessionIds = []) => {
    const targets = new Set((Array.isArray(sessionIds) ? sessionIds : [])
      .map((sessionId) => String(sessionId || ''))
      .filter(Boolean));
    if (targets.size === 0) return;
    controllersRef.current.forEach((controller) => {
      if (targets.has(String(controller.agentSessionId || ''))) controller.abort('discarded');
    });
    targets.forEach((sessionId) => knownSessionsRef.current.delete(sessionId));
    if (targets.has(String(sessionRef.current?.id || ''))) {
      setActiveAgentSession(null);
      setSteps((steps) => (Array.isArray(steps) && steps.length === 0 ? steps : []));
      setStreamText('');
      setLoading(false);
      setError('');
    }
  }, [setActiveAgentSession, setSteps]);

  const restoreAgentSession = useCallback((session) => {
    if (!session?.id) {
      clearActiveAgentSession();
      return;
    }
    setActiveAgentSession({ ...session });
    const restored = buildRestoredAgentTimeline(session);
    let restoredSteps = restored.steps;
    if (['waiting_retry', 'waiting_model_recovery'].includes(session.status)) {
      restoredSteps = upsertStep(restoredSteps, buildEventStep({
        type: 'artifact',
        artifact_type: 'run_error',
        status: session.status,
        error_category: session.status === 'waiting_model_recovery' ? 'action_required' : 'retryable',
        message: session.status === 'waiting_model_recovery'
          ? '模型服务需要处理，请检查额度、API Key、权限或模型配置后继续任务。'
          : '模型服务暂时不可用，已保留当前任务进度。',
        resumable: true,
        loop_index: session.loop_count,
      }));
    }
    setSteps(restoredSteps);
    // 已完成会话的最终回复已作为正式助手消息持久化；不能把过程草稿再次标成“中断前”。
    setStreamText(session.status === 'completed' ? '' : restored.draft);
    setLoading(false);
  }, [clearActiveAgentSession, setActiveAgentSession, setSteps]);

  const hasActiveSessionSubscription = useCallback((sessionId) => {
    const id = String(sessionId || '');
    if (!id) return false;
    return [...controllersRef.current].some((controller) => (
      String(controller?.agentSessionId || '') === id
        && controller.eventsConnected === true
        && !controller.signal.aborted
    ));
  }, []);

  return {
    pendingAgentTask,
    activeAgentSession,
    activeSteps,
    streamText,
    loading,
    error,
    createAgentTask,
    cancelAgentTask,
    clearActiveAgentSession,
    registerAgentSessions,
    confirmAgentTask,
    startAgentLoop,
    stopAgentLoop,
    getAgentSession,
    discardAgentSessions,
    applyOperationSet,
    applyOperationFile,
    rollbackOperationFile,
    discardPendingOperationSet,
    rejectOperationSet,
    extendAgentSession,
    rollbackAgentSession,
    markAgentSessionStatus,
    fetchSessionDetails,
    restoreAgentSession,
    hasActiveSessionSubscription,
  };
}
