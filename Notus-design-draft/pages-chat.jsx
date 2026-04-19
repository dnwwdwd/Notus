// pages-chat.jsx — /knowledge + /canvas

// ════════════════════════════════════════════════════════════
// /knowledge — Q&A
// ════════════════════════════════════════════════════════════
const SourceCard = ({ file, path, quote, lines }) => (
  <div style={{
    background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
    borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', marginBottom: 8,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <I.file size={13}/>
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>{file}</span>
      <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>›</span>
      <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>{path}</span>
      {lines && <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)',
        color: 'var(--accent)', background: 'var(--accent-subtle)',
        padding: '1px 6px', borderRadius: 3 }}>{lines}</span>}
      <div style={{ flex: 1 }}/>
      <I.chevronRight size={12}/>
    </div>
    <div style={{
      fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>"{quote}"</div>
  </div>
);

const UserBubble = ({ children }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0' }}>
    <div style={{
      maxWidth: '75%', background: 'var(--bg-user-bubble)',
      padding: '10px 14px', borderRadius: 'var(--radius-lg)',
      fontSize: 'var(--text-sm)', lineHeight: 1.6,
    }}>{children}</div>
  </div>
);

// Retrieval status row — shown before AI starts streaming
const RetrievalStatus = ({ stage, sources = 3 }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 12px',
    padding: '8px 12px', background: 'var(--accent-subtle)',
    border: '1px solid var(--accent-subtle)',
    borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--accent)',
  }}>
    {stage === 'searching' && <><I.search size={13}/><span>正在从 142 篇笔记中检索相关段落…</span></>}
    {stage === 'found' && <><I.check size={13}/><span>找到 {sources} 篇相关笔记 · 正在组织答案</span></>}
  </div>
);

const AiBubble = ({ children, streaming }) => (
  <div style={{ margin: '16px 0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8,
      color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
      <span style={{ color: 'var(--accent)' }}><I.sparkles size={13}/></span>
      <span>Notus</span>
    </div>
    <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--text-primary)' }}>
      {children}
      {streaming && (
        <span style={{ display: 'inline-block', width: 2, height: '1em', verticalAlign: '-2px',
          marginLeft: 2, background: 'var(--accent)', animation: 'blink 1s step-end infinite' }}/>
      )}
    </div>
  </div>
);

const InputBar = ({ placeholder = '问点什么…', suggestionRow, model = 'Claude Opus 4.5' }) => (
  <div style={{ background: 'var(--bg-elevated)', borderTop: '1px solid var(--border-subtle)',
    padding: '12px 16px', flexShrink: 0 }}>
    {suggestionRow}
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <button style={{
        height: 32, padding: '0 10px', display: 'flex', alignItems: 'center', gap: 4,
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)', fontSize: 11, color: 'var(--text-secondary)',
      }}>{model} <I.chevronDown size={10}/></button>
      <div style={{ flex: 1, minHeight: 40, padding: '10px 14px',
        background: 'var(--bg-input)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)',
        color: 'var(--text-tertiary)' }}>{placeholder}</div>
      <button style={{ width: 40, height: 40, borderRadius: 'var(--radius-full)',
        background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <I.send size={16}/>
      </button>
    </div>
  </div>
);

const PageKnowledgeDefault = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="knowledge"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree" tocDisabled={true}/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
        <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', padding: '24px 40px' }}>
          <div style={{ maxWidth: 680, margin: '0 auto' }}>
            <UserBubble>Redis 用作缓存时，一致性怎么保证？</UserBubble>
            <AiBubble>
              <RetrievalStatus stage="found" sources={3}/>
              <p style={{ margin: '0 0 12px' }}>根据你的笔记，Redis 作为缓存层时，一致性主要通过以下三个策略控制：</p>
              <ol style={{ margin: '0 0 16px', paddingLeft: 22, lineHeight: 1.8 }}>
                <li><strong style={{ fontWeight: 600 }}>Cache-Aside</strong>：读时回填，写时主动失效。实现简单，但存在短暂的脏读窗口。</li>
                <li><strong style={{ fontWeight: 600 }}>Read / Write Through</strong>：把缓存和数据源包在同一层接口内，写入顺序严格。</li>
                <li><strong style={{ fontWeight: 600 }}>延迟双删</strong>：在写完数据库后 <code style={{ background: 'var(--bg-secondary)', padding: '1px 5px', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 12 }}>500ms</code> 再失效一次，防止主从延迟。</li>
              </ol>
              <p style={{ margin: '0 0 16px' }}>
                你在《Redis 深入》里提到，<em>"强一致不是缓存该解决的问题"</em>——这和本文观点一致。
              </p>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 8 }}>3 个来源</div>
              <SourceCard file="性能优化实践.md" path="缓存策略" lines="L42–58" quote="Redis 的过期策略应当优先于业务兜底逻辑…"/>
              <SourceCard file="Redis 深入.md" path="一致性模型" lines="L104–119" quote="强一致不是缓存该解决的问题，而是事务层…"/>
              <SourceCard file="分布式系统 / 一致性.md" path="最终一致性" lines="L210–228" quote="延迟双删本质是给主从同步留出缓冲窗口…"/>
            </AiBubble>
            <UserBubble>那延迟双删的具体时间怎么定？</UserBubble>
            <AiBubble streaming>
              <RetrievalStatus stage="searching"/>
              <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>正在分析主从延迟相关段落…</p>
            </AiBubble>
          </div>
        </div>
        <InputBar/>
      </div>
    </div>
  </div>
);

const PageKnowledgeEmpty = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="knowledge"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree" tocDisabled={true}/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)' }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <div style={{ textAlign: 'center', maxWidth: 520 }}>
            <div style={{ opacity: 0.3, color: 'var(--accent)', display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
              <I.sparkles size={48}/>
            </div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 500, marginBottom: 8 }}>向你的知识库提问</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginBottom: 28, lineHeight: 1.7 }}>
              从 142 篇笔记、3,800 个段落中检索答案<br/>Notus 会给出引用来源，你可以追溯到原文
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {['我最近写了什么？', '关于缓存的三种策略有哪些差别？', '整理一下我对"慢"的思考', '读书笔记里提到过哪些决策模型？'].map((s, i) => (
                <button key={i} style={{
                  height: 30, padding: '0 14px', background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-full)',
                  fontSize: 'var(--text-xs)', color: 'var(--text-secondary)',
                }}>{s}</button>
              ))}
            </div>
          </div>
        </div>
        <InputBar placeholder="输入问题，从你的知识库中获取答案…"/>
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// /canvas — AI creation
// ════════════════════════════════════════════════════════════
const CanvasBlock = ({ idx, state, children, insertBefore }) => {
  const styles = {
    default: { borderLeft: '3px solid transparent', bg: 'transparent' },
    hover: { borderLeft: '3px solid var(--border-primary)', bg: 'transparent' },
    modified: { borderLeft: '3px solid var(--warning)', bg: 'var(--bg-diff-modified)' },
    processing: { borderLeft: '3px solid var(--accent)', bg: 'var(--accent-subtle)' },
    editing: { borderLeft: '3px solid var(--accent)', bg: 'transparent' },
  }[state];
  return (
    <>
      {insertBefore && (
        <div style={{
          position: 'relative', height: 10, margin: '0 16px',
          display: 'flex', alignItems: 'center',
        }}>
          <div style={{ flex: 1, height: 1, background: 'var(--accent)' }}/>
          <div style={{
            width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)',
            color: '#fff', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 6px', boxShadow: 'var(--shadow-sm)',
          }}><I.plus size={12}/></div>
          <div style={{ flex: 1, height: 1, background: 'var(--accent)' }}/>
        </div>
      )}
    <div style={{
      position: 'relative',
      padding: '12px 16px 12px 20px',
      borderLeft: styles.borderLeft,
      background: styles.bg,
      fontFamily: 'var(--font-editor)', fontSize: 'var(--text-base)', lineHeight: 1.75,
    }}>
      {(state === 'hover' || state === 'modified') && (
        <div style={{ position: 'absolute', left: 24, top: 10,
          display: 'flex', gap: 2, background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-sm)', padding: 2, zIndex: 2 }}>
          <button style={{ width: 24, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}><I.drag size={12}/></button>
          <button style={{ width: 24, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)' }}><I.edit size={12}/></button>
          <button style={{ width: 24, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)' }}><I.sparkles size={12}/></button>
        </div>
      )}
      {state === 'modified' && (
        <div style={{ position: 'absolute', right: 16, top: 12 }}>
          <Badge tone="warning">已修改</Badge>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>#{idx}</div>
      <div>{children}</div>
    </div>
    </>
  );
};

const OpPreview = () => (
  <div style={{
    background: 'var(--bg-ai-bubble)', border: '1px solid var(--accent-subtle)',
    borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', marginTop: 12,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10,
      fontSize: 'var(--text-sm)', fontWeight: 500 }}>
      <span style={{ color: 'var(--accent)' }}><I.robot size={14}/></span>
      <span>操作预览</span>
      <Badge tone="accent">#3</Badge>
    </div>
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.7, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ background: 'var(--bg-diff-remove)', padding: '4px 10px', color: 'var(--danger)', textDecoration: 'line-through' }}>
        - 慢不是效率的反面，它是另一种专注。
      </div>
      <div style={{ background: 'var(--bg-diff-add)', padding: '4px 10px', color: 'var(--success)' }}>
        + 慢从来不是效率的反义词。当我们允许自己在一件事上多停留几分钟，专注反而会悄悄重新回来。
      </div>
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
      <Btn variant="ghost" size="sm">取消</Btn>
      <Btn variant="primary" size="sm">应用修改</Btn>
    </div>
  </div>
);

const PageCanvasDefault = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="canvas" fileName="关于慢的意义 · 草稿"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree"/>
      {/* AI Panel */}
      <div style={{ width: 380, borderRight: '1px solid var(--border-primary)',
        background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 }}>风格来源</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button style={{ height: 26, padding: '0 10px', background: 'var(--bg-elevated)',
              border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)',
              fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              手动指定 <I.chevronDown size={10}/>
            </button>
            <Badge tone="accent">周末煮茶.md ✕</Badge>
            <Badge tone="accent">搬家第三周.md ✕</Badge>
          </div>
        </div>
        <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
          <UserBubble>把 #3 改得更柔软一些，加一点反思的语气</UserBubble>
          <AiBubble>
            <p style={{ margin: '0 0 8px' }}>我参考了《周末煮茶》的语气，把第 3 段重新组织了一下，偏日常叙述：</p>
            <OpPreview/>
          </AiBubble>
          <UserBubble>第 5 段引用那句我之前写过的，你记得吗？</UserBubble>
          <AiBubble streaming>
            <p style={{ margin: 0 }}>你在《搬家第三周》里写过"不急着填满"这一句</p>
          </AiBubble>
        </div>
        <InputBar placeholder="例如：让 @b2 更简洁…" model="Claude Opus"/>
      </div>
      {/* Canvas area */}
      <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 32px 80px' }}>
          <h1 style={{ fontFamily: 'var(--font-editor)', fontSize: 'var(--text-3xl)',
            fontWeight: 700, margin: '0 0 4px' }}>关于慢的意义</h1>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 24 }}>
            创作中 · 5 个块 · 基于 2 篇参考
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <CanvasBlock idx={1} state="default">
              窗外下着雨，煮茶的水刚开始冒泡。这是我这周第四次无所事事地坐在厨房里。
            </CanvasBlock>
            <CanvasBlock idx={2} state="hover">
              起初是愧疚的——有太多事情该做了。但坐久了，愧疚像水汽一样淡下去，留下一种久违的、几乎被遗忘的平静。
            </CanvasBlock>
            <CanvasBlock idx={3} state="modified" insertBefore>
              慢从来不是效率的反义词。当我们允许自己在一件事上多停留几分钟，专注反而会悄悄重新回来。
            </CanvasBlock>
            <CanvasBlock idx={4} state="processing">
              <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>AI 正在为你重写这一段…</span>
            </CanvasBlock>
            <CanvasBlock idx={5} state="default">
              我想起《搬家第三周》里自己写过的那句——"房子不必立刻住满，就像一段时间不必立刻填满"。
            </CanvasBlock>
            <div style={{ marginTop: 12, padding: 16, textAlign: 'center',
              border: '1px dashed var(--border-primary)', borderRadius: 'var(--radius-md)',
              color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>
              + 新建块
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
);

const PageCanvasEntry = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="canvas"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree"/>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)', overflow: 'auto' }}>
        <div style={{ maxWidth: 480, margin: '18vh auto 0', padding: '0 24px', width: '100%' }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <div style={{ display: 'inline-flex', color: 'var(--accent)', marginBottom: 16 }}>
              <I.sparkles size={40}/>
            </div>
            <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, letterSpacing: -0.3, marginBottom: 8 }}>开始一篇新的创作</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
              Notus 会参考你过往的笔记风格，生成大纲并逐段展开
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
            <div style={{ flex: 1, height: 48, padding: '0 16px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center',
              fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>
              缓存设计中的几个反直觉
              <span style={{ display: 'inline-block', width: 1.5, height: 18, background: 'var(--accent)',
                marginLeft: 3, animation: 'blink 1s step-end infinite' }}/>
            </div>
            <Btn variant="primary" size="lg" icon={<I.sparkles size={14}/>}>生成大纲</Btn>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase',
            letterSpacing: 0.5, padding: '0 4px', marginBottom: 6 }}>最近创作</div>
          <div>
            {[
              { title: '关于慢的意义', sub: '草稿 · 5 个块 · 2 小时前' },
              { title: 'CDN 边缘计算笔记', sub: '草稿 · 12 个块 · 昨天' },
              { title: '《设计心理学》读后', sub: '已完成 · 8 个块 · 3 天前' },
            ].map((r, i) => (
              <div key={i} style={{ height: 40, display: 'flex', alignItems: 'center',
                padding: '0 12px', gap: 10, borderRadius: 'var(--radius-md)',
                background: i === 0 ? 'var(--bg-hover)' : 'transparent' }}>
                <I.file size={14}/>
                <span style={{ fontSize: 'var(--text-sm)' }}>{r.title}</span>
                <span style={{ flex: 1 }}/>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{r.sub}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </div>
);

Object.assign(window, {
  SourceCard, UserBubble, AiBubble, InputBar, CanvasBlock, OpPreview,
  PageKnowledgeDefault, PageKnowledgeEmpty, PageCanvasDefault, PageCanvasEntry,
});
