const { createLogger } = require('./logger');
const { resolveLlmRuntimeConfig } = require('./llmConfigs');
const { runAgentLoop } = require('./agentLoop');
const { prepareMcpTools } = require('./mcp');
const { getSession, updateSessionStatus } = require('./agentSession');
const { appendConversationMessage, touchConversation } = require('./conversations');
const { parseAgentInputSources } = require('./agentInputSources');
const { loadAttachments } = require('./parsedAttachmentStore');
const { buildResearchSummary, buildWriteSummary, correctConflictingSourceClaims, registerParsedInputSources } = require('./agentResearch');
const { createInteraction, getInteractionById, updateInteraction } = require('./conversationInteractions');
const { acquireRunLease, registerActiveRun, releaseRunLease, renewRunLease, recoverStaleRunLeases, settleResumeJob } = require('./agentControlPlane');
const { assertAttachmentLimits, assertImageLimits, makeConversationImageReference } = require('./conversationImages');
const { persistTaskFinalMessage, claimRunnableTasks, updateTask, settleTaskRun, recoverOrphanedTasks, getTaskBySession } = require('./agentTaskQueue');
const { publish } = require('./agentRunEventBus');
const { getDb } = require('./db');
const { updateResumeJob } = require('./agentControlPlane');
const { mergeAgentMedia } = require('./agentMedia');
const { markTaskChangeSetFinished } = require('./agentTaskChangeSets');
const { composeTurnFrame } = require('./agentSemanticRuntime');
const { updateTurnFrame } = require('./agentTurnFrames');
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
  const historyDiscarded = () => Boolean(getTaskBySession(sessionId)?.input?.history_discarded);
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
    const userQuery = String(input.user_query || input.input_text || input.display_query || '').trim();
    let turnFrame = null;
    {
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
        // 内置搜索开关与 MCP 授权独立；MCP 可提供联网能力，显式禁网仍由意图规则处理。
        webSearchEnabled: Boolean(session.web_search_enabled || session.mcp_selection?.mode !== 'off' && session.mcp_selection?.mode),
        llmConfig,
        runId,
        resumeInteraction,
        allowSemanticPlanner: true,
      });
      if (historyDiscarded()) return;
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
        payload: { frame_version: turnFrame.frame_version, task_kind: turnFrame.intent?.task_kind || 'general' },
      });
      if (composed.clarification) {
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
      // URL reading is a model tool choice, including when the user names a specific MCP.
      selectedUrls: [],
      onEvent: (event) => emit(sessionId, runId, {
        ...event, type: 'progress', stage: event.type || 'attachment_progress', legacy_type: event.type,
        text: event.type === 'attachment_parse_start' ? `正在解析 ${event.source || '附件'}。` : event.status === 'error' ? `${event.source || '附件'}解析失败。` : `${event.source || '附件'}解析完成。`,
        conversation_id: conversationId,
      }),
    });
    if (historyDiscarded()) return;
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
    const preparedMcpContext = turnFrame?.intent?.verification?.network_allowed === false
      ? { tools: [], availableTools: [], map: {}, instructions: [] }
      : await prepareMcpTools(session.mcp_selection, session.goal, session.mcp_session_permissions || {}, { forceRefresh: true });
    if (controller.signal.aborted || historyDiscarded()) return;
    // Keep only durable references in checkpoints; bytes are loaded at the Provider boundary.
    const initialImages = images.map((image) => ({
      type: 'image_reference',
      image_ref: makeConversationImageReference(task.user_message_id, image.id),
      name: image.name,
      upload_order: image.upload_order,
    })).sort((left, right) => Number(left.upload_order || 0) - Number(right.upload_order || 0));
    if (initialImages.length) emit(sessionId, runId, {
      type: 'progress', stage: 'image_view_start', text: `正在将 ${initialImages.length} 张原图交给模型。`,
      conversation_id: conversationId, message_id: task.user_message_id,
      image_count: initialImages.length, images: buildViewedImagePreviews(images, conversationId),
    });
    if (historyDiscarded()) return;
    const loopResult = await runAgentLoop({
      sessionId, runId, llmConfig, signal: controller.signal, approvalMode: task.approval_mode,
      taskId: task.id, turnFrame, preparedMcpContext,
      resumeInteractionId: Number(resumeJob?.interaction_id || input.resume_interaction_id || 0) || null, initialImages,
      onStream: (event) => {
        if (event.type === 'final') {
          assistantText = String(event.text || '');
          const corrected = correctConflictingSourceClaims(assistantText, sessionId);
          if (corrected.corrected) { assistantText = corrected.text; event = { ...event, text: assistantText }; }
          finalEvent = event;
        }
      },
    });
    if (historyDiscarded()) return;
    if (initialImages.length) emit(sessionId, runId, {
      type: 'progress', stage: 'image_view_done', text: '本轮图片输入处理已结束。',
      conversation_id: conversationId, message_id: task.user_message_id,
      image_count: initialImages.length, images: buildViewedImagePreviews(images, conversationId),
    });
    const finalSession = getSession(sessionId);
    const status = finalSession.status || loopResult?.status || 'failed';
    if (['completed', 'failed', 'cancelled'].includes(status)) markTaskChangeSetFinished(sessionId, status);
    if (status === 'waiting_interaction' && loopResult?.interaction?.id && !loopResult.interaction.message_id) {
      const intro = String(loopResult.interaction?.payload?.clarify_intro || '').trim() || (loopResult.interaction.kind === 'resource_approval' ? '资源操作等待确认，确认后继续当前任务。' : '请回答这张提问卡片后继续执行。');
      const messageId = appendConversationMessage({ conversationId, role: 'assistant', content: intro, meta: { agent_loop: true, session_id: sessionId, status, answer_mode: 'clarify_needed', interaction_id: loopResult.interaction.id, interaction_kind: loopResult.interaction.kind || 'clarify_card', reason: loopResult.reason } });
      updateInteraction(loopResult.interaction.id, { messageId });
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      persistTaskFinalMessage(sessionId, {
        content: assistantText.trim() || loopResult?.final_text || `Agent 任务已${status === 'completed' ? '完成' : status === 'cancelled' ? '取消' : '结束'}。`,
        status,
        meta: { operation_set_id: loopResult?.operation_set_id || null, research_summary: buildResearchSummary(sessionId), write_summary: buildWriteSummary(sessionId), usage: finalEvent?.usage || loopResult?.usage || null },
      });
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
    if (historyDiscarded()) return;
    const cancelled = controller.signal.aborted && controller.signal.reason === 'cancel';
    const interrupted = controller.signal.aborted && !cancelled;
    const status = cancelled ? 'cancelled' : interrupted ? 'queued' : 'failed';
    try { updateSessionStatus(sessionId, cancelled ? 'cancelled' : interrupted ? 'queued_resume' : 'failed'); } catch {}
    if (!interrupted) {
      try { markTaskChangeSetFinished(sessionId, cancelled ? 'cancelled' : 'failed'); } catch {}
    }
    updateTask(sessionId, { status, lastError: { code: error.code || 'AGENT_TASK_FAILED', message: error.message || '任务执行失败' }, finished: !interrupted });
    recordRuntimeFact({ eventKey: `task:${task.id}:run:${runId}:${status}`, conversationId, sessionId, taskId: task.id, runId, actor: cancelled ? 'user' : 'runtime', factType: cancelled ? 'task_cancelled' : interrupted ? 'task_interrupted' : 'task_failed', payload: { error_code: error.code || 'AGENT_TASK_FAILED' } });
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
  reconcileUnresolvedToolCalls();
  schedule();
  workerState.timer = setInterval(schedule, 1_000);
  if (workerState.timer.unref) workerState.timer.unref();
}

function stopAgentTaskWorker() {
  if (workerState.timer) clearInterval(workerState.timer);
  workerState.timer = null;
}

function wakeAgentTaskWorker() { schedule(); }
module.exports = { startAgentTaskWorker, stopAgentTaskWorker, wakeAgentTaskWorker };
