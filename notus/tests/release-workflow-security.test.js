const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release-desktop.yml'), 'utf8');

assert.match(workflow, /^permissions:\n  contents: read$/m, '默认工作流权限必须只读');
assert.match(
  workflow,
  /^  release:\n(?:.|\n)*?^    permissions:\n      contents: write$/m,
  '只有最终发布 job 可以写入 Release'
);
assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v4(?:\s|$)/, 'Action 不能使用可变 v4 tag');

[
  'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
].forEach((reference) => {
  assert.ok(workflow.includes(reference), `缺少固定 Action 引用：${reference}`);
});

assert.strictEqual((workflow.match(/persist-credentials: false/g) || []).length, 2, 'verify 和 build 的 checkout 都不能保留凭据');
console.log('release workflow security tests passed');
