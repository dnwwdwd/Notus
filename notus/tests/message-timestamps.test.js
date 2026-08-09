const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { formatFullTimestamp, formatMessageTimestamp, parseMessageTimestamp } = require('../utils/messageTimestamps');

const root = path.resolve(__dirname, '..');
const workspace = fs.readFileSync(path.join(root, 'components/AgentWorkspace/AgentWorkspace.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'hooks/useAgentLoopController.js'), 'utf8');
const conversations = fs.readFileSync(path.join(root, 'utils/conversations.js'), 'utf8');

const now = new Date('2026-07-23T14:30:00+08:00');

assert.strictEqual(
  formatMessageTimestamp('2026-07-23 05:15:00', { now }),
  '13:15',
  '当天消息只显示本地时间。'
);
assert.strictEqual(
  formatMessageTimestamp('2026-07-22T06:29:59.000Z', { now }),
  '昨天 14:29',
  '昨天消息显示相对日期和时间，不显示星期。'
);
assert.strictEqual(
  formatMessageTimestamp('2026-07-21T06:29:59.000Z', { now }),
  '周二 14:29',
  '前天到最近 7 个日历日内显示星期和时间。'
);
assert.strictEqual(
  formatMessageTimestamp('2026-07-16T06:29:59.000Z', { now }),
  '2026-07-16 14:29',
  '超过 7×24 小时的消息应显示完整日期与分钟。'
);
assert.strictEqual(
  formatMessageTimestamp('2026-07-16T06:30:00.000Z', { now }),
  '2026-07-16 14:30',
  '达到 7×24 小时边界的消息应显示完整日期与时间。'
);
assert.strictEqual(formatMessageTimestamp('invalid', { now }), '');
assert.strictEqual(parseMessageTimestamp('2026-07-23 05:15:00').toISOString(), '2026-07-23T05:15:00.000Z');
assert.strictEqual(formatFullTimestamp('2026-08-09 13:10:00'), '2026-08-09 21:10:00', 'SQLite UTC 文本在日志页必须换算为东八区时间。');
assert.ok(workspace.includes("import { formatMessageTimestamp, parseMessageTimestamp } from '../../utils/messageTimestamps';"));
assert.ok(workspace.includes('function MessageTimestamp({ value, align = \'left\', inline = false })'));
assert.ok(workspace.includes('<MessageTimestamp value={timestamp} align="left" inline />'));
assert.ok(workspace.includes('<MessageTimestamp value={timestamp} align="right" inline />'));
assert.ok(workspace.includes('aria-label="用户消息操作"'));
assert.ok(workspace.includes('aria-label="AI 回复操作"'));
assert.ok(workspace.includes("aria-label=\"用户消息操作\" style={{ width: hasTextContent ? 'min(80%, 560px)' : undefined, display: 'flex', alignItems: 'center', justifyContent: 'flex-end'"));
assert.ok(workspace.includes("aria-label=\"AI 回复操作\" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start'"));
assert.ok(controller.includes('createdAt: event.created_at || event.createdAt || new Date().toISOString()'));
assert.ok(controller.includes('createdAt: new Date().toISOString()'));
assert.ok(conversations.includes("createdAt: message.created_at || message.updated_at || ''"));

console.log('message timestamp tests passed');
