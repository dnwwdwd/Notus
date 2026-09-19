const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require.resolve('../components/ChatArea/ClarifyDrawer.js'), 'utf8');
const match = source.match(/function hasExplicitResourceChoices\(questions, answers\) \{[\s\S]*?\n\}/);
assert.ok(match, '资源确认必须有独立的显式选择校验');
const validate = vm.runInNewContext(`(${match[0]})`);
const questions = [{ id: 'resource_decision', options: [{ id: 'confirm' }, { id: 'cancel' }] }];
for (const answer of [undefined, {}, { optionId: '' }, { optionId: 'custom', customText: '同意' }, { optionId: '__none_of_the_above__' }, { optionId: 'confirm', skipped: true }, { optionId: 'confirm', customText: '取消' }]) {
  assert.strictEqual(validate(questions, { resource_decision: answer }), false, JSON.stringify(answer));
}
for (const optionId of ['confirm', 'cancel']) assert.strictEqual(validate(questions, { resource_decision: { optionId } }), true);
assert.strictEqual(validate([], {}), false);
assert.ok(source.includes('if (!isPending || submitting || !canSubmitAnswers) return;'), '主按钮和快捷键必须共享校验');
assert.ok(source.includes('disabled={submitting || !canSubmitAnswers}'), '选择前禁用提交');
console.log('resource approval explicit choice tests passed');
