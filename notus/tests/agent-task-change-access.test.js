const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const workspace = read('components/AgentWorkspace/AgentWorkspace.js');
const fileWorkspace = read('components/AgentWorkspace/FileAgentWorkspace.js');

assert.ok(workspace.includes('onRefreshTaskChangeSet'), '累计 Diff 详情读取失败时必须能请求新的只读凭证');
assert.ok(workspace.includes('onRefreshTaskChangeSet?.(sessionId)'), '累计 Diff 详情必须在无凭证或凭证失效时刷新会话摘要后重试');
assert.ok(workspace.includes('无法读取累计修改详情'), '累计 Diff 详情失败必须保留可诊断的受控错误码');
assert.ok(fileWorkspace.includes('refreshTaskChangeSetAccess'), '文件工作区必须从当前对话重新签发累计 Diff 的读取凭证');
assert.ok(fileWorkspace.includes('onRefreshTaskChangeSet={refreshTaskChangeSetAccess}'), '累计 Diff 详情组件必须使用文件工作区提供的凭证刷新回调');

console.log('agent task change access tests passed');
