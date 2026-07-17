const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../components/AgentWorkspace/AgentWorkspace.js'), 'utf8');

assert.ok(source.includes('const appendNode = (node) =>'), '输入内容应递归序列化浏览器生成的节点');
assert.ok(source.includes("node.nodeName === 'BR'"), '输入换行应参与普通文本序列化');
assert.ok(source.includes('const restoreComposerCaret = useCallback'), '删除 mention 后应恢复编辑光标');
assert.ok(source.includes('isRootSelection && rootOffset > 0'), '根节点选区删除 mention 应被处理');
assert.ok(source.includes('restoreComposerCaret(caretNode, caretOffset);'), '删除 mention 后应回到可编辑文本节点');
assert.ok(source.includes('Boolean(value.trim()) || files.length > 0 || mentions.length > 0'), '普通文本应独立满足发送条件');

console.log('agent input mention editing tests passed');
