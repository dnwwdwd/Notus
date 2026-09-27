const assert = require('assert');
const { createDiffHunks } = require('../utils/lineDiff');
const changes = (a, b) => createDiffHunks(a, b).flatMap(h => h.lines).filter(l => l.type !== 'context');
const body = Array.from({ length: 6000 }, (_, i) => `原文第 ${i + 1} 行`);
const draft = [...body];
draft.splice(5500, 0, '末尾添加'); draft[3000] = '中间更正'; draft.splice(3, 0, '欢迎 Star', '更新动力');
const result = createDiffHunks(body.join('\n'), draft.join('\n'));
assert.equal(result.length, 3);
assert.equal(changes(body.join('\n'), draft.join('\n')).length, 5);
for (const h of result) for (const l of h.lines) {
  if (l.oldLineNumber) assert.equal(body[l.oldLineNumber - 1], l.content);
  if (l.newLineNumber) assert.equal(draft[l.newLineNumber - 1], l.content);
}
const repeated = Array(6000).fill('重复正文');
const edited = [...repeated]; edited[10] = '首处'; edited[5500] = '后处';
assert.equal(changes(repeated.join('\n'), edited.join('\n')).length, 4);
assert.deepEqual(createDiffHunks('a\r\nb', 'a\nb'), []);
assert.deepEqual(changes('', 'a\nb').map(l => l.type), ['insert', 'insert']);
assert.deepEqual(changes('a\nb', '').map(l => l.type), ['delete', 'delete']);
// 高编辑距离仍按共同唯一行对齐，不把所有原文涂成删除。
const many = body.map((line, i) => i % 5 === 0 ? `新内容 ${i}` : line);
assert.equal(changes(body.join('\n'), many.join('\n')).length, 2400);
// 有界小样本检查旧/新行重建，覆盖重复行、空行和插入删除组合。
let seed = 7;
const random = () => (seed = (seed * 48271) % 2147483647);
for (let n = 0; n < 100; n++) {
  const a = Array.from({length: 25}, () => String(random() % 5));
  const b = Array.from({length: 25}, () => String(random() % 5));
  const lines = createDiffHunks(a.join('\n'), b.join('\n'), 100).flatMap(h => h.lines);
  if (lines.length) {
    assert.deepEqual(lines.filter(l => l.type !== 'insert').map(l => l.content), a);
    assert.deepEqual(lines.filter(l => l.type !== 'delete').map(l => l.content), b);
  }
}
console.log('file line diff tests passed');
