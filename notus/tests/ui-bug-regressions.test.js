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
  assert.ok(globalStyles.includes('.notus-resizable-layout'));
  assert.ok(globalStyles.includes('.notus-sidebar.is-mobile'));
  assert.ok(resizableLayout.includes('notus-resizable-layout__panel--left'));
  assert.ok(resizableLayout.includes('notus-resizable-layout__handle'));
  assert.ok(sidebar.includes('const isSidebarCollapsed = isMobileViewport ? !mobileSidebarOpen : sidebarCollapsed;'));
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
  assert.ok(settings.includes('CLOUD_IMAGE_STORAGE_OPTIONS.map'));
  assert.ok(settings.includes('请先在个性化页切换上传位置，再清除密钥'));
  assert.ok(!settings.includes("        设置\n      </div>"));
  assert.ok(settings.includes('height: 42'));
  assert.ok(!settings.includes('>上传位置</div>'));
  assert.ok(settings.includes('className="notus-settings-dialog"'));
  assert.ok(settings.includes('className="notus-settings-nav"'));

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
  assert.ok(agentWorkspace.includes("removed.push(`原路径：${operation.old_path || operation.old || ''}`);"));
  assert.ok(!agentWorkspace.includes('function AgentDiffCard'));

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
