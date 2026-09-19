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
    { id: 11, path: '项目/计划.md', name: '计划.md' },
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
