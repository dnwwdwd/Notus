const { createLogger } = require('./logger');
const { resolveLlmRuntimeConfig } = require('./llmConfigs');
const { runAgentLoop } = require('./agentLoop');
const { getSession, updateSessionStatus } = require('./agentSession');
const { appendConversationMessage, touchConversation } = require('./conversations');
const { parseAgentInputSources } = require('./agentInputSources');
const { loadAttachments } = require('./parsedAttachmentStore');
const { recognizeConversationImages } = require('./imageRecognition');
const { buildResearchSummary, buildWriteSummary, correctConflictingSourceClaims, registerParsedInputSources } = require('./agentResearch');
const { createInteraction, getInteractionById, updateInteraction } = require('./conversationInteractions');
const { acquireRunLease, registerActiveRun, releaseRunLease, renewRunLease, recordRunUsage, recoverStaleRunLeases, settleResumeJob } = require('./agentControlPlane');
const { assertAttachmentLimits, assertImageContextSize, assertImageLimits, getImageInputBlocks, MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES } = require('./conversationImages');
const { claimRunnableTasks, updateTask, settleTaskRun, recoverOrphanedTasks, getTaskBySession } = require('./agentTaskQueue');
const { publish } = require('./agentRunEventBus');
const { getDb } = require('./db');
const { updateResumeJob } = require('./agentControlPlane');
const { mergeAgentMedia } = require('./agentMedia');
const { markTaskChangeSetFinished } = require('./agentTaskChangeSets');
const { agentRuntimeAtLeast, getAgentRuntimeMode } = require('./agentRuntimeMode');
const { composeTurnFrame } = require('./agentSemanticRuntime');
const { updateTurnFrame } = require('./agentTurnFrames');
const { executeRuntimeSearchMission, getSearchCapabilityLimitation } = require('./agentSearchMission');
const { recordRuntimeFact, reconcileUnresolvedToolCalls } = require('./agentRuntimeFacts');

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

function finishWithCapabilityLimitation({ task, sessionId, conversationId, runId, turnFrame, limitation, resumeJob = null }) {
  const finalText = String(limitation?.message || '当前运行环境不具备完成任务所需的能力。').trim();
  updateSessionStatus(sessionId, 'failed');
  markTaskChangeSetFinished(sessionId, 'failed');
  const messageId = appendConversationMessage({
    conversationId,
    role: 'assistant',
    content: finalText,
    meta: { agent_loop: true, session_id: sessionId, status: 'failed', reason: 'capability_limit' },
  });
  updateTask(sessionId, { status: 'failed', finalMessageId: messageId, finished: true });
  recordRuntimeFact({
    eventKey: `task:${task.id}:capability-limit:${limitation.code}`,
    conversationId,
    sessionId,
    taskId: task.id,
    turnFrameId: turnFrame?.id,
    runId,
    actor: 'runtime',
    factType: 'capability_limited',
    payload: { capability: 'web_search', error_code: limitation.code },
  });
  emit(sessionId, runId, { type: 'final', text: finalText, status: 'failed', reason: 'capability_limit' });
  touchConversation(conversationId);
  settleTaskRun(sessionId, 'failed', { finished: true });
  if (resumeJob) {
    settleResumeJob(resumeJob.id, 'failed');
    updateTask(sessionId, { resumeJobId: null });
  }
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
    const runtimeMode = getAgentRuntimeMode();
    const media = splitMedia(input);
    const attachments = assertAttachmentLimits(conversationId, media.attachments);
    const images = assertImageLimits(conversationId, media.images);
    const llmConfig = resolveLlmRuntimeConfig({ llmConfigId: task.llm_config_id || input.llm_config_id || undefined });
    if (String(llmConfig.llmApiProtocol || '').toLowerCase() === 'anthropic') assertImageContextSize(images, MAX_ANTHROPIC_IMAGE_CONTEXT_BYTES);
    const userQuery = String(input.user_query || input.input_text || input.display_query || '').trim();
    let turnFrame = null;
    if (agentRuntimeAtLeast('shadow', runtimeMode)) {
      const resumeInteraction = resumeJob?.interaction_id ? getInteractionById(resumeJob.interaction_id) : null;
      if (resumeInteraction?.payload?.origin === 'turn_composer' && resumeInteraction.status === 'cancelled') {
        updateSessionStatus(sessionId, 'cancelled');
        updateTask(sessionId, { status: 'cancelled', finished: true });
        recordRuntimeFact({ eventKey: `task:${task.id}:turn-composer-cancelled`, conversationId, sessionId, taskId: task.id, runId, actor: 'user', factType: 'task_cancelled', payload: { interaction_id: resumeInteraction.id } });
        emit(sessionId, runId, { type: 'final', text: '任务已取消。', status: 'cancelled', reason: 'turn_composer_cancelled' });
        settleResumeJob(resumeJob.id, 'cancelled');
        updateTask(sessionId, { resumeJobId: null });
        return;
      }
      const composed = await composeTurnFrame({
        task,
        session,
        userQuery,
        mentions: Array.isArray(input.mentions) ? input.mentions : [],
        attachments,
        activeFileId: Number(input.turn_context?.active_file_id || 0) || null,
        webSearchEnabled: Boolean(session.web_search_enabled),
        llmConfig,
        runId,
        resumeInteraction,
        allowSemanticPlanner: agentRuntimeAtLeast('search', runtimeMode),
      });
      turnFrame = composed.frame;
      recordRuntimeFact({
        eventKey: `turn-frame:${turnFrame.id}:active`,
        conversationId,
        sessionId,
        taskId: task.id,
        turnFrameId: turnFrame.id,
        runId,
        actor: 'runtime',
        factType: 'turn_frame_activated',
        payload: { frame_version: turnFrame.frame_version, task_kind: turnFrame.intent?.task_kind || 'general', runtime_mode: runtimeMode },
      });
      if (agentRuntimeAtLeast('search', runtimeMode) && composed.clarification) {
        const interaction = createInteraction({
          conversationId,
          kind: 'clarify_card',
          source: 'agent_loop',
          reasonCode: composed.clarification.reason_code,
          payload: {
            origin: 'turn_composer',
            turn_frame_id: turnFrame.id,
            agent_session_id: sessionId,
            title: composed.clarification.title,
            intro: composed.clarification.intro,
            clarify_intro: composed.clarification.intro,
            submit_label: '继续执行',
            questions: composed.clarification.questions,
          },
        });
        const messageId = appendConversationMessage({
          conversationId,
          role: 'assistant',
          content: composed.clarification.intro,
          meta: { agent_loop: true, session_id: sessionId, status: 'waiting_interaction', answer_mode: 'clarify_needed', interaction_id: interaction.id, interaction_kind: interaction.kind, reason: 'turn_composer_clarification' },
        });
        const updatedInteraction = updateInteraction(interaction.id, { messageId });
        updateSessionStatus(sessionId, 'waiting_interaction');
        updateTask(sessionId, { status: 'waiting_interaction' });
        recordRuntimeFact({ eventKey: `turn-frame:${turnFrame.id}:clarification:${interaction.id}`, conversationId, sessionId, taskId: task.id, turnFrameId: turnFrame.id, runId, actor: 'runtime', factType: 'clarification_requested', payload: { interaction_id: interaction.id, origin: 'turn_composer' } });
        emit(sessionId, runId, { type: 'artifact', artifact_type: 'interaction', interaction: updatedInteraction, reason: 'turn_composer_clarification' });
        touchConversation(conversationId);
        settleTaskRun(sessionId, 'waiting_interaction', { finished: false });
        if (resumeJob) {
          settleResumeJob(resumeJob.id, 'waiting_interaction');
          updateTask(sessionId, { resumeJobId: null });
        }
        return;
      }
    }
    const parsedAttachments = await parseAgentInputSources({
      conversationId,
      attachments,
      userInputText: userQuery,
      sourceMessageId: task.user_message_id,
      selectedUrls: agentRuntimeAtLeast('search', runtimeMode) ? (turnFrame?.intent?.direct_url_policy?.inspect_urls || []) : undefined,
      onEvent: (event) => emit(sessionId, runId, {
        ...event, type: 'progress', stage: event.type || 'attachment_progress', legacy_type: event.type,
        text: event.type === 'attachment_parse_start' ? `正在解析 ${event.source || '附件'}。` : event.status === 'error' ? `${event.source || '附件'}解析失败。` : `${event.source || '附件'}解析完成。`,
        conversation_id: conversationId,
      }),
    });
    if (turnFrame && parsedAttachments.length) {
      turnFrame = updateTurnFrame(turnFrame.id, {
        facts: {
          ...(turnFrame.facts || {}),
          parsed_resources: parsedAttachments.map((item) => ({
            message_id: item.messageId || null,
            source: item.source,
            content_hash: item.contentHash || '',
            type: item.type,
            status: item.status,
          })),
        },
      }) || turnFrame;
    }
    registerParsedInputSources({ sessionId, conversationId, parsedAttachments, attachments: loadAttachments(conversationId) });
    if (agentRuntimeAtLeast('search', runtimeMode) && turnFrame) {
      const mission = await executeRuntimeSearchMission({ session, task, frame: turnFrame, userQuery, llmConfig, runId });
      turnFrame = mission.frame || turnFrame;
      if (mission.executed && mission.receipt?.payload_unavailable) {
        throw Object.assign(new Error('联网研究已经执行，但完整结果无法安全保存，后续步骤已停止。'), {
          code: 'TOOL_RESULT_PAYLOAD_UNAVAILABLE',
        });
      }
      const searchCapabilityLimitation = getSearchCapabilityLimitation(mission.result);
      if (searchCapabilityLimitation) {
        finishWithCapabilityLimitation({ task, sessionId, conversationId, runId, turnFrame, limitation: searchCapabilityLimitation, resumeJob });
        return;
      }
    }
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
      taskId: task.id, turnFrame,
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
    if (status === 'waiting_interaction' && loopResult?.interaction?.id && !loopResult.interaction.message_id) {
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
    const cancelled = controller.signal.aborted && controller.signal.reason === 'cancel';
    const interrupted = controller.signal.aborted && !cancelled;
    const status = cancelled ? 'cancelled' : interrupted ? 'queued' : 'failed';
    try { updateSessionStatus(sessionId, cancelled ? 'cancelled' : interrupted ? 'queued_resume' : 'failed'); } catch {}
    if (!interrupted) {
      try { markTaskChangeSetFinished(sessionId, cancelled ? 'cancelled' : 'failed'); } catch {}
    }
    updateTask(sessionId, { status, lastError: { code: error.code || 'AGENT_TASK_FAILED', message: error.message || '任务执行失败' }, finished: !interrupted });
    if (agentRuntimeAtLeast('facts')) {
      recordRuntimeFact({ eventKey: `task:${task.id}:run:${runId}:${status}`, conversationId, sessionId, taskId: task.id, runId, actor: cancelled ? 'user' : 'runtime', factType: cancelled ? 'task_cancelled' : interrupted ? 'task_interrupted' : 'task_failed', payload: { error_code: error.code || 'AGENT_TASK_FAILED' } });
    }
    emit(sessionId, runId, { type: 'artifact', artifact_type: 'run_error', status: interrupted ? 'queued_resume' : 'failed', error_category: interrupted ? 'interrupted' : 'fatal', error_code: interrupted ? 'WORKER_INTERRUPTED' : (error.code || 'AGENT_TASK_FAILED'), message: interrupted ? '任务已保存，将在服务恢复后继续执行。' : 'Agent 执行异常，执行记录已保留。', resumable: interrupted });
    logger.error('agent.task.failed', { session_id: sessionId, error });
    if (resumeJob) {
      updateResumeJob(resumeJob.id, { status: interrupted ? 'queued' : 'failed', errorCode: error.code || 'AGENT_TASK_FAILED', finished: !interrupted });
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
  if (agentRuntimeAtLeast('facts')) reconcileUnresolvedToolCalls();
  schedule();
  workerState.timer = setInterval(schedule, 1_000);
  if (workerState.timer.unref) workerState.timer.unref();
}

function wakeAgentTaskWorker() { schedule(); }
module.exports = { startAgentTaskWorker, wakeAgentTaskWorker };
