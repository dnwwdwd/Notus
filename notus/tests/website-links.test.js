const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { URL };
vm.createContext(context);
vm.runInContext(fs.readFileSync(require.resolve('../utils/websiteLinks'), 'utf8').replaceAll('export ', ''), context);
for (const href of ['https://example.com', 'http://example.com/a.md', '//example.com', ' HTTPS://example.com ']) {
  assert.equal(context.isWebsiteLink(href), true);
  assert.equal(context.websiteLinkProps(href).target, '_blank');
  assert.equal(context.websiteLinkProps(href).rel, 'noopener noreferrer');
}
for (const href of ['notus://file/42', '/files?id=42', '/settings/model', '#section', 'notes/a.md', 'mailto:a@example.com', 'javascript:alert(1)', 'data:text/html,hi', 'https://', '']) {
  assert.equal(context.isWebsiteLink(href), false);
  assert.equal(context.websiteLinkProps(href).target, undefined);
}
// Execute the editor's actual capture handler: internal references take priority.
const source = fs.readFileSync(require.resolve('../components/Editor/WysiwygEditor'), 'utf8');
const start = source.indexOf('onClickCapture={(event) => {') + 'onClickCapture={(event) => {'.length;
const end = source.indexOf("          const clickedImage =", start);
context.Element = class Element {};
context.parseInternalFileLink = (href) => href === 'notus://file/42' ? 42 : null;
let openedFile, openedWindow, prevented;
context.onOpenFileLink = (id) => { openedFile = id; };
context.window = { open: (...args) => { openedWindow = args; } };
vm.runInContext(`function click(event) {${source.slice(start, end)}}`, context);
for (const href of ['notus://file/42', 'https://example.com', '#section']) {
  openedFile = openedWindow = undefined;
  prevented = false;
  const target = new context.Element();
  target.closest = () => ({ getAttribute: () => href, href });
  context.click({ target, preventDefault: () => { prevented = true; } });
  if (href.startsWith('notus:')) { assert.equal(openedFile, 42); assert.equal(openedWindow, undefined); }
  else if (href.startsWith('https:')) { assert.deepEqual(openedWindow, [href, '_blank', 'noopener,noreferrer']); assert.equal(openedFile, undefined); }
  else { assert.equal(prevented, false); assert.equal(openedWindow, undefined); }
}
console.log('website links and editor click behavior tests passed');
