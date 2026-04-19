// pages-misc.jsx — /settings, /login, /setup, /indexing, 404, error

// ════════════════════════════════════════════════════════════
// /settings
// ════════════════════════════════════════════════════════════
const SettingsNav = ({ active = 'model' }) => {
  const items = [
    { id: 'model', label: '模型配置', icon: <I.robot size={14}/> },
    { id: 'appearance', label: '外观', icon: <I.palette size={14}/> },
    { id: 'storage', label: '存储', icon: <I.database size={14}/> },
    { id: 'about', label: '关于', icon: <I.info size={14}/> },
  ];
  return (
    <div style={{ width: 200, background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border-subtle)', padding: 16, flexShrink: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase',
        letterSpacing: 0.5, padding: '4px 10px 8px' }}>设置</div>
      {items.map(it => {
        const on = it.id === active;
        return (
          <div key={it.id} style={{
            height: 32, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8,
            borderRadius: 'var(--radius-sm)', marginBottom: 2,
            background: on ? 'var(--accent-subtle)' : 'transparent',
            color: on ? 'var(--accent)' : 'var(--text-primary)',
            fontSize: 'var(--text-sm)', fontWeight: on ? 500 : 400,
          }}>{it.icon}{it.label}</div>
        );
      })}
    </div>
  );
};

const Field = ({ label, children, hint }) => (
  <div style={{ marginBottom: 20 }}>
    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6 }}>{label}</div>
    {children}
    {hint && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{hint}</div>}
  </div>
);

const Select = ({ value, disabled }) => (
  <div style={{
    height: 40, padding: '0 12px', display: 'flex', alignItems: 'center',
    background: disabled ? 'var(--bg-secondary)' : 'var(--bg-input)',
    border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
    fontSize: 'var(--text-sm)', color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
    opacity: disabled ? 0.6 : 1,
  }}>
    <span style={{ flex: 1 }}>{value}</span>
    {!disabled && <I.chevronDown size={14}/>}
  </div>
);

const TextInput = ({ value, placeholder, masked, state }) => {
  const border = { success: 'var(--success)', error: 'var(--danger)' }[state] || 'var(--border-primary)';
  return (
    <div style={{
      height: 40, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8,
      background: 'var(--bg-input)', border: `1px solid ${border}`, borderRadius: 'var(--radius-md)',
      fontSize: 'var(--text-sm)', fontFamily: masked ? 'var(--font-mono)' : 'inherit',
    }}>
      <span style={{ flex: 1, color: value ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
        {value || placeholder}
      </span>
      {state === 'success' && <span style={{ color: 'var(--success)' }}><I.check size={14}/></span>}
      {state === 'error' && <span style={{ color: 'var(--danger)' }}><I.x size={14}/></span>}
      {masked && <I.eye size={14} style={{ color: 'var(--text-tertiary)' }}/>}
    </div>
  );
};

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 32 }}>
    <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 16,
      paddingBottom: 8, borderBottom: '1px solid var(--border-subtle)' }}>{title}</div>
    {children}
  </div>
);

const RadioRow = ({ checked, label, hint }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer' }}>
    <span style={{
      width: 16, height: 16, borderRadius: '50%', border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border-primary)'}`,
      background: checked ? 'var(--accent)' : 'transparent', position: 'relative', flexShrink: 0,
    }}>
      {checked && <span style={{ position: 'absolute', inset: 4, background: '#fff', borderRadius: '50%' }}/>}
    </span>
    <span style={{ fontSize: 'var(--text-sm)' }}>{label}</span>
    {hint && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{hint}</span>}
  </label>
);

// Provider chip row — preset chips + 自定义
const ProviderRow = ({ presets, active, hasCustom }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
    {presets.map(p => {
      const on = p === active;
      return (
        <button key={p} style={{
          height: 30, padding: '0 12px', fontSize: 12, fontWeight: on ? 500 : 400,
          background: on ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
          color: on ? 'var(--accent)' : 'var(--text-secondary)',
          border: `1px solid ${on ? 'var(--accent)' : 'var(--border-primary)'}`,
          borderRadius: 'var(--radius-md)',
        }}>{p}</button>
      );
    })}
    <button style={{
      height: 30, padding: '0 12px', fontSize: 12,
      background: hasCustom ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
      color: hasCustom ? 'var(--accent)' : 'var(--text-secondary)',
      border: `1px dashed ${hasCustom ? 'var(--accent)' : 'var(--border-primary)'}`,
      borderRadius: 'var(--radius-md)',
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}><I.plus size={11}/>自定义</button>
  </div>
);

const PageSettings = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active=""/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <SettingsNav active="model"/>
      <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: 32 }}>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>模型配置</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 28 }}>
            选择内置提供商，或自定义兼容 OpenAI API 的服务。API Key 仅保存在本地。
          </div>

          <Section title="Embedding 模型">
            <Field label="提供商">
              <ProviderRow presets={['OpenAI', 'Cohere', 'Voyage', 'Jina', '智谱 AI', 'BGE 本地']} active="OpenAI"/>
            </Field>
            <Field label="模型"><Select value="text-embedding-3-large"/></Field>
            <Field label="API Key">
              <TextInput value="••••••••••••••••••••sk_" masked state="success"/>
            </Field>
            <Field label="向量维度" hint="根据模型自动填充">
              <Select value="3072" disabled/>
            </Field>
          </Section>

          <Section title="LLM 模型">
            <Field label="提供商">
              <ProviderRow presets={['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'Qwen', 'Ollama']} active="自定义" hasCustom/>
            </Field>
            <Field label="Base URL" hint="兼容 OpenAI 格式的 API 入口">
              <TextInput value="https://api.moonshot.cn/v1"/>
            </Field>
            <Field label="模型名" hint="自定义提供商需手动填写模型标识">
              <TextInput value="kimi-k2-preview"/>
            </Field>
            <Field label="API Key">
              <TextInput placeholder="sk-..." masked state="error"/>
              <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
                ✕ 校验失败：无效的 API Key，请重新填写
              </div>
            </Field>
          </Section>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Btn variant="secondary">测试连接</Btn>
            <Btn variant="primary">保存配置</Btn>
          </div>
        </div>
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// /login
// ════════════════════════════════════════════════════════════
const Spinner = ({ size = 24 }) => (
  <div style={{
    width: size, height: size, borderRadius: '50%',
    border: '2px solid var(--border-primary)', borderTopColor: 'var(--accent)',
    animation: 'spin 0.8s linear infinite', display: 'inline-block'
  }}/>
);

const PageLogin = () => (
  <div className="nt" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ textAlign: 'center', padding: 24 }}>
      <div style={{ display: 'inline-flex', marginBottom: 20 }}>
        <NotusLogo size={64}/>
      </div>
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, letterSpacing: -0.4, marginBottom: 4 }}>Notus</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 40 }}>
        你的笔记，你的 AI 副驾驶
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center',
        color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        <Spinner size={18}/>
        <span>正在登录…</span>
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// /setup
// ════════════════════════════════════════════════════════════
const StepDots = ({ current }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0, marginBottom: 40 }}>
    {[0, 1, 2].map(i => (
      <React.Fragment key={i}>
        <div style={{
          width: 12, height: 12, borderRadius: '50%',
          background: i <= current ? 'var(--accent)' : 'var(--bg-active)',
        }}/>
        {i < 2 && <div style={{ width: 60, height: 2, background: i < current ? 'var(--accent)' : 'var(--border-primary)' }}/>}
      </React.Fragment>
    ))}
  </div>
);

// Shared Setup shell — header + stepper + content + footer
const SetupShell = ({ step, title, subtitle, children, canSkip, prev, nextLabel = '下一步', nextDisabled, nextVariant = 'primary' }) => (
  <div className="nt" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 56, overflow: 'auto' }}>
    <div style={{ maxWidth: 560, width: '100%', padding: 24 }}>
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div style={{ display: 'inline-flex', marginBottom: 14 }}><NotusLogo size={40}/></div>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>{subtitle}</div>
      </div>
      <StepDotsLabeled current={step} labels={['配置模型', '导入笔记', '建立索引']}/>
      {children}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
        <div>
          {canSkip
            ? <Btn variant="ghost">跳过，稍后配置</Btn>
            : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>此步骤必须完成</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {prev && <Btn variant="ghost">上一步</Btn>}
          <Btn variant={nextVariant} style={nextDisabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}>{nextLabel}</Btn>
        </div>
      </div>
    </div>
  </div>
);

const StepDotsLabeled = ({ current, labels }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', marginBottom: 36 }}>
    {labels.map((lb, i) => {
      const done = i < current;
      const on = i === current;
      return (
        <React.Fragment key={i}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 90 }}>
            <div style={{
              width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: (on || done) ? 'var(--accent)' : 'var(--bg-active)',
              color: (on || done) ? '#fff' : 'var(--text-tertiary)',
              fontSize: 12, fontWeight: 600,
            }}>
              {done ? <I.check size={13}/> : i + 1}
            </div>
            <div style={{ fontSize: 11, color: on ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: on ? 500 : 400 }}>{lb}</div>
          </div>
          {i < labels.length - 1 && (
            <div style={{ flex: '0 0 40px', height: 2, marginTop: 12,
              background: i < current ? 'var(--accent)' : 'var(--border-primary)' }}/>
          )}
        </React.Fragment>
      );
    })}
  </div>
);

// Step 1 — Model config (skippable)
const PageSetupStep1 = () => (
  <SetupShell
    step={0}
    title="配置 AI 模型"
    subtitle="Notus 需要一个 Embedding 模型用于索引，一个 LLM 用于对话。你也可以稍后配置。"
    canSkip
    nextLabel="下一步"
  >
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-xl)', padding: 20,
    }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 10 }}>Embedding 模型</div>
      <div style={{ marginBottom: 10 }}>
        <ProviderRow presets={['OpenAI', 'Voyage', 'Jina', '智谱']} active="OpenAI"/>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Select value="text-embedding-3-large · 3072 维"/>
      </div>
      <TextInput placeholder="sk-..." masked/>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '18px 0' }}/>

      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 10 }}>LLM 模型</div>
      <div style={{ marginBottom: 10 }}>
        <ProviderRow presets={['Anthropic', 'OpenAI', 'Google', 'DeepSeek']} active="Anthropic"/>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Select value="claude-opus-4-5"/>
      </div>
      <TextInput value="••••••••••••••••" masked state="success"/>
    </div>
  </SetupShell>
);

// Step 2 — Folder selection (NOT skippable)
const PageSetupStep2 = () => (
  <SetupShell
    step={1}
    title="选择笔记目录"
    subtitle="选一个已有的 Markdown 文件夹，或使用一个空目录从头开始"
    prev
    nextLabel="下一步"
  >
    <div style={{
      border: '2px dashed var(--accent)', borderRadius: 'var(--radius-xl)',
      padding: 36, textAlign: 'center', background: 'var(--accent-subtle)',
    }}>
      <div style={{ color: 'var(--accent)', display: 'inline-flex', marginBottom: 12 }}>
        <I.upload size={32}/>
      </div>
      <div style={{ fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: 4 }}>拖拽文件夹到这里</div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 16 }}>或</div>
      <Btn variant="secondary">选择文件夹</Btn>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 20 }}>
        支持 .md、.markdown · 最多 10,000 篇
      </div>
    </div>
    <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
      display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ color: 'var(--text-secondary)' }}><I.folder size={14}/></span>
      <span style={{ fontSize: 'var(--text-sm)', flex: 1, fontFamily: 'var(--font-mono)' }}>~/Documents/Notes</span>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>已选 · 128 篇</span>
    </div>
    <Btn variant="ghost" size="sm" style={{ marginTop: 8 }}>+ 使用空目录从头开始</Btn>
  </SetupShell>
);

// Step 3 — Indexing (NOT skippable, blocks entry)
const PageSetupStep3 = () => (
  <SetupShell
    step={2}
    title="正在为你建立索引"
    subtitle="完成后，你就能从任何一段话检索到它。这需要一点时间，请保持页面打开。"
    prev
    nextLabel="建立索引中…"
    nextDisabled
  >
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-xl)', padding: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>98 / 128 篇</div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>约剩 42 秒</div>
      </div>
      <div style={{ height: 6, background: 'var(--bg-active)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
        <div style={{ width: '77%', height: '100%', background: 'var(--accent)' }}/>
      </div>
      <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spinner size={12}/>
        <span>→ 技术文章 / 缓存系列 / 性能优化实践.md</span>
      </div>
      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '18px 0' }}/>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {[
          { n: '3,842', l: '已生成向量' },
          { n: '98', l: '已处理文件' },
          { n: '2', l: '解析失败' },
        ].map((s, i) => (
          <div key={i}>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, fontFamily: 'var(--font-editor)' }}>{s.n}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.l}</div>
          </div>
        ))}
      </div>
    </div>
    <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}>
      索引完成后将自动进入 Notus。你也可以在设置中随时重建索引。
    </div>
  </SetupShell>
);

// Back-compat
const PageSetup = PageSetupStep2;

// ════════════════════════════════════════════════════════════
// /indexing
// ════════════════════════════════════════════════════════════
const PageIndexing = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="" showIndex/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree"/>
      <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', padding: 32 }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 4 }}>正在建立索引</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 24 }}>
            正在向量化你的笔记，这样你就能从任何一段话检索到它
          </div>

          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>82 / 128 篇</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>约剩 1 分 20 秒</div>
            </div>
            <div style={{ height: 6, background: 'var(--bg-active)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
              <div style={{ width: '64%', height: '100%', background: 'var(--accent)' }}/>
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)' }}>
              → 技术文章 / 缓存系列 / 性能优化实践.md
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase',
            letterSpacing: 0.5, marginBottom: 8 }}>已完成</div>
          {[
            { name: '技术文章 / Redis 深入.md', n: 42, ok: true },
            { name: '技术文章 / 分布式系统 / 一致性.md', n: 28, ok: true },
            { name: '随笔 / 关于慢的意义.md', n: 12, ok: true },
            { name: '随笔 / 周末煮茶.md', n: 6, ok: true },
            { name: '随笔 / 搬家第三周.md', n: 0, ok: false },
            { name: '读书笔记 / 《思考快与慢》摘录.md', n: 18, ok: true },
          ].map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', borderRadius: 'var(--radius-sm)',
              background: i % 2 ? 'transparent' : 'var(--bg-secondary)' }}>
              <span style={{ color: r.ok ? 'var(--success)' : 'var(--warning)' }}>
                {r.ok ? <I.check size={14}/> : <I.warn size={14}/>}
              </span>
              <span style={{ fontSize: 'var(--text-sm)', flex: 1 }}>{r.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                {r.ok ? `${r.n} 块` : '解析失败'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// 404
// ════════════════════════════════════════════════════════════
const Page404 = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active=""/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree"/>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-primary)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 96, fontWeight: 700, color: 'var(--text-primary)',
            opacity: 0.12, letterSpacing: -2, lineHeight: 1, marginBottom: 16,
            fontFamily: 'var(--font-editor)' }}>404</div>
          <div style={{ fontSize: 'var(--text-lg)', fontWeight: 500, marginBottom: 6 }}>这里什么都没有</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 20, maxWidth: 320 }}>
            你要找的页面可能被移动了，或者从来没有存在过
          </div>
          <Btn variant="secondary" icon={<I.home size={14}/>}>返回首页</Btn>
        </div>
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// Fatal error
// ════════════════════════════════════════════════════════════
const PageError = () => (
  <div className="nt" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ textAlign: 'center', maxWidth: 440, padding: 24 }}>
      <div style={{ display: 'inline-flex', color: 'var(--danger)', marginBottom: 20 }}>
        <I.warn size={56}/>
      </div>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 8 }}>出了点问题</div>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.7 }}>
        索引数据库无法打开。可能是上次非正常关闭造成的文件锁未释放。
      </div>
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)', padding: 12, fontFamily: 'var(--font-mono)',
        fontSize: 11, color: 'var(--text-secondary)', textAlign: 'left', marginBottom: 24,
      }}>
        Error: LOCK: Resource temporarily unavailable<br/>
        &nbsp;&nbsp;at Database.open (index.db:LOCK)
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <Btn variant="secondary" icon={<I.refresh size={14}/>}>重新加载</Btn>
        <Btn variant="primary" icon={<I.settings size={14}/>}>前往设置</Btn>
      </div>
    </div>
  </div>
);

Object.assign(window, {
  PageSettings, PageLogin, PageSetup, PageSetupStep1, PageSetupStep2, PageSetupStep3,
  PageIndexing, Page404, PageError, Spinner,
});
