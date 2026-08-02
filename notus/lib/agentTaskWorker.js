const { createLogger } = require('./logger');
const { resolveLlmRuntimeConfig } = require('./llmConfigs');
const { runAgentLoop } = require('./agentLoop');
const { getSession, updateSessionStatus } = require('./agentSession');
const { appendConversationMessage, touchConversation } = require('./conversations');
const { parseAgentInputSources } = require('./agentInputSources');
const { loadAttachments } = require('./parsedAttachmentStore');
const { recognizeConversationImages } = require('./imageRecognition');
const { buildResearchSummary, buildWriteSummary, correctConflictingSourceClaims, registerParsedInputSources } = require('./agentResearch');
const { updateInteraction } = require('./conversationInteractions');
const { acquireRunLease, registerActiveRun, releaseRunLease, renewRunLease, recordRunUsage, recoverStaleRunLeases } = require('./agentControlPlane');
const { assertAttachmentLimits, assertImageContextSize, assertImageLimits, getImageInputBlocks, MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES } = require('./conversationImages');
const { claimRunnableTasks, updateTask, recoverOrphanedTasks, getTaskBySession } = require('./agentTaskQueue');
const { publish } = require('./agentRunEventBus');
const { getDb } = require('./db');
const { updateResumeJob } = require('./agentControlPlane');

const logger = createLogger({ subsystem: 'agent-task-worker' });
const WORKER_STATE_KEY = '__notus_agent_task_worker_state__';
const workerState = globalThis[WORKER_STATE_KEY] || (globalThis[WORKER_STATE_KEY] = {
  timer: null,
  running: false,
});

function isImage(item = {}) {
  const name = String(item?.name || item?.file_name || '').toLowerCase();
  const type = String(item?.type || item?.contentType || '').toLowerCase();
  return item?.media_kind === 'image' || type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/.test(name);
}

function splitMedia(input = {}) {
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const media = Array.isArray(input.media_items) ? input.media_items : [];
  const images = Array.isArray(input.images) ? input.images : [];
  const all = [...attachments, ...media];
  return { attachments: all.filter((item) => !isImage(item)), images: [...images, ...all.filter(isImage)] };
}

function emit(sessionId, runId, event) {
  return publish({ sessionId, runId, event });
}

async function execute(task) {
  const input = task.input || {};
  const sessionId = task.session_id;
  const session = getSession(sessionId);
  const conversationId = task.conversation_id || session.conversation_id;
  const controller = new AbortController();
  const lease = acquireRunLease(sessionId, { allowedStatuses: ['created', 'queued_resume', 'running', 'waiting_retry', 'waiting_model_recovery'] });
  if (!lease.acquired) {
    updateTask(sessionId, { status: ['waiting_interaction', 'waiting_limit_confirmation'].includes(session.status) ? session.status : 'queued' });
    return;
  }
  const runId = lease.runId;
  registerActiveRun(runId, controller);
  updateTask(sessionId, { status: 'running', runId });
  const leaseTimer = setInterval(() => {
    const renewed = renewRunLease(sessionId, runId);
    if (!renewed.renewed && !controller.signal.aborted) controller.abort('lease_lost');
  }, 20_000);
  let assistantText = '';
  let finalEvent = null;
  const resumeJob = getDb().prepare("SELECT * FROM agent_resume_jobs WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1").get(sessionId);
  if (resumeJob) updateResumeJob(resumeJob.id, { status: 'running', runId, incrementAttempt: true, started: true });
  try {
    const media = splitMedia(input);
    const attachments = assertAttachmentLimits(conversationId, media.attachments);
    const images = assertImageLimits(conversationId, media.images);
    const llmConfig = resolveLlmRuntimeConfig({ llmConfigId: task.llm_config_id || input.llm_config_id || undefined });
    if (String(llmConfig.llmApiProtocol || '').toLowerCase() === 'anthropic') assertImageContextSize(images, MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES);
    const userQuery = String(input.user_query || input.input_text || input.display_query || '').trim();
    const parsedAttachments = await parseAgentInputSources({
      conversationId, attachments, userInputText: userQuery,
      onEvent: (event) => emit(sessionId, runId, {
        ...event, type: 'progress', stage: event.type || 'attachment_progress', legacy_type: event.type,
        text: event.type === 'attachment_parse_start' ? `正在解析 ${event.source || '附件'}。` : event.status === 'error' ? `${event.source || '附件'}解析失败。` : `${event.source || '附件'}解析完成。`,
        conversation_id: conversationId,
      }),
    });
    registerParsedInputSources({ sessionId, conversationId, parsedAttachments, attachments: loadAttachments(conversationId) });
    let initialImages = getImageInputBlocks(images, { messageId: task.user_message_id });
    let currentImageRecognition = null;
    if (images.length && task.user_message_id) {
      try {
        currentImageRecognition = await recognizeConversationImages({ conversationId, messageId: task.user_message_id, images, llmConfig, signal: controller.signal });
        if (currentImageRecognition?.usage) recordRunUsage({ sessionId, sourceType: 'image_recognition', provider: llmConfig.llmProvider, model: llmConfig.llmModel, usage: currentImageRecognition.usage });
        emit(sessionId, runId, { type: 'progress', stage: 'image_recognition_done', text: '图片识别完成。', conversation_id: conversationId, message_id: task.user_message_id, image_count: images.length });
        initialImages = [];
      } catch (error) {
        emit(sessionId, runId, { type: 'progress', stage: 'image_recognition_done', text: '图片识别未完成，任务将继续使用其他材料。', status: 'error', error: error.code || 'IMAGE_RECOGNITION_FAILED', conversation_id: conversationId });
      }
    }
    const loopResult = await runAgentLoop({
      sessionId, runId, llmConfig, signal: controller.signal, approvalMode: task.approval_mode,
      resumeInteractionId: Number(resumeJob?.interaction_id || input.resume_interaction_id || 0) || null, initialImages, currentImageRecognition,
      onStream: (event) => {
        if (event.type === 'final') {
          assistantText = String(event.text || '');
          const corrected = correctConflictingSourceClaims(assistantText, sessionId);
          if (corrected.corrected) { assistantText = corrected.text; event = { ...event, text: assistantText }; }
          finalEvent = event;
        }
      },
    });
    const finalSession = getSession(sessionId);
    const status = finalSession.status || loopResult?.status || 'failed';
    if (status === 'waiting_interaction' && loopResult?.interaction?.id) {
      const intro = String(loopResult.interaction?.payload?.clarify_intro || '').trim() || '请回答这张提问卡片后继续执行。';
      const messageId = appendConversationMessage({ conversationId, role: 'assistant', content: intro, meta: { agent_loop: true, session_id: sessionId, status, answer_mode: 'clarify_needed', interaction_id: loopResult.interaction.id, interaction_kind: loopResult.interaction.kind || 'clarify_card', reason: loopResult.reason } });
      updateInteraction(loopResult.interaction.id, { messageId });
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      const existing = getTaskBySession(sessionId);
      if (!existing?.final_message_id) {
        const messageId = appendConversationMessage({ conversationId, role: 'assistant', content: assistantText.trim() || loopResult?.final_text || `Agent 任务已${status === 'completed' ? '完成' : status === 'cancelled' ? '取消' : '结束'}。`, meta: { agent_loop: true, session_id: sessionId, status, operation_set_id: loopResult?.operation_set_id || null, research_summary: buildResearchSummary(sessionId), write_summary: buildWriteSummary(sessionId), usage: finalEvent?.usage || loopResult?.usage || null } });
        updateTask(sessionId, { finalMessageId: messageId });
      }
    }
    touchConversation(conversationId);
    const queueStatus = ['waiting_interaction', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'].includes(status) ? status : status;
    updateTask(sessionId, { status: queueStatus, finished: ['completed', 'failed', 'cancelled'].includes(status) });
    if (resumeJob) updateResumeJob(resumeJob.id, { status: ['waiting_interaction', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'].includes(status) ? 'queued' : status === 'completed' ? 'completed' : 'failed', result: { status }, finished: ['completed', 'failed', 'cancelled'].includes(status) });
  } catch (error) {
    const cancelled = controller.signal.aborted && controller.signal.reason === 'cancel';
    const interrupted = controller.signal.aborted && !cancelled;
    const status = cancelled ? 'cancelled' : interrupted ? 'queued' : 'failed';
    try { updateSessionStatus(sessionId, cancelled ? 'cancelled' : interrupted ? 'queued_resume' : 'failed'); } catch {}
    updateTask(sessionId, { status, lastError: { code: error.code || 'AGENT_TASK_FAILED', message: error.message || '任务执行失败' }, finished: !interrupted });
    emit(sessionId, runId, { type: 'artifact', artifact_type: 'run_error', status: interrupted ? 'queued_resume' : 'failed', error_category: interrupted ? 'interrupted' : 'fatal', error_code: interrupted ? 'WORKER_INTERRUPTED' : (error.code || 'AGENT_TASK_FAILED'), message: interrupted ? '任务已保存，将在服务恢复后继续执行。' : 'Agent 执行异常，执行记录已保留。', resumable: interrupted });
    logger.error('agent.task.failed', { session_id: sessionId, error });
    if (resumeJob) updateResumeJob(resumeJob.id, { status: interrupted ? 'queued' : 'failed', errorCode: error.code || 'AGENT_TASK_FAILED', finished: !interrupted });
  } finally {
    clearInterval(leaseTimer);
    try { releaseRunLease(sessionId, runId); } catch {}
    schedule();
  }
}

function schedule() {
  if (workerState.running) return;
  workerState.running = true;
  Promise.resolve().then(() => {
    const tasks = claimRunnableTasks();
    tasks.forEach((task) => { execute(task).catch((error) => logger.error('agent.task.unhandled', { error })); });
  }).finally(() => { workerState.running = false; });
}

function startAgentTaskWorker() {
  if (workerState.timer) return;
  recoverOrphanedTasks();
  recoverStaleRunLeases();
  schedule();
  workerState.timer = setInterval(schedule, 1_000);
  if (workerState.timer.unref) workerState.timer.unref();
}

function wakeAgentTaskWorker() { schedule(); }
module.exports = { startAgentTaskWorker, wakeAgentTaskWorker };
