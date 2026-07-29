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
assert.ok(source.includes("const start = prefix.lastIndexOf('@');"), 'Mention 应从最后一个 @ 开始解析');
assert.ok(source.includes("prefix.slice(start).match(/^@(?:\\{([^}]*)|([^@\\n]*))$/)"), '中文正文紧接 @ 时应能继续解析 Mention');
assert.ok(source.includes('/[A-Za-z0-9._%+-]/.test(prefix.charAt(start - 1))'), 'ASCII 邮箱本地部分不应触发 Mention 候选');
assert.ok(source.includes('const resolveComposerTextPosition = useCallback'), '输入法将光标挂在元素节点时也应解析 Mention');
assert.ok(source.includes('resolveComposerTextPosition(root, node, selection.anchorOffset)'), 'Mention 查询应使用兼容元素节点的光标位置');

console.log('agent input mention editing tests passed');
