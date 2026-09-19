const { getDb } = require('./db');
const { getSessionTurnFrame } = require('./agentTurnFrames');
const { hasUnknownToolOutcome } = require('./agentRuntimeFacts');

// 只处理没有新增范围的短句承接；否定、附加要求和新任务继续走正常意图判断。
function isTaskContinuation(text = '') {
  return /^(?:请|请帮我|帮我)?(?:继续|接着)(?:完成|执行|做)?(?:(?:刚才|之前|上一个|上一轮|未完成|剩下)(?:的)?(?:任务|工作|步骤))?[。！.!\s]*$/.test(
    String(text || '').replace(/^用户任务[：:]\s*/, '').trim()
  );
}

function resolveFailedFileContinuation(session, depth = 0) {
  if (!session?.conversation_id || !isTaskContinuation(session.goal) || depth >= 8) return null;
  const db = getDb();
  const previous = db.prepare(`SELECT * FROM agent_sessions
    WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT 1`)
    .get(session.conversation_id, session.id);
  // 不越过已完成、取消或等待确认的任务去寻找更早的失败任务。
  if (!previous || previous.status !== 'failed' || hasUnknownToolOutcome(previous.id)) return null;
  const task = db.prepare('SELECT user_message_id FROM agent_task_queue WHERE session_id = ?').get(previous.id);
  if (task?.user_message_id && !db.prepare('SELECT id FROM messages WHERE id = ?').get(task.user_message_id)) return null;
  const frame = getSessionTurnFrame(previous.id);
  const inherited = frame?.facts?.failed_file_continuation || resolveFailedFileContinuation(previous, depth + 1);
  const goal = inherited?.goal || previous.goal;
  const intent = frame?.intent || require('./agentSemanticRuntime').deterministicIntent(goal);
  if (!intent.completion_criteria?.requires_write && !inherited) return null;
  const operations = db.prepare(`SELECT id, status FROM canvas_operation_sets
    WHERE agent_session_id = ? ORDER BY id`).all(previous.id);
  return {
    source_session_id: previous.id,
    goal,
    active_file: inherited?.active_file || frame?.facts?.active_file || null,
    operation_sets: operations,
    completed_file_tools: db.prepare(`SELECT payload_json FROM agent_run_events
      WHERE session_id = ? AND stage = 'tool_done' ORDER BY id DESC LIMIT 40`).all(previous.id)
      .reverse().flatMap((row) => {
        let event;
        try { event = JSON.parse(row.payload_json); } catch { return []; }
        if (event.failed || !['create_note', 'read_file', 'preview_file_revision', 'preview_patch_files', 'preview_file_operations'].includes(event.tool_name)) return [];
        return [{ tool: event.tool_name, path: event.result_summary?.file_path || event.result_summary?.path || '', operation_set_id: event.result_summary?.operation_set_id || null }];
      }),
  };
}

function formatFailedFileContinuation(continuation) {
  if (!continuation) return '';
  return [
    '本轮用户明确要求承接紧邻的失败文件任务。以下是运行时保留的原目标与已发生的变更记录：',
    JSON.stringify(continuation),
    '先核对已有文件和变更记录，只完成剩余步骤；已经创建的文件不要重复创建或覆盖。原任务的变更不代表本轮剩余修改已保存。',
  ].join('\n');
}

module.exports = { isTaskContinuation, resolveFailedFileContinuation, formatFailedFileContinuation };
