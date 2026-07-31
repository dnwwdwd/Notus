const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function runTests() {
  const findBar = read('components/ui/DocumentFindBar.js');
  assert.ok(!findBar.includes('搜索当前文档内容，回车或按钮切换匹配项'));
  assert.ok(!findBar.includes('输入关键词'));

  const unsavedDialog = read('components/ui/UnsavedChangesDialog.js');
  assert.ok(!unsavedDialog.includes('>取消</Button>'));
  assert.ok(unsavedDialog.includes('不保存离开'));
  assert.ok(unsavedDialog.includes('保存并继续'));

  const canvasBlock = read('components/Canvas/CanvasBlock.js');
  assert.ok(!canvasBlock.includes('onBlur={saveEdit}'));
  assert.ok(canvasBlock.includes('取消编辑'));
  assert.ok(canvasBlock.includes('完成'));

  const sidebar = read('components/Layout/Sidebar.js');
  const shell = read('components/Layout/Shell.js');
  const resizableLayout = read('components/ui/ResizableLayout.js');
  const globalStyles = read('styles/globals.css');
  const desktopMain = fs.readFileSync(path.resolve(root, '..', 'desktop/main/index.js'), 'utf8');
  assert.ok(!shell.includes('minWidth: 1360'));
  assert.ok(!globalStyles.includes('min-width: 1360px'));
  assert.ok(globalStyles.includes('@media (max-width: 900px)'));
  assert.ok(globalStyles.includes('@media (max-width: 960px)'));
  assert.ok(!globalStyles.includes('.notus-resizable-layout {\n    flex-direction: column;'));
  assert.ok(globalStyles.includes('.notus-resizable-layout'));
  assert.ok(globalStyles.includes('.notus-sidebar.is-mobile'));
  assert.ok(resizableLayout.includes('notus-resizable-layout__panel--left'));
  assert.ok(resizableLayout.includes('notus-resizable-layout__handle'));
  assert.ok(resizableLayout.includes('collapseLeft = false'));
  assert.ok(resizableLayout.includes("is-left-collapsed"));
  assert.ok(resizableLayout.includes("className = ''"));
  assert.ok(sidebar.includes("window.matchMedia('(max-width: 960px)')"));
  assert.ok(sidebar.includes('const isSidebarCollapsed = autoCollapsed || (isMobileViewport ? !mobileSidebarOpen : sidebarCollapsed);'));
  assert.ok(sidebar.includes('const [autoCollapsed, setAutoCollapsed] = useState(false);'));
  assert.ok(sidebar.includes('setMobileSidebarOpen((current) => !current);'));
  assert.ok(desktopMain.includes('minWidth: 390'));
  assert.ok(desktopMain.includes('minHeight: 640'));
  assert.ok(!sidebar.includes('activeTocKey'));
  assert.ok(sidebar.includes('const selected = Boolean(t.active);'));
  assert.ok(sidebar.includes('var(--accent-subtle)'));
  assert.ok(sidebar.includes("body: JSON.stringify({ action: 'apply', patch })"));
  assert.ok(!sidebar.includes("body: JSON.stringify({ action: 'preview', patches })"));
  assert.ok(sidebar.includes("label: '移动目录'"));
  assert.ok(sidebar.includes("change_type: moveNode.type === 'folder' ? 'move_folder' : 'move_file'"));
  assert.ok(sidebar.includes('isSameOrChildPath(option.value, moveNode.path)'));
  assert.ok(!sidebar.includes("renameNode?.type === 'folder' ? '生成预览' : '确认'"));

  const dropdownSelect = read('components/ui/DropdownSelect.js');
  assert.ok(dropdownSelect.includes('menuZIndex = 2100'));
  assert.ok(dropdownSelect.includes('zIndex: menuZIndex'));

  const tooltip = read('components/ui/Tooltip.js');
  assert.ok(tooltip.includes("maxWidth: 'calc(100vw - 24px)'"));
  assert.ok(tooltip.includes("whiteSpace: 'nowrap'"));
  assert.ok(tooltip.includes("textOverflow: 'ellipsis'"));

  const segmentedTabs = read('components/ui/SegmentedTabs.js');
  assert.ok(segmentedTabs.includes('export function SegmentedTabs'));

  const settings = read('components/Settings/SettingsScreen.js');
  assert.ok(settings.includes('closeOnBackdrop={false}'));
  assert.ok(settings.includes('showHeader'));
  assert.ok(!settings.includes('title="设置"'));
  assert.ok(settings.includes('const SettingsPageHeader'));
  assert.ok(settings.includes('const SettingsPageHeader = ({ title, icon })'));
  assert.ok(!settings.includes('SettingsPageHeader = ({ title, icon, description })'));
  assert.ok(settings.includes('const SETTINGS_CONTENT_MAX_WIDTH = 860'));
  assert.ok(settings.includes('const SETTINGS_SURFACE_STYLE'));
  assert.ok(settings.includes('<section style={{ ...SETTINGS_SURFACE_STYLE, display: \'grid\', gap: 24 }}>'));
  assert.ok(!settings.includes("maxWidth: 672"));
  assert.ok((settings.match(/<SettingsPageHeader/g) || []).length >= 8);
  assert.ok(settings.includes('图片上传位置'));
  assert.ok(settings.includes('前往图床设置'));
  assert.ok(settings.includes('options={IMAGE_STORAGE_OPTIONS}'));
  assert.ok(!settings.includes('IMAGE_STORAGE_OPTIONS.map((item) => ({ ...item, icon:'));
  assert.ok(settings.includes('const [selectedProvider, setSelectedProvider] = useState(CLOUD_IMAGE_STORAGE_OPTIONS[0].value);'));
  assert.ok(settings.includes('initializeSelectedProvider: true'));
  assert.ok(settings.includes("background: '#F9F9F8'"));
  assert.ok(settings.includes('value: \'oss\', label: \'阿里云 OSS\''));
  assert.ok(!settings.includes('ariaLabel="图床服务商"'));
  assert.ok(settings.includes('请先在个性化页切换上传位置，再清除密钥'));
  assert.ok(!settings.includes("        设置\n      </div>"));
  assert.ok(settings.includes('height: 42'));
  assert.ok(!settings.includes('>上传位置</div>'));
  assert.ok(settings.includes('className="notus-settings-dialog"'));
  assert.ok(settings.includes('className="notus-settings-nav"'));
  assert.ok(settings.includes('导入 ZIP'));
  assert.ok(settings.includes("fetch('/api/skills/install/zip', { method: 'POST', body: form })"));
  assert.ok(settings.includes('type="file" accept=".zip,application/zip,application/x-zip-compressed"'));
  assert.ok(settings.includes('拖入 ZIP 文件或点击上传'));
  assert.ok(settings.includes('最大 100 MiB'));
  assert.ok(!settings.includes('尚未选择 ZIP 文件'));
  assert.ok(!settings.includes('>选择 ZIP 文件</Button>'));
  assert.ok(!settings.includes('导入前会校验压缩包路径'));
  assert.ok(settings.includes('ZIP 文件不能超过 100 MiB'));
  assert.ok(!settings.includes("<Badge tone={skill.status === 'valid' ? 'success' : 'warning'}>"));
  assert.ok(!settings.includes("{skill.source_label || '本机'} · {skill.managed ? 'Notus 管理' : '外部目录'}"));
  assert.ok(settings.includes('notifySkillsChanged();'));

  const settingsApi = read('pages/api/settings/index.js');
  assert.ok(settingsApi.includes('provider_configs: providerConfigs'));
  assert.ok(settingsApi.includes('body.images.active_provider'));
  assert.ok(settingsApi.includes('body.images.provider_config'));
  assert.ok(settingsApi.includes('materializeLegacyImageStorageProfile'));

  const conversationDrawer = read('components/ChatArea/ConversationDrawer.js');
  assert.ok(conversationDrawer.includes('ConfirmDialog'));
  assert.ok(conversationDrawer.includes('Icons.trash'));
  assert.ok(conversationDrawer.includes('onDelete?.(pendingDelete.id, pendingDelete)'));

  const agentWorkspace = read('components/AgentWorkspace/AgentWorkspace.js');
  assert.ok(agentWorkspace.includes('<SegmentedTabs'));
  assert.ok(agentWorkspace.includes('function OperationSetCard'));
  assert.ok(agentWorkspace.includes('function DiffDialog'));
  assert.ok(agentWorkspace.includes("attachmentMode === 'parsed'"));
  assert.ok(agentWorkspace.includes('pasted-text-'));
  assert.ok(agentWorkspace.includes('const LONG_PASTE_ATTACHMENT_THRESHOLD = 100;'));
  assert.ok(agentWorkspace.includes('const MAX_PARSED_ATTACHMENTS = 10;'));
  assert.ok(agentWorkspace.includes('const MAX_IMAGES_PER_MESSAGE = 30;'));
  assert.ok(agentWorkspace.includes("aria-label=\"添加图片\""));
  assert.ok(agentWorkspace.includes('没有匹配的文件'));
  assert.ok(agentWorkspace.includes('mentionOptions = []'));
  assert.ok(agentWorkspace.includes('const activeMention = useMemo'));
  assert.ok(agentWorkspace.includes('function AgentWorkspace({'));
  assert.ok(agentWorkspace.includes('mentionOptions={mentionOptions}'));
  assert.ok(agentWorkspace.includes('function isFileSystemOperation(operation = {})'));
  assert.ok(agentWorkspace.includes('const activePath = activeOperation.new_path || activeOperation.file_path || activeOperation.old_path || activeOperation.path || \'全文\''));
  assert.ok(agentWorkspace.includes('function DiffFileLink'));
  assert.ok(agentWorkspace.includes('function diffSidebarFileName(path)'));
  assert.ok(agentWorkspace.includes('<DiffFileLink path={pathText} onOpenFile={openDiffFile}'));
  assert.ok(!agentWorkspace.includes('本次任务的文件已全部处理'));
  assert.ok(agentWorkspace.includes("const AGENT_CHAT_CONTENT_WIDTH = '95%'"));
  assert.ok(agentWorkspace.includes('width: AGENT_CHAT_CONTENT_WIDTH'));
  assert.ok(agentWorkspace.includes('onOpenFile={onOpenDiffFile}'));
  assert.ok(agentWorkspace.includes("removed.push(`原路径：${operation.old_path || operation.old || ''}`);"));
  assert.ok(!agentWorkspace.includes('function AgentDiffCard'));

  const mentionPreview = read('components/AgentWorkspace/MentionPreviewDialog.js');
  assert.ok(mentionPreview.includes('function visibleMentionMarkdown(content = \'\')'));
  assert.ok(mentionPreview.includes("dialogStyle={{ maxHeight: 'calc(100dvh - 32px)'"));
  assert.ok(mentionPreview.includes('setContent(visibleMentionMarkdown(payload.content));'));

  const fileAgentWorkspace = read('components/AgentWorkspace/FileAgentWorkspace.js');
  assert.ok(fileAgentWorkspace.includes("window.addEventListener('notus-skills-changed', refreshSkills);"));
  assert.ok(fileAgentWorkspace.includes("window.removeEventListener('notus-skills-changed', refreshSkills);"));
  assert.ok(fileAgentWorkspace.includes("const title = String(file?.title || '').trim();"));
  assert.ok(fileAgentWorkspace.includes("const fileName = String(file?.name || path.split('/').pop() || '').trim();"));
  assert.ok(fileAgentWorkspace.includes("const name = fileName || title || '未命名文件';"));
  assert.ok(fileAgentWorkspace.includes("searchText: [fileName, title, path].filter(Boolean).join(' '),"));

  const filesPage = read('pages/files/index.js');
  assert.ok(filesPage.includes('body: JSON.stringify({ content: contentToSave, title: nextTitle })'));
  assert.ok(fileAgentWorkspace.includes('function collectFileMentions(nodes = [])'));
  assert.ok(fileAgentWorkspace.includes('...collectFileMentions(fileTree),'));

  assert.ok(filesPage.includes("const FILES_EDITOR_AUTO_COLLAPSE_QUERY = '(max-width: 640px)'"));
  assert.ok(filesPage.includes('const FILES_AGENT_FIXED_WIDTH = 456;'));
  assert.ok(filesPage.includes('const renderedWorkspacePanels = {'));
  assert.ok(filesPage.includes('const renderedEditorAutoCollapsed = editorAutoCollapsed'));
  assert.ok(filesPage.includes("toast('该文档已删除或不存在', 'info')"));
  assert.ok(filesPage.includes("toast('该文档已打开', 'info')"));
  assert.ok(filesPage.includes('onOpenDiffFile={handleOpenDiffFile}'));
  assert.ok(filesPage.includes('function findFileInTree(nodes = [], path = \'\')'));
  assert.ok(filesPage.includes('findFileInTree(await refreshFiles({ background: true }), normalizedPath)'));

  const topBar = read('components/Layout/TopBar.js');
  assert.ok(!topBar.includes('displayShortcut('));
  assert.ok(!topBar.includes('点击保存（'));

  const clarifyDrawer = read('components/ChatArea/ClarifyDrawer.js');
  assert.ok(clarifyDrawer.includes('const selectOptionAndAdvance'));
  assert.ok(clarifyDrawer.includes("setPhase('expanded-review')"));
  assert.ok(clarifyDrawer.includes('<ReviewRow'));

  const agentPrompt = read('lib/agentLoopPrompt.js');
  assert.ok(agentPrompt.includes('文件系统任务要和内容任务分开处理'));
  assert.ok(agentPrompt.includes('不要用 search_knowledge 判断目录是否存在'));
  assert.ok(agentPrompt.includes('用户说“工作目录”时，不要把“AI工作流”等包含相近词的目录当作目标'));
  assert.ok(agentPrompt.includes('@{folder:相对目录}'));
  assert.ok(agentPrompt.includes('scope_paths: [该目录路径]'));

  const agentTools = read('lib/agentTools.js');
  assert.ok(agentTools.includes('不要用它判断目录是否存在、目标目录位置或空目录'));
  assert.ok(agentTools.includes('返回子目录、Markdown 文件路径、标题和可选内容预览'));
  assert.ok(agentTools.includes('folders_truncated'));

  const llmConfigSection = read('components/Settings/LlmConfigCardsSection.js');
  assert.ok(llmConfigSection.includes("placeholder={draft.apiProtocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}"));
  assert.ok(llmConfigSection.includes("badge={draft.apiKeySet ? '已保存' : ''}"));
  assert.ok(llmConfigSection.includes("placeholder={draft.apiKeySet ? '已保存，留空不修改' : 'sk-••••••••••••'}"));
  assert.ok(!llmConfigSection.includes("value={selectedProvider}"));

  const canvasPage = read('pages/canvas.js');
  assert.ok(canvasPage.includes("destination: '/files'"));
  assert.ok(!canvasPage.includes('attachmentMode="parsed"'));

  const knowledgePage = read('pages/knowledge.js');
  assert.ok(knowledgePage.includes("destination: '/files'"));
  assert.ok(!knowledgePage.includes('attachmentMode="parsed"'));

  console.log('ui bug regressions tests passed');
}

runTests();
