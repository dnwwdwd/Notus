const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workspaceSource = fs.readFileSync(path.join(root, 'components/AgentWorkspace/AgentWorkspace.js'), 'utf8');
const controllerSource = fs.readFileSync(path.join(root, 'hooks/useAgentLoopController.js'), 'utf8');
const storageSource = fs.readFileSync(path.join(root, 'utils/agentComposerDraft.js'), 'utf8');

assert.ok(workspaceSource.includes('readAgentComposerDraft'), 'Agent 输入区应在浏览器端恢复草稿');
assert.ok(workspaceSource.includes('saveAgentComposerDraft'), 'Agent 输入区应保存未发送草稿');
assert.ok(workspaceSource.includes('clearAgentComposerDraft'), '成功发送后应清理草稿');
assert.ok(workspaceSource.includes('onTaskAccepted: clearAcceptedComposer'), '服务端确认接收任务后应立即清空待发送媒体');
assert.ok(workspaceSource.includes('if (taskAccepted) return;'), '任务已接收后即使后续流式失败，也不应恢复已发送媒体');
assert.ok(workspaceSource.includes('clearPendingFiles();'), '任务确认接收后应清空图片和附件队列');
assert.ok(controllerSource.includes('const notifyTaskAccepted'), 'SSE 创建任务成功后应通知输入框清理媒体');
assert.ok(controllerSource.includes('notifyTaskAccepted(event);'), 'session_created 事件应触发媒体清理');
assert.ok(workspaceSource.includes('restoreAgentComposerFiles'), '草稿恢复应重建待发送文件对象');
assert.ok(workspaceSource.includes('restoreComposerDom(segments)'), '草稿恢复应重建 mention 与文本顺序');
assert.ok(storageSource.includes('indexedDB.open'), '图片和文件应使用 IndexedDB 保存 Blob');
assert.ok(storageSource.includes('saved_at: Date.now()'), '草稿只记录保存时间，不设置过期时间');
assert.ok(!storageSource.includes('expires_at'), '浏览器草稿不应设置过期时间');

console.log('agent composer persistence tests passed');
