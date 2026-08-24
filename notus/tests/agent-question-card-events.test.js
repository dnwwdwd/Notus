const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { sanitizeRunEvent } = require('../lib/agentSession');
const { attachInteractionResumeTicket } = require('../lib/agentRunEventBus');

const rawEvent = {
  type: 'artifact',
  artifact_type: 'interaction',
  reason: 'question_card_requested',
  interaction: {
    id: 942,
    conversation_id: 31,
    kind: 'clarify_card',
    source: 'agent_loop',
    status: 'pending',
    schema_version: 1,
    reason_code: 'agent_question_card',
    payload: {
      title: '确认 Notus 发布范围',
      submit_label: '继续执行',
      original_user_input: '不应进入运行事件的完整任务内容',
      agent_session_id: 77,
      questions: [{
        id: 'target',
        label: '这次要先发布哪一个 Notus 安装包？',
        type: 'single_select',
        required: true,
        options: [{ id: 'macos', label: 'macOS', description: '生成 macOS 安装包。', answer_value: 'macos' }],
      }],
    },
  },
  resume_ticket: 'must-not-be-persisted',
};

const persistedEvent = sanitizeRunEvent(rawEvent);
assert.strictEqual(persistedEvent.interaction_id, 942, '运行事件必须保留交互 ID');
assert.strictEqual(persistedEvent.interaction.id, 942, '运行事件必须保留可渲染的提问卡片');
assert.strictEqual(persistedEvent.interaction.payload.questions[0].label, '这次要先发布哪一个 Notus 安装包？');
assert.strictEqual(persistedEvent.interaction.payload.agent_session_id, 77, '提问卡片恢复时必须知道所属 Agent session');
assert.ok(!Object.prototype.hasOwnProperty.call(persistedEvent.interaction.payload, 'original_user_input'), '运行事件不得重复保存完整用户任务');
assert.strictEqual(persistedEvent.resume_ticket, undefined, '恢复票据不得持久化到运行事件');

let issued = null;
const readOnlyEvent = attachInteractionResumeTicket(persistedEvent, {
  sessionId: 77,
  issueTicket: (input) => {
    issued = input;
    return 'transient-response-ticket';
  },
});
assert.strictEqual(issued, null, 'session_read SSE 不得升级为回答票据');
assert.strictEqual(readOnlyEvent.resume_ticket, undefined, '只读 SSE 不得输出回答票据');

const outboundEvent = attachInteractionResumeTicket(persistedEvent, {
  sessionId: 77,
  canIssueResumeTicket: true,
  issueTicket: (input) => {
    issued = input;
    return 'transient-response-ticket';
  },
});
assert.deepStrictEqual(issued, { sessionId: 77, interactionId: 942, action: 'respond' }, 'SSE 输出必须按当前 session 与交互范围签发回答票据');
assert.strictEqual(outboundEvent.resume_ticket, 'transient-response-ticket', '实时或补发事件必须带临时回答票据');
assert.strictEqual(persistedEvent.resume_ticket, undefined, '签发临时票据不得污染已持久化事件');

const completedEvent = attachInteractionResumeTicket({
  ...persistedEvent,
  interaction: { ...persistedEvent.interaction, status: 'answered' },
}, {
  sessionId: 77,
  issueTicket: () => 'unexpected-ticket',
});
assert.strictEqual(completedEvent.resume_ticket, undefined, '已回答交互不得再签发回答票据');

const malformedSchemaEvent = sanitizeRunEvent({
  ...rawEvent,
  interaction: { ...rawEvent.interaction, schema_version: 'not-a-number' },
});
assert.strictEqual(malformedSchemaEvent.interaction.schema_version, 1, '异常 schema 版本不能污染持久化运行事件');

const workspaceSource = fs.readFileSync(path.join(__dirname, '..', 'components/AgentWorkspace/FileAgentWorkspace.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(__dirname, '..', 'hooks/useAgentLoopController.js'), 'utf8');
const interactionRouteSource = fs.readFileSync(path.join(__dirname, '..', 'pages/api/interactions/[id]/respond.js'), 'utf8');
const startRouteSource = fs.readFileSync(path.join(__dirname, '..', 'pages/api/agent/loop/start.js'), 'utf8');
const conversationRouteSource = fs.readFileSync(path.join(__dirname, '..', 'pages/api/conversations/[id].js'), 'utf8');
const eventsRouteSource = fs.readFileSync(path.join(__dirname, '..', 'pages/api/agent/sessions/[id]/events.js'), 'utf8');
assert.ok(workspaceSource.includes('shouldReconnectInteractionSession'), '回答卡片后必须先判断当前 session 是否已有 SSE 订阅');
assert.ok(workspaceSource.includes('event_cursor: resume.event_cursor'), '重新订阅必须携带回答前的事件游标');
assert.ok(workspaceSource.includes('subscribe_only: true'), '刷新后回答卡片只能补建 SSE，不能再次唤醒任务');
assert.ok(controllerSource.includes('hasActiveSessionSubscription'), 'Agent Loop 必须能识别当前 session 是否仍有订阅');
assert.ok(controllerSource.includes('controller.eventsConnected = true'), '订阅状态必须在 SSE 真正连接后才视为活跃');
assert.ok(controllerSource.includes('const eventCursor = isResume && resumeEventCursor > 0'), '恢复订阅必须优先使用回答前的事件游标');
assert.ok(interactionRouteSource.includes('const eventCursor = getLatestRunEventId(agentSessionId);'), '回答接口必须在唤醒 Worker 前记录事件游标');
assert.ok(interactionRouteSource.includes('claimInteractionProcessing'), '回答接口必须原子占用 pending interaction');
assert.ok(workspaceSource.includes('onRetry={resumeInteraction}'), '卡片重试入口仍需显式建立续跑订阅');
assert.ok(startRouteSource.includes("code: 'INTERACTION_RESPONSE_REQUIRED'"), '通用会话恢复不得绕过提问卡片确认');
assert.ok(startRouteSource.includes('subscribe_only: true'), '历史恢复应能只建立 SSE 订阅而不唤醒任务');
assert.ok(conversationRouteSource.includes("res.setHeader('Cache-Control', 'no-store, no-cache, no-transform')"), '会话详情含 capability 时不得被共享缓存保存');
assert.ok(eventsRouteSource.includes('const canIssueResumeTicket = !ticket;'), '只有 session token SSE 可以取得回答票据');
assert.ok(eventsRouteSource.includes('canIssueResumeTicket }'), 'SSE 签发回答票据必须传递能力边界');

console.log('agent question-card event tests passed');
