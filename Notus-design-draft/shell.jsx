// shell.jsx — TopBar + Sidebar shared across pages

const TopBar = ({ active = 'files', showIndex = false, fileName, saveState = 'saved', showCmdK = true }) => {
  const tabs = [
    { id: 'files', label: '文件' },
    { id: 'knowledge', label: '知识库' },
    { id: 'canvas', label: '创作' },
  ];
  return (
    <div style={{ position: 'relative', height: 48, background: 'var(--bg-elevated)',
      borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center',
      padding: '0 16px', gap: 24, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 180 }}>
        <NotusLogo size={22}/>
        <span style={{ fontSize: 'var(--text-base)', fontWeight: 600, letterSpacing: -0.2 }}>Notus</span>
      </div>
      <div style={{ display: 'flex', gap: 4, flex: 1 }}>
        {tabs.map(t => {
          const on = t.id === active;
          return (
            <div key={t.id} style={{
              position: 'relative', padding: '0 14px', height: 48, display: 'flex', alignItems: 'center',
              fontSize: 'var(--text-sm)', fontWeight: on ? 500 : 400,
              color: on ? 'var(--accent)' : 'var(--text-secondary)',
            }}>
              {t.label}
              {on && <div style={{ position: 'absolute', left: 14, right: 14, bottom: 0, height: 2, background: 'var(--accent)' }}/>}
            </div>
          );
        })}
      </div>
      {fileName && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
          <span>{fileName}</span>
          {saveState === 'dirty' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--warning)' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)' }}/>
              未保存
            </span>
          )}
          {saveState === 'saving' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%',
                border: '1.5px solid var(--border-primary)', borderTopColor: 'var(--accent)',
                display: 'inline-block', animation: 'spin 0.8s linear infinite' }}/>
              保存中
            </span>
          )}
          {saveState === 'saved' && <span style={{ color: 'var(--success)' }}>✓ 已保存</span>}
        </div>
      )}
      {showCmdK && (
        <button style={{
          height: 28, padding: '0 10px 0 10px', display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)', color: 'var(--text-tertiary)', fontSize: 12,
        }}>
          <I.search size={13}/>
          <span>搜索或跳转…</span>
          <span style={{ fontSize: 10, background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)', padding: '1px 5px',
            borderRadius: 3, color: 'var(--text-secondary)' }}>⌘K</span>
        </button>
      )}
      <button style={{ width: 32, height: 32, borderRadius: 'var(--radius-sm)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
        <I.settings/>
      </button>
      {showIndex && (
        <div style={{ position: 'absolute', left: 0, bottom: -1, height: 2, width: '42%',
          background: 'var(--accent)' }}/>
      )}
    </div>
  );
};

// Sample file tree
const SAMPLE_TREE = [
  { type: 'folder', name: '技术文章', open: true, depth: 0, children: [
    { type: 'folder', name: '缓存系列', open: true, depth: 1 },
    { type: 'file', name: '性能优化实践.md', depth: 2, active: true },
    { type: 'file', name: 'Redis 深入.md', depth: 2 },
    { type: 'file', name: 'CDN 边缘计算.md', depth: 2, status: 'indexing' },
    { type: 'folder', name: '分布式系统', open: false, depth: 1 },
    { type: 'folder', name: '前端工程化', open: false, depth: 1 },
  ]},
  { type: 'folder', name: '随笔', open: true, depth: 0, children: [
    { type: 'file', name: '关于慢的意义.md', depth: 1 },
    { type: 'file', name: '周末煮茶.md', depth: 1 },
    { type: 'file', name: '搬家第三周.md', depth: 1, status: 'error' },
  ]},
  { type: 'folder', name: '读书笔记', open: true, depth: 0, children: [
    { type: 'file', name: '《项目管理的艺术》.md', depth: 1 },
    { type: 'file', name: '《思考快与慢》摘录.md', depth: 1 },
    { type: 'file', name: '《设计心理学》.md', depth: 1 },
  ]},
  { type: 'folder', name: '灵感收集', open: false, depth: 0 },
  { type: 'file', name: 'README.md', depth: 0 },
];

const FileRow = ({ item }) => {
  const pad = 8 + item.depth * 16;
  const isFolder = item.type === 'folder';
  const active = item.active;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      height: 30, padding: `0 8px 0 ${pad}px`,
      borderRadius: 'var(--radius-sm)', margin: '0 6px',
      background: active ? 'var(--accent-subtle)' : 'transparent',
      color: active ? 'var(--accent)' : 'var(--text-primary)',
      fontSize: 'var(--text-sm)', fontWeight: active ? 500 : 400,
      position: 'relative',
    }}>
      {isFolder ? (
        <>
          {item.open ? <I.chevronDown size={12}/> : <I.chevronRight size={12}/>}
          {item.open ? <I.folderOpen size={14}/> : <I.folder size={14}/>}
        </>
      ) : (
        <>
          <span style={{ width: 12 }}/>
          <I.file size={14}/>
        </>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
      {item.status === 'indexing' && <span style={{ color: 'var(--warning)', fontSize: 10 }}>⏳</span>}
      {item.status === 'error' && <span style={{ color: 'var(--danger)', fontSize: 10 }}>⚠</span>}
    </div>
  );
};

const flatTree = (nodes) => {
  const out = [];
  const walk = (list) => list.forEach(n => {
    out.push(n);
    if (n.open && n.children) walk(n.children);
  });
  walk(nodes);
  return out;
};

const Sidebar = ({ tab = 'tree', tocDisabled = true, searchVisible = false, empty = false, tocItems, width = 240 }) => {
  return (
    <div style={{ width, background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column',
      flexShrink: 0, height: '100%' }}>
      {/* Tab bar */}
      <div style={{ height: 40, display: 'flex', alignItems: 'center', padding: '0 6px',
        borderBottom: '1px solid var(--border-subtle)' }}>
        <button style={{ width: 32, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: tab === 'tree' ? 'var(--text-primary)' : 'var(--text-tertiary)',
          position: 'relative', borderRadius: 'var(--radius-sm)' }}>
          <I.folder size={16}/>
          {tab === 'tree' && <div style={{ position: 'absolute', left: 6, right: 6, bottom: -2, height: 2, background: 'var(--accent)' }}/>}
        </button>
        <button style={{ width: 32, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: tocDisabled ? 'var(--text-tertiary)' : (tab === 'toc' ? 'var(--text-primary)' : 'var(--text-secondary)'),
          opacity: tocDisabled ? 0.5 : 1, position: 'relative', borderRadius: 'var(--radius-sm)' }}>
          <I.list size={16}/>
          {tab === 'toc' && !tocDisabled && <div style={{ position: 'absolute', left: 6, right: 6, bottom: -2, height: 2, background: 'var(--accent)' }}/>}
        </button>
        <div style={{ flex: 1 }}/>
        <button style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}><I.search size={14}/></button>
        <button style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}><I.filePlus size={14}/></button>
        <button style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}><I.folderPlus size={14}/></button>
      </div>

      {searchVisible && (
        <div style={{ padding: '10px 10px 6px' }}>
          <div style={{ height: 30, background: 'var(--bg-input)', border: '1px solid var(--border-primary)',
            borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', padding: '0 8px', gap: 6 }}>
            <I.search size={13}/> <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>搜索 · Redis</span>
            <div style={{ flex: 1 }}/>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)',
              padding: '1px 5px', borderRadius: 'var(--radius-sm)' }}>⌘K</span>
          </div>
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', paddingTop: 6 }} className="nt-scroll">
        {empty ? (
          <div style={{ padding: '48px 20px 0', textAlign: 'center' }}>
            <div style={{ color: 'var(--text-tertiary)', opacity: 0.4, display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <I.folder size={40}/>
            </div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 4 }}>还没有笔记</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 14 }}>导入 Markdown 文件开始使用</div>
            <button style={{ height: 28, padding: '0 12px', background: 'var(--bg-secondary)',
              border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-xs)', fontWeight: 500 }}>导入文件</button>
          </div>
        ) : tab === 'toc' && tocItems ? (
          <div style={{ padding: '4px 0' }}>
            {tocItems.map((t, i) => {
              const pad = 12 + t.level * 16;
              const on = t.active;
              return (
                <div key={i} style={{
                  height: 28, display: 'flex', alignItems: 'center',
                  padding: `0 10px 0 ${pad}px`, fontSize: 'var(--text-sm)',
                  color: on ? 'var(--accent)' : 'var(--text-secondary)',
                  fontWeight: on ? 500 : 400, position: 'relative',
                }}>
                  {on && <div style={{ position: 'absolute', left: 6, top: 6, bottom: 6, width: 2, background: 'var(--accent)' }}/>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.text}</span>
                </div>
              );
            })}
          </div>
        ) : (
          flatTree(SAMPLE_TREE).map((n, i) => <FileRow key={i} item={n}/>)
        )}
      </div>
    </div>
  );
};

Object.assign(window, { TopBar, Sidebar, SAMPLE_TREE });
