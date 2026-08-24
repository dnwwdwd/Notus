const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const settings = fs.readFileSync(path.join(root, 'components/Settings/SettingsScreen.js'), 'utf8');
const fileWorkspace = fs.readFileSync(path.join(root, 'components/AgentWorkspace/FileAgentWorkspace.js'), 'utf8');

assert.ok(settings.includes('function SkillListSkeleton'), 'Skill 初次加载必须显示资源行骨架');
assert.ok(settings.includes('{loading ? <SkillListSkeleton /> : skills.map'), 'Skill 骨架必须仅在首次请求期间替代资源列表');
assert.ok(!fileWorkspace.includes('setConversationListLoading(true);\n      fetchConversationList(historySearchQuery)'), '已有对话列表搜索不能触发全屏 loading');
assert.ok(!fileWorkspace.includes('setConversationListLoading(true);\n    fetchConversationList()'), '首次读取以外的对话列表刷新不能触发 loading');

console.log('list loading feedback tests passed');
