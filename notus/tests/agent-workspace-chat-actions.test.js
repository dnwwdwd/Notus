const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

async function runTests() {
  const workspaceSource = read('components/AgentWorkspace/AgentWorkspace.js');
  const conversationsSource = read('utils/conversations.js');
  const conversations = await import('../utils/conversations.js');

  [
    'const [showJumpToBottom, setShowJumpToBottom] = useState(false);',
    'aria-label="滚动到最新消息"',
    'scrollContainerToBottom(container, \'smooth\')',
    '<Icons.chevronDown size={14} />',
    'function UserMessageRow({ message, disabled, removing = false, onResendMessage, onOpenAttachment, onPreviewMention, onPreviewImages })',
    'function AssistantMessageRow({ message, disabled, removing = false, onRetryMessage, previousUserMessage',
    'aria-label="AI 回复操作"',
    'aria-label="用户消息操作"',
    '已复制用户消息',
    '改写',
    "event.key === 'Enter' && !event.shiftKey",
    "event.key === 'Escape'",
    "sending ? '发送中...' : '发送'",
    'label="重试"',
    'label="复制"',
    'CopyMessageButton',
    'handleResendMessage',
    'const [removingMessageIds, setRemovingMessageIds] = useState(() => new Set());',
    'const [hiddenMessageIds, setHiddenMessageIds] = useState(() => new Set());',
    'await fetch(`/api/conversations/${conversationId}/truncate`',
    'if (futureIds.length > 0) await wait(220);',
    'skipUserMessageAppend: options.reason === \'rewrite\'',
    'attachments: Array.isArray(sourceMessage?.attachments) ? sourceMessage.attachments : []',
  ].forEach((snippet) => {
    assert.ok(
      workspaceSource.includes(snippet),
      `AgentWorkspace.js should include ${snippet}`
    );
  });

  const assistantContentIndex = workspaceSource.indexOf('{message.content ? <StreamingText className="notus-agent-markdown"');
  const assistantActionsIndex = workspaceSource.indexOf('aria-label="AI 回复操作"');
  assert.ok(
    assistantContentIndex > -1 && assistantActionsIndex > assistantContentIndex,
    'AI reply actions should render below the assistant message content, not on the user bubble or assistant header'
  );

  assert.ok(
    !workspaceSource.includes('重试生成回答'),
    'Assistant retry tooltip should be short: 重试'
  );
  assert.ok(
    !workspaceSource.includes('<span>最新消息</span>'),
    'jump-to-bottom button should be icon-only'
  );
  assert.ok(
    !workspaceSource.includes('发送编辑后的消息'),
    'rewrite submit button should use the short label: 发送'
  );
  assert.ok(
    !workspaceSource.includes('boxShadow: `inset 0 0 0 1px'),
    'message copy/rewrite/retry icon buttons should not render an outer border'
  );
  assert.ok(
    !workspaceSource.includes('<ToolChain steps={message.toolSteps || []} />'),
    'completed assistant messages should not expose tool-chain details'
  );

  assert.ok(
    conversationsSource.includes('const parsedAttachmentMap = rows.reduce'),
    'utils/conversations.js should associate parsed attachment content with visible message attachments'
  );

  const mapped = conversations.mapConversationMessages([
    {
      id: 1,
      role: 'user',
      content: '请根据附件总结一下',
      meta: {
        attachments: [{ name: 'brief.pdf', size: 1024, type: 'application/pdf' }],
      },
    },
  ], 'canvas');

  assert.deepStrictEqual(
    mapped[0].attachments,
    [{ name: 'brief.pdf', size: 1024, type: 'application/pdf', media_kind: 'attachment', upload_order: 0 }],
    'mapConversationMessages should keep attachments so edit/retry can reuse them'
  );

  const mappedWithParsedAttachment = conversations.mapConversationMessages([
    {
      id: 9,
      conversation_id: 3,
      role: 'system',
      type: 'parsed_attachment',
      content: '附件正文',
      meta: {
        source: 'brief.md',
        contentType: 'markdown',
        status: 'success',
      },
    },
    {
      id: 10,
      conversation_id: 3,
      role: 'user',
      content: '请总结附件',
      meta: {
        attachments: [{ name: 'brief.md', size: 12, type: 'text/markdown' }],
      },
    },
  ], 'canvas');

  assert.strictEqual(mappedWithParsedAttachment[0].conversationId, 3);
  assert.strictEqual(mappedWithParsedAttachment[0].attachments[0].parsed.text, '附件正文');
  assert.strictEqual(mappedWithParsedAttachment[0].attachments[0].parsed.contentType, 'markdown');

  assert.ok(workspaceSource.includes('function AttachmentContentDialog'));
  assert.ok(workspaceSource.includes("fetch('/api/agent/attachments/content'"));
  assert.ok(workspaceSource.includes('PDF 不支持复制'));
  assert.ok(workspaceSource.includes("`查看附件内容：${file.name || '未命名附件'}`"));

  console.log('agent workspace chat actions tests passed');
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
