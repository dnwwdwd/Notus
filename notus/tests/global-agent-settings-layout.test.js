const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'components/Settings/SettingsScreen.js'), 'utf8');
assert.ok(source.includes('ariaLabel="全局 Agent 文件"') && !source.includes("width: 'min(100%, 540px)'"), '全局 Agent Tab 应按内容收紧，窄屏时由公共组件自行滚动');
assert.ok(!source.includes("style={{ display: 'flex', width: '100%', overflowX: 'auto' }}"), '设置页服务商 Tab 不得强制占满内容列');
assert.ok(source.includes('notus-global-agent-editor') && source.includes('minHeight: 390'), '应使用独立的 Markdown 编辑表面');
assert.ok(source.includes('content === savedContent') && source.includes('>保存修改</Button>'), '未修改时应禁用取消和保存');
assert.ok(!source.includes('三份 Markdown 文件会在后续 Agent 请求中生效。'), '必须移除全局 Agent 页顶部说明文字');
assert.ok(!source.includes("description: '长期影响 Agent") && !source.includes("activeOption.description"), 'Tab 和编辑器不应重复显示说明文字');
console.log('global agent settings layout tests passed');
