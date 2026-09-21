const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const page = fs.readFileSync(process.env.NOTUS_FILES_PAGE_TEST_SOURCE || path.join(__dirname, '../pages/files/index.js'), 'utf8');
const contextSource = fs.readFileSync(path.join(__dirname, '../contexts/AppContext.js'), 'utf8');
const between = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const closeCode = between(contextSource, contextSource.includes('  const closeFileTabs =') ? '  const closeFileTabs =' : '  const closeFileTab =', '  const setActiveWorkspacePage =');
const openCode = between(page, '  const openWorkspaceFile =', '  const requestOpenWorkspaceFile =');
const syncCode = page.includes('  const syncWorkspaceRoute =')
  ? between(page, '  const syncWorkspaceRoute =', '  const openWorkspaceFile =') : '';
const routeCode = between(page.slice(page.indexOf('  requestOpenFileRef.current = requestOpenWorkspaceFile;')), '  useEffect(() => {\n    if (!router.isReady', '  useEffect(() => {\n    router.beforePopState');
const missingCode = between(page, '    const closeMissingFile =', '    if (navigationGuard) {\n      navigationGuard(closeMissingFile)');
const handlerCode = between(page, '  const handleCloseTab =', '  const handleRenameTab =');

function harness(ids, active, dirty = false) {
  const allFiles = [1, 2, 3].map(id => ({ id, type: 'file', path: `${id}.md` }));
  const transitions = [];
  let pendingAction = null;
  let persisted;
  const state = {
    activeFileId: active, allFiles, filesRef: { current: allFiles },
    activeFileIdRef: { current: active }, openFileIdsRef: { current: [...ids] },
    pendingCitationRef: { current: null }, routeSyncFileIdRef: { current: null },
    useCallback: fn => fn, useEffect: fn => fn(), flattenTree: items => items,
    setOpenFileIds: () => {}, setActiveFile: () => {}, setPendingCitation: () => {},
    setActiveFileId: id => { state.activeFileId = id; },
    persistWorkspaceState: value => { persisted = value; },
    expandEditorForFile: () => {}, getQueryValue: value => value,
    navigationGuard: dirty ? action => { pendingAction = action; return false; } : undefined,
    selectFile: file => {
      state.activeFileId = file.id;
      state.activeFileIdRef.current = file.id;
      if (!state.openFileIdsRef.current.includes(file.id)) state.openFileIdsRef.current.push(file.id);
    },
  };
  state.router = {
    isReady: true, query: { fileId: String(active) }, asPath: `/files?fileId=${active}`,
    push(href) {
      return new Promise((resolve, reject) => transitions.push({ href, resolve, reject }));
    },
    replace(href) { return this.push(href); },
  };
  const scope = vm.createContext(state);
  vm.runInContext(`${closeCode}${syncCode}${openCode}${handlerCode}\nthis.close = handleCloseTab; this.open = openWorkspaceFile;`, scope);
  state.requestOpenWorkspaceFile = file => { state.open(file); return true; };
  return {
    state, transitions,
    effect: () => vm.runInContext(routeCode, scope),
    closeMissing: () => vm.runInContext(`{ ${missingCode} closeMissingFile(); }`, scope),
    close: id => state.close(allFiles.find(file => file.id === id)),
    tabs: () => [...state.openFileIdsRef.current],
    persisted: () => persisted,
    confirm: saved => { if (saved && pendingAction) { const action = pendingAction; pendingAction = null; action(); } },
    cancel: () => { pendingAction = null; },
    async settle(index = transitions.length - 1, fail = false) {
      const transition = transitions[index];
      if (fail) transition.reject(new Error('navigation cancelled'));
      else {
        state.router.asPath = transition.href;
        state.router.query = { fileId: transition.href.split('fileId=')[1] };
        transition.resolve(true);
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

(async () => {
  for (const [ids, active, closing, expected, next] of [
    [[1, 2, 3], 2, 2, [1, 3], 3], [[1, 2], 2, 2, [1], 1],
    [[1, 2], 2, 1, [2], 2], [[1], 1, 1, [], null],
  ]) {
    const h = harness(ids, active);
    h.effect();
    h.close(closing);
    h.effect(); // React effects run while the old URL is still visible.
    assert.deepStrictEqual(h.tabs(), expected, '旧路由不得重新打开已关闭标签');
    assert.strictEqual(h.state.activeFileId, next);
    assert.deepStrictEqual([...h.persisted().openFileIds], expected);
    if (h.transitions.length) await h.settle();
    h.effect();
    assert.deepStrictEqual(h.tabs(), expected);
    h.state.router.query = { fileId: String(closing) }; // explicit browser navigation
    h.state.router.asPath = `/files?fileId=${closing}`;
    h.effect();
    assert(h.tabs().includes(closing), '关闭后仍可通过路由主动重新打开');
  }
  const fast = harness([1, 2, 3], 1);
  fast.close(1);
  fast.close(2);
  await fast.settle(0);
  fast.effect();
  assert.deepStrictEqual(fast.tabs(), [3], '旧导航完成不得解除较新关闭操作的保护');
  await fast.settle(1);
  fast.effect();
  assert.deepStrictEqual(fast.tabs(), [3]);

  for (const outcome of ['cancel', 'save-failed', 'save', 'discard']) {
    const h = harness([1, 2], 1, true);
    h.close(1);
    h.effect();
    assert.deepStrictEqual(h.tabs(), [1, 2], '未确认不得关闭');
    if (outcome === 'cancel') h.cancel();
    else h.confirm(outcome !== 'save-failed');
    h.effect();
    assert.deepStrictEqual(h.tabs(), ['save', 'discard'].includes(outcome) ? [2] : [1, 2]);
  }
  const missing = harness([1, 2], 1);
  missing.closeMissing();
  missing.effect();
  assert.deepStrictEqual(missing.tabs(), [2], '外部删除关闭不能被旧地址恢复');
  await missing.settle();

  const failed = harness([1, 2], 1);
  failed.close(1);
  await failed.settle(0, true);
  assert.strictEqual(failed.state.routeSyncFileIdRef.current, null, '失败导航不得永久锁住路由同步');
  console.log('editor tab close routing tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
