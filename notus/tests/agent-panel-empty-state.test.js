const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const fileAgentWorkspace = read('components/AgentWorkspace/FileAgentWorkspace.js');
const agentWorkspace = read('components/AgentWorkspace/AgentWorkspace.js');

assert.ok(!fileAgentWorkspace.includes('<span style={{ fontSize: \'var(--text-sm)\', fontWeight: 600 }}>Notus Agent</span>'));
assert.ok(!fileAgentWorkspace.includes('<Icons.sparkles size={15} style={{ color: \'var(--accent)\' }} />'));
assert.ok(agentWorkspace.includes('>你今天在想些什么？</div>'));
assert.ok(!agentWorkspace.includes('有什么我可以帮您的？'));
assert.ok(!agentWorkspace.includes('输入问题、创作指令，或附上文件让 Notus 帮你处理。'));

console.log('agent panel empty state tests passed');
