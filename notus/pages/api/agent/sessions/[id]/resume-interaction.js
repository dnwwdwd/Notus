const { ensureRuntime } = require('../../../../../lib/runtime');
const { resolveLlmRuntimeConfig } = require('../../../../../lib/llmConfigs');
const { runAgentLoop } = require('../../../../../lib/agentLoop');
const { getSession, recordRunEvent, updateSessionStatus } = require('../../../../../lib/agentSession');
const { appendConversationMessage, touchConversation } = require('../../../../../lib/conversations');
const {
  acquireRunLease,
  getResumeJob,
  registerActiveRun,
  releaseRunLease,
  renewRunLease,
  updateResumeJob,
  validateCapability,
} = require('../../../../../lib/agentControlPlane');
const { buildResearchSummary, buildWriteSummary } = require('../../../../../lib/agentResearch');

function send(res, payload) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function heartbeat(res) {
  if (!res.writableEnded) res.write(': heartbeat\n\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  const runtime = ensureRuntime();
  if (!runtime.ok) return res.status(500).json({ error: 'Agent 服务初始化失败', code: 'RUNTIME_ERROR' });

  const sessionId = Number(req.query.id || 0);
  const resumeJobId = String(req.body?.resume_job_id || '').trim();
  const resumeTicket = req.body?.resume_ticket || req.headers['x-agent-resume-ticket'];
  const job = getResumeJob(resumeJobId);
  if (!sessionId || !job || job.session_id !== sessionId) {
    return res.status(404).json({ error: '续跑任务不存在', code: 'RESUME_JOB_NOT_FOUND' });
  }

  const capability = validateCapability(resumeTicket, {
    sessionId,
    interactionId: job.interaction_id,
    resumeJobId: job.id,
    action: 'resume',
  }, { consume: true });
  if (!capability.valid) return res.status(403).json({ error: capability.reason, code: capability.reason });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  if (capability.consumed || ['running', 'completed', 'failed', 'cancelled'].includes(job.status)) {
    send(res, { type: 'session_resumed', protocol_version: 2, session_id: sessionId, resume_job_id: job.id, idempotent_replay: true });
    if (job.status === 'completed') {
      send(res, { type: 'final', ...(job.result || {}), status: 'completed', idempotent_replay: true });
    } else {
      send(res, { type: 'artifact', artifact_type: 'resume_job', resume_job: job });
    }
    return res.end();
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort('disconnect');
  });
  const heartbeatTimer = setInterval(() => heartbeat(res), 15_000);
  let leaseTimer = null;
  let runId = null;
  let finalEvent = null;
  const releaseLeaseBeforeResumeEvent = (event) => {
    if (
      event?.type !== 'artifact'
      || event?.artifact_type !== 'run_error'
      || !event?.resumable
      || !runId
    ) return;
    if (leaseTimer) {
      clearInterval(leaseTimer);
      leaseTimer = null;
    }
    try {
      if (releaseRunLease(sessionId, runId)) runId = null;
    } catch {}
  };
  try {
    const lease = acquireRunLease(sessionId, { allowedStatuses: ['queued_resume', 'running'] });
    if (!lease.acquired) {
      send(res, { type: 'error', error: lease.reason, code: lease.reason });
      return res.end();
    }
    runId = lease.runId;
    registerActiveRun(runId, controller);
    updateResumeJob(job.id, { status: 'running', runId, incrementAttempt: true, started: true });
    leaseTimer = setInterval(() => {
      const renewed = renewRunLease(sessionId, runId);
      if (!renewed.renewed && !controller.signal.aborted) controller.abort('lease_lost');
    }, 20_000);

    const session = getSession(sessionId);
    send(res, {
      type: 'session_resumed',
      protocol_version: 2,
      session_id: sessionId,
      conversation_id: session.conversation_id,
      resume_job_id: job.id,
    });

    const llmConfig = resolveLlmRuntimeConfig({ llmConfigId: req.body?.llm_config_id || undefined });
    const result = await runAgentLoop({
      sessionId,
      runId,
      llmConfig,
      signal: controller.signal,
      resumeInteractionId: job.interaction_id,
      approvalMode: req.body?.approval_mode || 'auto_confirm',
      onStream(event) {
        releaseLeaseBeforeResumeEvent(event);
        if (event.type === 'final') finalEvent = event;
        send(res, { ...event, session_id: sessionId, conversation_id: session.conversation_id, resume_job_id: job.id });
      },
    });

    const terminal = ['completed', 'failed', 'cancelled'].includes(result.status);
    if (terminal && session.conversation_id && finalEvent) {
      appendConversationMessage({
        conversationId: session.conversation_id,
        role: 'assistant',
        content: String(finalEvent.text || result.final_text || 'Agent 任务已结束。'),
        meta: {
          agent_loop: true,
          session_id: sessionId,
          status: result.status,
          operation_set_id: result.operation_set_id || null,
          usage: finalEvent.usage || result.usage || null,
          research_summary: buildResearchSummary(sessionId),
          write_summary: buildWriteSummary(sessionId),
        },
      });
      touchConversation(session.conversation_id);
    }
    updateResumeJob(job.id, {
      status: terminal ? result.status : 'queued',
      result: terminal ? { ...finalEvent, final_text: result.final_text || finalEvent?.text || '' } : result,
      finished: terminal,
    });
  } catch (error) {
    const disconnected = controller.signal.aborted && controller.signal.reason !== 'cancel';
    if (disconnected) {
      updateSessionStatus(sessionId, 'queued_resume');
      updateResumeJob(job.id, { status: 'queued', errorCode: null });
    } else {
      updateSessionStatus(sessionId, controller.signal.reason === 'cancel' ? 'cancelled' : 'failed');
      updateResumeJob(job.id, { status: controller.signal.reason === 'cancel' ? 'cancelled' : 'failed', errorCode: error.code || 'AGENT_LOOP_FAILED', finished: true });
      send(res, { type: 'error', error: error.message, code: error.code || 'AGENT_LOOP_FAILED' });
    }
    if (controller.signal.reason !== 'cancel') {
      try {
        recordRunEvent({
          sessionId,
          runId,
          event: {
            type: 'artifact',
            artifact_type: 'run_error',
            status: disconnected ? 'queued_resume' : 'failed',
            error_category: disconnected ? 'interrupted' : 'fatal',
            error_code: disconnected ? 'CONNECTION_INTERRUPTED' : (error.code || 'AGENT_LOOP_FAILED'),
            message: disconnected ? '连接已中断，工具链、回复草稿和任务进度已保留。' : 'Agent 续跑异常，已保留中断前的执行记录。',
            resumable: disconnected,
          },
        });
      } catch {}
    }
  } finally {
    clearInterval(heartbeatTimer);
    if (leaseTimer) clearInterval(leaseTimer);
    if (runId) {
      try { releaseRunLease(sessionId, runId); } catch {}
    }
  }
  return res.end();
}
