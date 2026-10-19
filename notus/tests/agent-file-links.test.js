const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runTests() {
  const {
    buildAgentFileLinkCandidates,
    linkifyAgentFileText,
    parseInternalFileLink,
    remarkLinkifyAgentFileReferences,
  } = await import('../utils/agentFileLinks.js');
  const files = [
    { id: 11, path: '项目/计划.md', name: '计划.md', title: '项目计划' },
    { id: 12, path: '资料/会议纪要.md', name: '会议纪要.md' },
    { id: 13, path: '归档/会议纪要.md', name: '会议纪要.md' },
  ];

  assert.deepStrictEqual(buildAgentFileLinkCandidates(files).map((item) => item.value), ['归档/会议纪要.md', '资料/会议纪要.md', '项目/计划.md', '计划.md']);
  assert.deepStrictEqual(linkifyAgentFileText('请查看项目/计划.md，然后再继续。', files), [
    { type: 'text', value: '请查看' },
    { type: 'link', url: 'notus://file/11', children: [{ type: 'text', value: '项目/计划.md' }] },
    { type: 'text', value: '，然后再继续。' },
  ]);
  assert.deepStrictEqual(linkifyAgentFileText('计划.md 已更新。', files), [
    { type: 'link', url: 'notus://file/11', children: [{ type: 'text', value: '计划.md' }] },
    { type: 'text', value: ' 已更新。' },
  ]);
  assert.deepStrictEqual(linkifyAgentFileText('会议纪要.md 需要补充。', files), [{ type: 'text', value: '会议纪要.md 需要补充。' }]);
  assert.strictEqual(parseInternalFileLink('notus://file/12'), 12);
  assert.strictEqual(parseInternalFileLink('notus://file/0'), null);
  const oj = { id: 44, path: '架构/OJ在线评测系统架构设计.md', name: 'OJ在线评测系统架构设计.md', title: '在线评测系统总体架构方案' };
  const { resolveAgentFileLinkFromState, normalizeFinalAgentFileLinks } = require('../lib/agentFileLinkResolver');
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, oj], fileId: 5700, label: 'OJ在线评测系统架构设计', pathHint: oj.path }), null,
    '文件名、标题和路径不得作为内部链接的文件身份');
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, oj], fileId: 44, label: '其他文件', pathHint: '不存在.md' })?.id, 44,
    '有效 ID 不得被显示文字或路径覆盖');
  assert.strictEqual(normalizeFinalAgentFileLinks('[OJ在线评测系统架构设计](notus://file/5700)', 1, {
    files: [...files, oj], operationSets: [],
  }), 'OJ在线评测系统架构设计', '仅凭链接文字不得把失效 ID 指向同名文件');
  const created = { id: 41, path: '新笔记/正文.md', name: '正文.md', title: '正文' };
  const createdSet = { status: 'applied', patches: [{ change_type: 'create', status: 'auto_applied', file_id: 41, file_path: created.path }] };
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, created], operationSets: [createdSet], fileId: 999, label: '查看文件' })?.id, 41,
    '旧链接无效时仅凭同一任务已应用补丁记录的文件 ID 校正');
  const corrected = normalizeFinalAgentFileLinks('[查看文件](notus://file/999)', 1, {
    files: [...files, created], operationSets: [createdSet],
  });
  assert.strictEqual(corrected, '[查看文件](notus://file/41)');
  assert.strictEqual(normalizeFinalAgentFileLinks(corrected, 1, {
    files: [...files, created], operationSets: [createdSet],
  }), corrected, '历史链接校正应幂等');
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, created], operationSets: [createdSet], fileId: 11, label: '查看文件' })?.id, 11,
    '仍有效的其他文件 ID 不被本任务的新建文件覆盖');
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, created], operationSets: [{ ...createdSet, patches: [{ ...createdSet.patches[0], file_id: 17 }] }], fileId: 999 }), null,
    'Diff 记录的 ID 不存在时不能按路径猜测');
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, created], operationSets: [{ ...createdSet, status: 'cancelled' }], fileId: 999, label: '查看文件' })?.id, 41,
    '任务取消后已经应用的新建文件仍可打开');
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, created], operationSets: [{ ...createdSet, status: 'rolled_back' }], fileId: 999, label: '查看文件' }), null,
    '已回滚的操作集不能作为失效链接的恢复依据');
  const anotherCreate = { status: 'applied', patches: [{ change_type: 'create', status: 'applied', file_id: 42, file_path: '新笔记/附录.md' }] };
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, created, { id: 42, path: '新笔记/附录.md' }], operationSets: [createdSet, anotherCreate], fileId: 999, label: '查看文件' }), null,
    '同一任务创建多个文件且链接文字不明确时不得猜测');
  assert.strictEqual(resolveAgentFileLinkFromState({ files: [...files, created], operationSets: [{ status: 'applied', patches: [{ status: 'applied', file_id: 41, file_path: created.path }] }], fileId: 999 }), null,
    '只修改已有文件时不得把失效链接猜成该文件');

  const tree = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'text', value: '项目/计划.md' }] },
      { type: 'paragraph', children: [{ type: 'inlineCode', value: '项目/计划.md' }] },
      { type: 'paragraph', children: [{ type: 'link', url: 'https://example.com', children: [{ type: 'text', value: '项目/计划.md' }] }] },
    ],
  };
  remarkLinkifyAgentFileReferences({ files })(tree);
  assert.strictEqual(tree.children[0].children[0].url, 'notus://file/11');
  assert.strictEqual(tree.children[1].children[0].type, 'inlineCode');
  assert.strictEqual(tree.children[2].children[0].url, 'https://example.com');

  const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const streamingText = read('components/ui/StreamingText.js');
  const workspace = read('components/AgentWorkspace/AgentWorkspace.js');
  const fileWorkspace = read('components/AgentWorkspace/FileAgentWorkspace.js');
  const filesPage = read('pages/files/index.js');
  const tools = read('lib/agentTools.js');
  const prompt = read('lib/agentLoopPrompt.js');
  assert.ok(streamingText.includes('remarkLinkifyAgentFileReferences'), 'AI 回复必须在 Markdown AST 中识别本地文件引用');
  assert.ok(streamingText.includes('urlTransform={(url) => parseInternalFileLink(url)'), '显式内部链接必须保留受控 notus 协议');
  assert.ok(workspace.includes('canOpenCitation'), '来源卡片只有携带有效本地文件 ID 才可点击');
  assert.ok(fileWorkspace.includes('onCitationClick={(citation) =>'), '文件工作区来源卡片必须转交统一文件打开入口');
  assert.ok(filesPage.includes('onOpenFileLink={handleOpenEditorLink}'), 'AI 文件链接必须复用富文本标签打开函数');
  assert.ok(tools.includes('file_id: file.id,'), 'read_file 必须向模型提供稳定文件 ID');
  assert.ok(prompt.includes('notus://file/<file_id>') && prompt.includes('file_refs'), 'Agent 提示词必须要求已定位文件按安全回执输出内部链接');

  console.log('agent file link tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
