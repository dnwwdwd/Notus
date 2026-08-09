const { ensureRuntime } = require('../../../lib/runtime');
const { createLogger, createRequestContext } = require('../../../lib/logger');
const {
  deleteConversation,
  getConversation,
  getConversationMessages,
} = require('../../../lib/conversations');
const { listOperationSetsByConversation, listOperationSetsBySession } = require('../../../lib/canvasOperationSets');
const { listInteractionsByConversation } = require('../../../lib/conversationInteractions');
const { countSnapshots, listRunEvents, listRunLogs, listSessionsByConversation } = require('../../../lib/agentSession');
const { sanitizeResearchReceipts } = require('../../../lib/agentResearch');
const { issueCapability, listResumeJobsByConversation, recoverStaleRunLeases } = require('../../../lib/agentControlPlane');
const { getTaskBySession, getQueuePosition } = require('../../../lib/agentTaskQueue');

export default function handler(req, res) {
  const context = createRequestContext(req, res, '/api/conversations/[id]');
  const logger = createLogger(context);
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    logger.error('canvas.operation_set.restored', { error: runtime.error });
    return res.status(500).json({ error: runtime.error.message, code: 'RUNTIME_ERROR', request_id: context.request_id });
  }

  const id = Number(req.query.id);

  if (req.method === 'GET') {
    const conversation = getConversation(id);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND', request_id: context.request_id });
    }
    const messages = getConversationMessages(id);
    const pendingOperationSets = ['canvas', 'knowledge'].includes(conversation.kind)
      ? listOperationSetsByConversation(id, {
        articleHash: String(req.query.article_hash || '').trim() || undefined,
      })
      : [];
    const pendingInteractions = ['canvas', 'knowledge', 'agent'].includes(conversation.kind)
      ? listInteractionsByConversation(id, {
        articleHash: String(req.query.article_hash || '').trim() || undefined,
      })
      : [];
    // 应用或进程在运行中退出时 finally 可能来不及释放 lease。读取会话时先把
    // 已过期的 running 收敛成可恢复状态，避免前端永久认为任务仍在执行。
    recoverStaleRunLeases({ conversationId: id });
    const agentSessions = listSessionsByConversation(id).map((session) => {
      const active = ['created', 'queued', 'running', 'waiting_interaction', 'queued_resume', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'].includes(session.status);
      return {
        ...session,
        snapshots_count: countSnapshots(session.id),
        run_logs: listRunLogs(session.id),
        run_events: listRunEvents(session.id),
        research_receipts: sanitizeResearchReceipts(session.id),
        operation_sets: listOperationSetsBySession(session.id),
        task: getTaskBySession(session.id),
        queue_position: getQueuePosition(session.id),
        control_tickets: {
          read: issueCapability({ sessionId: session.id, action: 'session_read' }),
          rollback: issueCapability({ sessionId: session.id, action: 'rollback' }),
          operate: issueCapability({ sessionId: session.id, action: 'operate' }),
          ...(active ? {
            cancel: issueCapability({ sessionId: session.id, action: 'cancel' }),
            resume: issueCapability({ sessionId: session.id, action: 'resume_session' }),
            extend: issueCapability({ sessionId: session.id, action: 'extend' }),
          } : {}),
        },
      };
    });
    const sessionById = new Map(agentSessions.map((session) => [session.id, session]));
    const interactionsWithTickets = pendingInteractions.map((interaction) => {
      const sessionId = Number(interaction?.payload?.agent_session_id || 0);
      if (interaction.source !== 'agent_loop' || !sessionById.has(sessionId) || interaction.status !== 'pending') return interaction;
      return {
        ...interaction,
        resume_ticket: issueCapability({ sessionId, interactionId: interaction.id, action: 'respond' }),
      };
    });
    const resumeJobs = listResumeJobsByConversation(id).map((job) => ({
      ...job,
      resume_ticket: job.status === 'queued' ? issueCapability({
        sessionId: job.session_id,
        interactionId: job.interaction_id,
        resumeJobId: job.id,
        action: 'resume',
      }) : null,
    }));
    if (conversation.kind === 'canvas') {
      logger.info('canvas.operation_set.restored', {
        conversation_id: conversation.id,
        file_id: conversation.file_id || null,
        canvas_mode: 'restore',
        scope_mode: 'none',
        operation_kind: '',
        helper_used: false,
        operation_count: pendingOperationSets.reduce((sum, item) => {
          return sum + (Array.isArray(item.operations) ? item.operations.length : 0);
        }, 0),
        fallback_reason: null,
        operation_set_status: pendingOperationSets.map((item) => item.status).join(',') || null,
      });
    }
    return res.status(200).json({
      ...conversation,
      messages,
      pending_operation_sets: pendingOperationSets,
      pending_interactions: interactionsWithTickets,
      agent_resume_jobs: resumeJobs,
      agent_sessions: agentSessions,
      request_id: context.request_id,
    });
  }

  if (req.method === 'DELETE') {
    const deleted = deleteConversation(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND', request_id: context.request_id });
    }
    return res.status(204).end();
  }

  return res.status(405).end();
}
