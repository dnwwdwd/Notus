const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const workspaceSource = read('components/AgentWorkspace/FileAgentWorkspace.js');
const inputSource = read('components/AgentWorkspace/AgentWorkspace.js');

assert.ok(workspaceSource.includes('collectFolderMentions(fileTree)'), 'Mention should read folders from the file tree');
assert.ok(workspaceSource.includes('collectFolderMentionsFromFiles(allFiles)'), 'Mention should derive folders from file paths when the tree is stale or incomplete');
assert.ok(workspaceSource.includes('token: `@{folder:${path}}`'), 'Folder Mention should use the folder token format');
assert.ok(inputSource.includes('([^@\\n]*)'), 'Folder names containing spaces should remain searchable in a plain @ query');
assert.ok(inputSource.includes("left?.kind === 'folder' ? -1 : 1"), 'Folder matches should be prioritized before file matches');

console.log('folder mention tests passed');
