// pages.jsx — all Notus page artboards

// ════════════════════════════════════════════════════════════
// Shared primitives
// ════════════════════════════════════════════════════════════
const Btn = ({ variant = 'secondary', size = 'md', children, icon, style, ...rest }) => {
  const sz = { sm: { h: 28, fs: 11, px: 10 }, md: { h: 36, fs: 13, px: 14 }, lg: { h: 44, fs: 15, px: 18 } }[size];
  const vars = {
    primary: { bg: 'var(--accent)', color: 'var(--text-on-accent)', border: 'none' },
    secondary: { bg: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)' },
    ghost: { bg: 'transparent', color: 'var(--text-primary)', border: 'none' },
    danger: { bg: 'var(--danger)', color: '#fff', border: 'none' },
  }[variant];
  return (
    <button style={{
      height: sz.h, padding: `0 ${sz.px}px`, fontSize: sz.fs, fontWeight: 500,
      borderRadius: 'var(--radius-md)', display: 'inline-flex', alignItems: 'center',
      gap: 6, whiteSpace: 'nowrap', ...vars, ...style
    }} {...rest}>
      {icon}{children}
    </button>
  );
};

const Badge = ({ tone = 'default', children }) => {
  const tones = {
    default: { bg: 'var(--bg-secondary)', color: 'var(--text-secondary)' },
    accent: { bg: 'var(--accent-subtle)', color: 'var(--accent)' },
    warning: { bg: 'var(--warning-subtle)', color: 'var(--warning)' },
    danger: { bg: 'var(--danger-subtle)', color: 'var(--danger)' },
    success: { bg: 'var(--success-subtle)', color: 'var(--success)' },
  }[tone];
  return (
    <span style={{
      fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 'var(--radius-full)',
      ...tones, display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>{children}</span>
  );
};

const Divider = () => <div style={{ width: 1, height: 20, background: 'var(--border-subtle)', margin: '0 4px' }}/>;

const TbBtn = ({ active, children }) => (
  <button style={{
    width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 'var(--radius-sm)', color: active ? 'var(--accent)' : 'var(--text-secondary)',
    background: active ? 'var(--accent-subtle)' : 'transparent',
  }}>{children}</button>
);

// ════════════════════════════════════════════════════════════
// /files — Editor (default)
// ════════════════════════════════════════════════════════════
const TOC_ITEMS = [
  { level: 0, text: '性能优化实践', active: false },
  { level: 1, text: '为什么需要缓存' },
  { level: 1, text: '缓存的基本策略', active: true },
  { level: 2, text: 'Cache-Aside' },
  { level: 2, text: 'Read / Write Through' },
  { level: 1, text: '失效与击穿' },
  { level: 1, text: '一致性权衡' },
  { level: 1, text: '实践建议' },
];

const EditorToolbar = () => (
  <div style={{ height: 40, background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)',
    display: 'flex', alignItems: 'center', padding: '0 12px', gap: 2, flexShrink: 0 }}>
    <TbBtn><I.bold size={15}/></TbBtn>
    <TbBtn><I.italic size={15}/></TbBtn>
    <TbBtn><I.strike size={15}/></TbBtn>
    <Divider/>
    <button style={{
      height: 28, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4,
      borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
    }}>H2 <I.chevronDown size={11}/></button>
    <Divider/>
    <TbBtn><I.link size={15}/></TbBtn>
    <TbBtn><I.image size={15}/></TbBtn>
    <Divider/>
    <TbBtn><I.code size={15}/></TbBtn>
    <TbBtn><I.quote size={15}/></TbBtn>
    <TbBtn><I.divider size={15}/></TbBtn>
    <Divider/>
    <TbBtn><I.listUl size={15}/></TbBtn>
    <TbBtn><I.listOl size={15}/></TbBtn>
    <div style={{ flex: 1 }}/>
    <TbBtn><I.undo size={15}/></TbBtn>
    <TbBtn><I.redo size={15}/></TbBtn>
    <Divider/>
    <button style={{
      height: 28, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 6,
      borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
      border: '1px solid var(--border-subtle)',
    }}><I.split size={13}/> 分栏预览</button>
    <button style={{
      height: 28, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 6,
      borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)', fontWeight: 500,
      background: 'var(--accent)', color: '#fff', marginLeft: 6,
    }}><I.sparkles size={13}/> AI 创作</button>
  </div>
);

const EditorBody = ({ highlightRef }) => (
  <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 60px 80px', fontFamily: 'var(--font-editor)', color: 'var(--text-primary)' }}>
      <h1 style={{ fontSize: 'var(--text-3xl)', fontWeight: 700, margin: '0 0 8px', lineHeight: 1.3 }}>性能优化实践</h1>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-ui)', marginBottom: 32 }}>
        技术文章 / 缓存系列 · 2026-04-12 · 4,280 字
      </div>
      <p style={{ fontSize: 'var(--text-lg)', lineHeight: 1.8, margin: '0 0 24px' }}>
        缓存是所有中高流量系统的核心手段之一。它看起来简单——把热数据放近一点，让读取更快——但真正落地时，几乎每一个决定都牵涉到一致性、复杂度、故障模式之间的权衡。
      </p>

      <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, margin: '40px 0 12px' }}>为什么需要缓存</h2>
      <p style={{ fontSize: 'var(--text-lg)', lineHeight: 1.8, margin: '0 0 20px' }}>
        直觉上，数据库是系统的真相之源。但当 QPS 超过数千、甚至上万时，真相之源的访问代价会迅速变得无法接受。缓存的本质，是把访问频率远高于写入频率的数据，下沉到一个更近、更快的位置。
      </p>

      <h2 style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, margin: '40px 0 12px' }}>缓存的基本策略</h2>
      <p style={{ fontSize: 'var(--text-lg)', lineHeight: 1.8, margin: '0 0 16px' }}>
        常见的缓存更新策略有三种：<em style={{ fontStyle: 'italic' }}>Cache-Aside</em>、<em>Read/Write-Through</em> 和 <em>Write-Back</em>。它们分别适用于不同的一致性要求。
      </p>

      {highlightRef && (
        <div style={{
          background: 'var(--bg-diff-modified)', borderRadius: 'var(--radius-sm)',
          margin: '0 -8px 16px', padding: '0 8px',
        }}>
          <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, margin: '20px 0 8px' }}>Cache-Aside</h3>
          <p style={{ fontSize: 'var(--text-lg)', lineHeight: 1.8, margin: '0 0 12px' }}>
            读时先查缓存，命中直接返回；未命中则穿透到数据库，读完回填缓存。写操作直接写数据库，并<strong style={{ fontWeight: 700 }}>主动失效</strong>缓存。
          </p>
        </div>
      )}
      {!highlightRef && (
        <>
          <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, margin: '20px 0 8px' }}>Cache-Aside</h3>
          <p style={{ fontSize: 'var(--text-lg)', lineHeight: 1.8, margin: '0 0 12px' }}>
            读时先查缓存，命中直接返回；未命中则穿透到数据库，读完回填缓存。写操作直接写数据库，并<strong style={{ fontWeight: 700 }}>主动失效</strong>缓存。
          </p>
        </>
      )}

      <pre style={{
        background: 'var(--bg-secondary)', padding: 'var(--space-4)',
        borderRadius: 'var(--radius-md)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
        lineHeight: 1.6, overflow: 'auto', margin: '16px 0 24px',
      }}>
<span style={{ color: '#6B6158' }}>// 伪代码</span>{'\n'}
<span style={{ color: '#C15F3C' }}>function</span> <span style={{ color: '#1A1311' }}>get</span>(key) {'{'}{'\n'}
{'  '}<span style={{ color: '#C15F3C' }}>let</span> value = cache.get(key);{'\n'}
{'  '}<span style={{ color: '#C15F3C' }}>if</span> (value) <span style={{ color: '#C15F3C' }}>return</span> value;{'\n'}
{'  '}value = db.query(key);{'\n'}
{'  '}cache.set(key, value, <span style={{ color: '#1E8E3E' }}>60</span>);{'\n'}
{'  '}<span style={{ color: '#C15F3C' }}>return</span> value;{'\n'}
{'}'}
      </pre>

      <blockquote style={{
        borderLeft: '3px solid var(--accent)', paddingLeft: 'var(--space-4)',
        color: 'var(--text-secondary)', margin: '20px 0', fontSize: 'var(--text-lg)', lineHeight: 1.7,
      }}>
        Cache-Aside 把缓存视为"可有可无的加速层"，失败时应当回退到数据库，而不是把错误抛给调用方。
      </blockquote>

      <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, margin: '32px 0 8px' }}>Read / Write Through</h3>
      <p style={{ fontSize: 'var(--text-lg)', lineHeight: 1.8, margin: '0 0 16px' }}>
        Read-Through 将未命中的处理隐藏到缓存层内部，调用方只面对一个统一接口。Write-Through 则在写入时同步更新缓存和数据库……
      </p>
    </div>
  </div>
);

const PageFilesDefault = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="files" fileName="性能优化实践.md" saveState="dirty"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
      <Sidebar tab="toc" tocDisabled={false} tocItems={TOC_ITEMS}/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <EditorToolbar/>
        <EditorBody highlightRef={true}/>
      </div>
      <div style={{
        position: 'absolute', right: 20, bottom: 20,
        display: 'flex', alignItems: 'center', gap: 10,
        background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--radius-md)',
        padding: '10px 14px', fontSize: 'var(--text-sm)', color: 'var(--text-primary)',
      }}>
        <span style={{
          width: 18, height: 18, borderRadius: '50%', background: 'var(--success)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}><I.check size={11}/></span>
        <span>已索引到知识库 · 新增 <strong style={{ fontWeight: 600 }}>8</strong> 个段落</span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)', marginLeft: 4 }}>刚刚</span>
      </div>
    </div>
  </div>
);

// Editor — empty state (no file selected)
const PageFilesEmpty = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="files"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree"/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
        <EditorToolbar/>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', maxWidth: 360 }}>
            <div style={{ opacity: 0.3, marginBottom: 16, color: 'var(--text-secondary)', display: 'flex', justifyContent: 'center' }}>
              <I.edit size={48}/>
            </div>
            <div style={{ fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: 6 }}>选择一篇文章开始编辑</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>从左侧文件树中选择文件，或使用 ⌘K 快速查找</div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

// Editor — split preview
const PageFilesSplit = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="files" fileName="Redis 深入.md" saveState="saving"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree"/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <EditorToolbar/>
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: 'var(--bg-primary)' }}>
          <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', borderRight: '1px solid var(--border-primary)',
            padding: '32px 40px', fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.75, color: 'var(--text-primary)' }}>
            <div style={{ color: 'var(--text-tertiary)' }}># Redis 深入</div>
            <div style={{ height: 16 }}/>
            <div>Redis 是一个**内存优先**的键值数据库。</div>
            <div style={{ height: 12 }}/>
            <div style={{ color: 'var(--text-tertiary)' }}>## 数据结构</div>
            <div style={{ height: 8 }}/>
            <div>Redis 支持 String / Hash / List / Set / Sorted Set 五种</div>
            <div>基础数据结构，以及 Stream、Bitmap、HyperLogLog 等。</div>
            <div style={{ height: 12 }}/>
            <div>- String：最常用，存储字符串或数字</div>
            <div>- Hash：适合存储对象</div>
            <div>- ZSet：<span style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', padding: '0 3px', borderRadius: 3 }}>用于排行榜</span>场景</div>
            <div style={{ height: 12 }}/>
            <div>```js</div>
            <div style={{ color: 'var(--text-secondary)' }}>redis.zadd('rank', 99, 'alice')</div>
            <div>```</div>
          </div>
          <div className="nt-scroll" style={{ flex: 1, overflow: 'auto',
            padding: '32px 40px', fontFamily: 'var(--font-editor)', fontSize: 'var(--text-lg)', lineHeight: 1.8 }}>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 16px' }}>Redis 深入</h1>
            <p style={{ margin: '0 0 16px' }}>
              Redis 是一个<strong style={{ fontWeight: 700 }}>内存优先</strong>的键值数据库。
            </p>
            <h2 style={{ fontSize: 22, fontWeight: 600, margin: '24px 0 12px' }}>数据结构</h2>
            <p style={{ margin: '0 0 12px' }}>
              Redis 支持 String / Hash / List / Set / Sorted Set 五种基础数据结构，以及 Stream、Bitmap、HyperLogLog 等。
            </p>
            <ul style={{ margin: '0 0 12px', paddingLeft: 22 }}>
              <li>String：最常用，存储字符串或数字</li>
              <li>Hash：适合存储对象</li>
              <li>ZSet：用于排行榜场景</li>
            </ul>
            <pre style={{ background: 'var(--bg-secondary)', padding: 12, borderRadius: 6,
              fontSize: 13, fontFamily: 'var(--font-mono)' }}>redis.zadd('rank', 99, 'alice')</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, {
  Btn, Badge, Divider, TbBtn, TOC_ITEMS,
  PageFilesDefault, PageFilesEmpty, PageFilesSplit,
});
