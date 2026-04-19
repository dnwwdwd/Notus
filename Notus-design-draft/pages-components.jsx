// pages-components.jsx — Component library showcase page

const CGroup = ({ title, children, cols = 2 }) => (
  <div style={{ marginBottom: 32 }}>
    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase',
      letterSpacing: 0.6, marginBottom: 10, fontWeight: 500 }}>{title}</div>
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
      {children}
    </div>
  </div>
);

const CCell = ({ label, children, span = 1 }) => (
  <div style={{
    gridColumn: `span ${span}`,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)', padding: 16,
  }}>
    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>{label}</div>
    {children}
  </div>
);

const Tooltip = ({ text }) => (
  <div style={{ display: 'inline-block', position: 'relative' }}>
    <div style={{
      position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
      marginBottom: 6, background: 'var(--text-primary)', color: 'var(--bg-primary)',
      fontSize: 11, padding: '4px 8px', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap',
    }}>
      {text}
      <div style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
        width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent',
        borderTop: '4px solid var(--text-primary)' }}/>
    </div>
    <Btn variant="secondary" size="sm">悬停</Btn>
  </div>
);

const Toggle = ({ on }) => (
  <div style={{
    width: 40, height: 22, borderRadius: 'var(--radius-full)',
    background: on ? 'var(--accent)' : 'var(--bg-active)',
    position: 'relative', transition: 'background 200ms',
  }}>
    <div style={{
      position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18,
      background: '#fff', borderRadius: '50%', boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      transition: 'left 200ms',
    }}/>
  </div>
);

const Toast = ({ tone = 'success', icon, msg }) => {
  const tones = {
    success: 'var(--success)', danger: 'var(--danger)',
    info: '#4A8CD9', warning: 'var(--warning)'
  }[tone];
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-md)',
      padding: '10px 14px', display: 'inline-flex', alignItems: 'center', gap: 10,
      fontSize: 'var(--text-sm)', minWidth: 240,
    }}>
      <span style={{ color: tones }}>{icon}</span>
      <span>{msg}</span>
    </div>
  );
};

const ContextMenu = () => (
  <div style={{
    background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)',
    minWidth: 180, padding: 4, display: 'inline-block',
  }}>
    {[
      { icon: <I.edit size={13}/>, label: '重命名' },
      { icon: <I.file size={13}/>, label: '在编辑器打开' },
      { icon: <I.refresh size={13}/>, label: '重建索引' },
    ].map((it, i) => (
      <div key={i} style={{ height: 30, padding: '0 10px', display: 'flex',
        alignItems: 'center', gap: 10, fontSize: 'var(--text-sm)',
        borderRadius: 'var(--radius-sm)', background: i === 1 ? 'var(--bg-hover)' : 'transparent' }}>
        {it.icon}{it.label}
      </div>
    ))}
    <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }}/>
    <div style={{ height: 30, padding: '0 10px', display: 'flex',
      alignItems: 'center', gap: 10, fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>
      <I.trash size={13}/>删除
    </div>
  </div>
);

const Dialog = () => (
  <div style={{
    background: 'var(--bg-elevated)', borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 420,
    border: '1px solid var(--border-subtle)',
  }}>
    <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>确认删除文件？</div>
    </div>
    <div style={{ padding: 20, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
      <strong style={{ color: 'var(--text-primary)' }}>"Redis 深入.md"</strong> 将被移到回收站。它已生成的 42 个索引块也会一并清除。
    </div>
    <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-subtle)',
      display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
      <Btn variant="ghost" size="md">取消</Btn>
      <Btn variant="danger" size="md" icon={<I.trash size={13}/>}>删除</Btn>
    </div>
  </div>
);

const CommandPalette = () => (
  <div style={{
    width: '100%', maxWidth: 480,
    background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
  }}>
    <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 10,
      padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      <I.search size={16} style={{ color: 'var(--text-tertiary)' }}/>
      <span style={{ flex: 1, fontSize: 'var(--text-base)' }}>缓</span>
      <span style={{ display: 'inline-block', width: 1.5, height: 18, background: 'var(--accent)',
        animation: 'blink 1s step-end infinite' }}/>
      <span style={{ fontSize: 10, color: 'var(--text-tertiary)',
        background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 3 }}>esc</span>
    </div>
    <div style={{ padding: 6 }}>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase',
        letterSpacing: 0.5, padding: '6px 10px' }}>文件</div>
      <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px',
        borderRadius: 'var(--radius-sm)', background: 'var(--bg-hover)' }}>
        <I.file size={14}/>
        <span style={{ fontSize: 'var(--text-sm)' }}>
          性能优化实践 · <span style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', padding: '0 3px' }}>缓</span>存系列
        </span>
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>技术文章</span>
      </div>
      <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px',
        borderRadius: 'var(--radius-sm)' }}>
        <I.file size={14}/>
        <span style={{ fontSize: 'var(--text-sm)' }}>Redis 深入 <span style={{ color: 'var(--text-tertiary)' }}>· 含 <span style={{ background: 'var(--accent-subtle)', color: 'var(--accent)', padding: '0 3px' }}>缓</span>存章节</span></span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase',
        letterSpacing: 0.5, padding: '10px 10px 6px' }}>命令</div>
      <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px',
        borderRadius: 'var(--radius-sm)' }}>
        <I.plus size={14}/>
        <span style={{ fontSize: 'var(--text-sm)' }}>新建笔记</span>
        <span style={{ flex: 1 }}/>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>⌘N</span>
      </div>
    </div>
  </div>
);

const PageComponents = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active=""/>
    <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: 40 }}>
        <div style={{ fontFamily: 'var(--font-editor)', fontSize: 'var(--text-3xl)', fontWeight: 700,
          marginBottom: 6 }}>组件库</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 32 }}>
          Notus 设计系统 v2.1 · 25 个通用组件
        </div>

        <CGroup title="Buttons" cols={4}>
          <CCell label="primary · md"><Btn variant="primary">保存</Btn></CCell>
          <CCell label="secondary · md"><Btn variant="secondary">取消</Btn></CCell>
          <CCell label="ghost · md"><Btn variant="ghost">更多</Btn></CCell>
          <CCell label="danger · md"><Btn variant="danger" icon={<I.trash size={13}/>}>删除</Btn></CCell>
          <CCell label="primary · sm"><Btn variant="primary" size="sm" icon={<I.sparkles size={11}/>}>AI 创作</Btn></CCell>
          <CCell label="primary · lg"><Btn variant="primary" size="lg">开始使用</Btn></CCell>
          <CCell label="disabled"><Btn variant="primary" style={{ opacity: 0.4, cursor: 'not-allowed' }}>保存</Btn></CCell>
          <CCell label="loading"><Btn variant="primary"><Spinner size={12}/>加载中…</Btn></CCell>
        </CGroup>

        <CGroup title="Badges" cols={5}>
          <CCell label="default"><Badge>默认</Badge></CCell>
          <CCell label="accent"><Badge tone="accent">新</Badge></CCell>
          <CCell label="warning"><Badge tone="warning">已修改</Badge></CCell>
          <CCell label="danger"><Badge tone="danger">失败</Badge></CCell>
          <CCell label="success"><Badge tone="success">已索引</Badge></CCell>
        </CGroup>

        <CGroup title="Input" cols={2}>
          <CCell label="default">
            <TextInput placeholder="输入内容…"/>
          </CCell>
          <CCell label="filled">
            <TextInput value="性能优化实践"/>
          </CCell>
          <CCell label="success · API Key">
            <TextInput value="••••••••••••••••" masked state="success"/>
          </CCell>
          <CCell label="error · API Key">
            <TextInput value="••••" masked state="error"/>
          </CCell>
        </CGroup>

        <CGroup title="Toggle & Select" cols={3}>
          <CCell label="toggle off"><Toggle on={false}/></CCell>
          <CCell label="toggle on"><Toggle on={true}/></CCell>
          <CCell label="radio group">
            <RadioRow checked={false} label="浅色"/>
            <RadioRow checked={true} label="深色"/>
            <RadioRow checked={false} label="跟随系统"/>
          </CCell>
          <CCell label="select" span={3}><Select value="claude-opus-4-5"/></CCell>
        </CGroup>

        <CGroup title="Spinner & Progress" cols={3}>
          <CCell label="sm"><Spinner size={16}/></CCell>
          <CCell label="md"><Spinner size={24}/></CCell>
          <CCell label="lg"><Spinner size={32}/></CCell>
          <CCell label="progress · 64%" span={3}>
            <div style={{ height: 6, background: 'var(--bg-active)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
              <div style={{ width: '64%', height: '100%', background: 'var(--accent)' }}/>
            </div>
          </CCell>
        </CGroup>

        <CGroup title="Source Card & Inline Error" cols={2}>
          <CCell label="source card" span={2}>
            <SourceCard file="性能优化实践.md" path="缓存策略 › Cache-Aside" quote="Redis 的过期策略应当优先于业务兜底逻辑…"/>
          </CCell>
          <CCell label="inline error" span={2}>
            <div style={{ background: 'var(--danger-subtle)', borderRadius: 'var(--radius-md)',
              padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 'var(--text-sm)' }}>
              <span style={{ color: 'var(--danger)' }}><I.x size={14}/></span>
              <span style={{ flex: 1 }}>API 请求失败：超时未响应</span>
              <Btn variant="ghost" size="sm">重试</Btn>
            </div>
          </CCell>
        </CGroup>

        <CGroup title="Toast" cols={2}>
          <CCell label="success"><Toast tone="success" icon={<I.check size={14}/>} msg="索引已完成，142 篇笔记"/></CCell>
          <CCell label="danger"><Toast tone="danger" icon={<I.x size={14}/>} msg="保存失败，请检查网络"/></CCell>
          <CCell label="warning"><Toast tone="warning" icon={<I.warn size={14}/>} msg="3 个文件解析失败"/></CCell>
          <CCell label="info"><Toast tone="info" icon={<I.info size={14}/>} msg="已切换到深色主题"/></CCell>
        </CGroup>

        <CGroup title="Overlays" cols={2}>
          <CCell label="context menu" span={1}><ContextMenu/></CCell>
          <CCell label="tooltip" span={1}>
            <div style={{ paddingTop: 32 }}><Tooltip text="快捷键 ⌘S"/></div>
          </CCell>
          <CCell label="dialog · confirm" span={1}><Dialog/></CCell>
          <CCell label="command palette ⌘K" span={1}><CommandPalette/></CCell>
        </CGroup>

        <CGroup title="Skeleton" cols={1}>
          <CCell label="loading article" span={1}>
            {[0.6, 1, 1, 0.9, 0.85, 1, 0.7].map((w, i) => (
              <div key={i} style={{
                height: i === 0 ? 24 : 14, width: `${w * 100}%`, marginBottom: 8,
                background: 'linear-gradient(90deg, var(--bg-secondary), var(--bg-hover), var(--bg-secondary))',
                backgroundSize: '200% 100%', animation: 'shimmer 1.5s infinite',
                borderRadius: 'var(--radius-sm)',
              }}/>
            ))}
          </CCell>
        </CGroup>
      </div>
    </div>
  </div>
);

Object.assign(window, { PageComponents, Tooltip, Toggle, Toast, ContextMenu, Dialog, CommandPalette });
