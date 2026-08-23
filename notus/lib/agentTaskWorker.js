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
const { acquireRunLease, registerActiveRun, releaseRunLease, renewRunLease, recordRunUsage, recoverStaleRunLeases, settleResumeJob } = require('./agentControlPlane');
const { assertAttachmentLimits, assertImageContextSize, assertImageLimits, getImageInputBlocks, MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES } = require('./conversationImages');
const { claimRunnableTasks, updateTask, settleTaskRun, recoverOrphanedTasks, getTaskBySession } = require('./agentTaskQueue');
const { publish } = require('./agentRunEventBus');
const { getDb } = require('./db');
const { updateResumeJob } = require('./agentControlPlane');
const { mergeAgentMedia } = require('./agentMedia');
const { markTaskChangeSetFinished } = require('./agentTaskChangeSets');
const { ensureError } = require('./errors');

const logger = createLogger({ subsystem: 'agent-task-worker' });
const WORKER_STATE_KEY = '__notus_agent_task_worker_state__';
const workerState = globalThis[WORKER_STATE_KEY] || (globalThis[WORKER_STATE_KEY] = {
  timer: null,
  running: false,
});

function splitMedia(input = {}) {
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  const media = Array.isArray(input.media_items) ? input.media_items : [];
  const images = Array.isArray(input.images) ? input.images : [];
  return mergeAgentMedia({ attachments, mediaItems: media, images });
}

function buildViewedImagePreviews(images = [], conversationId = null) {
  return (Array.isArray(images) ? images : []).map((image, index) => {
    const storedName = String(image?.stored_name || image?.storedName || '').trim();
    return {
      id: String(image?.id || storedName || index),
      name: String(image?.name || `图片 ${index + 1}`),
      alt: `已查看图片 ${index + 1}`,
      preview_url: storedName && conversationId
        ? `/api/agent/images/${encodeURIComponent(storedName)}?conversation_id=${encodeURIComponent(conversationId)}`
        : '',
    };
  });
}

function emit(sessionId, runId, event) {
  return publish({ sessionId, runId, event });
}

async function execute(task) {
  const input = task.input || {};
  const sessionId = task.session_id;
  const session = getSession(sessionId);
  const conversationId = task.conversation_id || session.conversation_id;
  const requestedResumeJobId = String(task.resume_job_id || '').trim();
  let resumeJob = null;
  if (requestedResumeJobId) {
    resumeJob = getDb().prepare(`
      SELECT * FROM agent_resume_jobs
      WHERE id = ? AND session_id = ? AND status = 'queued'
    `).get(requestedResumeJobId, sessionId);
    if (!resumeJob) {
      updateSessionStatus(sessionId, 'failed');
      updateTask(sessionId, {
        status: 'failed',
        resumeJobId: null,
        lastError: {
          code: 'RESUME_JOB_NOT_QUEUED',
          message: 'Agent 恢复任务状态已失效，请刷新后重新确认。',
        },
        finished: true,
      });
      return;
    }
  }
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
  if (resumeJob) {
    const claimedResumeJob = getDb().prepare(`
      UPDATE agent_resume_jobs
      SET status = 'running', run_id = ?, attempt_count = attempt_count + 1,
          started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
      WHERE id = ? AND status = 'queued'
    `).run(runId, resumeJob.id);
    if (!claimedResumeJob.changes) {
      clearInterval(leaseTimer);
      releaseRunLease(sessionId, runId);
      updateTask(sessionId, {
        status: 'failed',
        resumeJobId: null,
        lastError: {
          code: 'RESUME_JOB_STATE_CONFLICT',
          message: 'Agent 恢复任务状态发生冲突，请刷新后重新确认。',
        },
        finished: true,
      });
      return;
    }
    resumeJob = getDb().prepare('SELECT * FROM agent_resume_jobs WHERE id = ?').get(resumeJob.id);
  }
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
      const viewedImages = buildViewedImagePreviews(images, conversationId);
      emit(sessionId, runId, {
        type: 'progress',
        stage: 'image_view_start',
        text: `正在查看 ${images.length} 张图片。`,
        conversation_id: conversationId,
        message_id: task.user_message_id,
        image_count: images.length,
        images: viewedImages,
      });
      try {
        currentImageRecognition = await recognizeConversationImages({ conversationId, messageId: task.user_message_id, images, llmConfig, signal: controller.signal });
        if (currentImageRecognition?.usage) recordRunUsage({ sessionId, sourceType: 'image_recognition', provider: llmConfig.llmProvider, model: llmConfig.llmModel, usage: currentImageRecognition.usage });
        emit(sessionId, runId, { type: 'progress', stage: 'image_recognition_done', text: `已查看 ${images.length} 张图片。`, conversation_id: conversationId, message_id: task.user_message_id, image_count: images.length, images: viewedImages });
        initialImages = [];
      } catch (error) {
        emit(sessionId, runId, { type: 'progress', stage: 'image_recognition_done', text: '图片查看未完成，任务将继续使用其他材料。', status: 'error', error: error.code || 'IMAGE_RECOGNITION_FAILED', conversation_id: conversationId, message_id: task.user_message_id, image_count: images.length, images: viewedImages });
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
    if (['completed', 'failed', 'cancelled'].includes(status)) markTaskChangeSetFinished(sessionId, status);
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
    settleTaskRun(sessionId, status, { finished: ['completed', 'failed', 'cancelled'].includes(status) });
    if (resumeJob) {
      // 一张卡片的 resume job 在实际进入 Loop 后已经被消费。即使续跑过程中
      // 又生成了下一张卡片，也不能把旧 job 重新排队，否则刷新会跳过新卡片。
      const settledResumeJob = settleResumeJob(resumeJob.id, status);
      if (settledResumeJob?.status !== 'queued') updateTask(sessionId, { resumeJobId: null });
    }
  } catch (error) {
    const normalizedError = ensureError(error, 'AGENT_TASK_FAILED', 'Agent 任务执行失败');
    const cancelled = controller.signal.aborted && controller.signal.reason === 'cancel';
    const interrupted = controller.signal.aborted && !cancelled;
    const status = cancelled ? 'cancelled' : interrupted ? 'queued' : 'failed';
    try { updateSessionStatus(sessionId, cancelled ? 'cancelled' : interrupted ? 'queued_resume' : 'failed'); } catch {}
    if (!interrupted) {
      try { markTaskChangeSetFinished(sessionId, cancelled ? 'cancelled' : 'failed'); } catch {}
    }
    const diagnostics = {
      module_id: normalizedError.module_id || null,
      tokens: Number(normalizedError.tokens || 0) || null,
      module_budget: Number(normalizedError.module_budget || 0) || null,
      dynamic_tokens: Number(normalizedError.dynamic_tokens || 0) || null,
      dynamic_budget: Number(normalizedError.dynamic_budget || 0) || null,
    };
    updateTask(sessionId, { status, lastError: { code: normalizedError.code || 'AGENT_TASK_FAILED', message: normalizedError.message || '任务执行失败' }, finished: !interrupted });
    emit(sessionId, runId, { type: 'artifact', artifact_type: 'run_error', status: interrupted ? 'queued_resume' : 'failed', error_category: interrupted ? 'interrupted' : 'fatal', error_code: interrupted ? 'WORKER_INTERRUPTED' : (normalizedError.code || 'AGENT_TASK_FAILED'), message: interrupted ? '任务已保存，将在服务恢复后继续执行。' : normalizedError.code === 'PROMPT_MODULE_BUDGET_EXCEEDED' ? '任务材料超过 Prompt 预算；已记录模块和预算信息，请减少附件范围后重试。' : 'Agent 执行异常，执行记录已保留。', diagnostics, resumable: interrupted });
    logger.error('agent.task.failed', { session_id: sessionId, diagnostics, error: normalizedError });
    if (resumeJob) {
      updateResumeJob(resumeJob.id, { status: interrupted ? 'queued' : 'failed', errorCode: normalizedError.code || 'AGENT_TASK_FAILED', finished: !interrupted });
      if (!interrupted) updateTask(sessionId, { resumeJobId: null });
    }
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
