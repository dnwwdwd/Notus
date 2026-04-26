// pages-locked.jsx — /knowledge & /canvas locked states + reindex flow

// ════════════════════════════════════════════════════════════
// Lock overlay — shared blurred placeholder content + center CTA card
// ════════════════════════════════════════════════════════════
const LockedShade = ({
  title,
  body,
  missing = ['LLM', 'Embedding'],
  ghost,
}) => (
  <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
    {/* faded ghost content underneath */}
    <div style={{
      position: 'absolute', inset: 0, filter: 'blur(3px) saturate(0.6)',
      opacity: 0.45, pointerEvents: 'none',
    }}>
      {ghost}
    </div>
    {/* dim overlay */}
    <div style={{
      position: 'absolute', inset: 0,
      background: 'linear-gradient(180deg, rgba(250,247,242,0.6) 0%, rgba(250,247,242,0.92) 60%)',
    }}/>
    {/* lock card */}
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{
        maxWidth: 460, width: '100%', textAlign: 'center', padding: 32,
        background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-lg)',
      }}>
        <div style={{
          width: 56, height: 56, margin: '0 auto 18px', borderRadius: '50%',
          background: 'var(--accent-subtle)', color: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <I.lock size={26}/>
        </div>
        <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
          lineHeight: 1.7, marginBottom: 20 }}>{body}</div>

        {/* Missing checklist */}
        <div style={{
          textAlign: 'left', background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
          padding: '10px 14px', marginBottom: 20,
        }}>
          {[
            { id: 'Embedding', label: 'Embedding 模型', hint: '用于检索你的笔记' },
            { id: 'LLM', label: 'LLM 模型', hint: '用于生成回答与创作' },
          ].map(it => {
            const ok = !missing.includes(it.id);
            return (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: ok ? 'var(--success)' : 'var(--bg-active)',
                  color: ok ? '#fff' : 'var(--text-tertiary)',
                }}>
                  {ok ? <I.check size={11}/> : <I.x size={11}/>}
                </span>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>{it.label}</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>· {it.hint}</span>
                <div style={{ flex: 1 }}/>
                <span style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 3, fontWeight: 500,
                  background: ok ? 'var(--success-subtle, #DCF5E3)' : 'var(--warning-subtle, #FEF3C7)',
                  color: ok ? 'var(--success)' : 'var(--warning)',
                }}>{ok ? '已配置' : '未配置'}</span>
              </div>
            );
          })}
        </div>

        <Btn variant="primary" style={{ width: '100%', height: 38 }}>
          <I.settings size={14}/> 前往设置配置模型
        </Btn>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 12 }}>
          配置仅保存在本地 · 你随时可以更换提供商
        </div>
      </div>
    </div>
  </div>
);

// Faded ghost content for /knowledge
const KnowledgeGhost = () => (
  <div style={{ padding: '24px 40px' }}>
    <div style={{ maxWidth: 680, margin: '0 auto' }}>
      <div style={{
        background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 12, marginLeft: 80,
      }}>
        <div style={{ height: 12, width: '60%', background: 'var(--bg-active)', borderRadius: 3 }}/>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ height: 14, width: '90%', background: 'var(--bg-active)', borderRadius: 3, marginBottom: 8 }}/>
        <div style={{ height: 14, width: '75%', background: 'var(--bg-active)', borderRadius: 3, marginBottom: 8 }}/>
        <div style={{ height: 14, width: '85%', background: 'var(--bg-active)', borderRadius: 3 }}/>
      </div>
      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 8 }}>
        <div style={{ height: 12, width: '40%', background: 'var(--bg-active)', borderRadius: 3 }}/>
      </div>
      <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)', padding: 12 }}>
        <div style={{ height: 12, width: '35%', background: 'var(--bg-active)', borderRadius: 3 }}/>
      </div>
    </div>
  </div>
);

// Faded ghost content for /canvas
const CanvasGhost = () => (
  <div style={{ display: 'flex', height: '100%' }}>
    <div style={{ flex: 1, padding: '40px 80px' }}>
      <div style={{ height: 32, width: '40%', background: 'var(--bg-active)', borderRadius: 4, marginBottom: 24 }}/>
      <div style={{ height: 14, width: '92%', background: 'var(--bg-active)', borderRadius: 3, marginBottom: 8 }}/>
      <div style={{ height: 14, width: '86%', background: 'var(--bg-active)', borderRadius: 3, marginBottom: 8 }}/>
      <div style={{ height: 14, width: '78%', background: 'var(--bg-active)', borderRadius: 3, marginBottom: 24 }}/>
      <div style={{ height: 14, width: '90%', background: 'var(--bg-active)', borderRadius: 3, marginBottom: 8 }}/>
      <div style={{ height: 14, width: '74%', background: 'var(--bg-active)', borderRadius: 3 }}/>
    </div>
    <div style={{ width: 320, borderLeft: '1px solid var(--border-subtle)',
      background: 'var(--bg-elevated)', padding: 20 }}>
      <div style={{ height: 12, width: '50%', background: 'var(--bg-active)', borderRadius: 3, marginBottom: 16 }}/>
      <div style={{ height: 80, background: 'var(--bg-active)', borderRadius: 6, marginBottom: 12 }}/>
      <div style={{ height: 80, background: 'var(--bg-active)', borderRadius: 6 }}/>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// /knowledge — locked
// ════════════════════════════════════════════════════════════
const PageKnowledgeLocked = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="knowledge"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree" tocDisabled={true}/>
      <div style={{ flex: 1, position: 'relative', background: 'var(--bg-primary)' }}>
        <LockedShade
          title="知识库需要 AI 模型才能工作"
          body="问答依赖 Embedding 进行检索，依赖 LLM 生成答案。完成配置后，你可以直接向 142 篇笔记提问。"
          missing={['LLM']}
          ghost={<KnowledgeGhost/>}
        />
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// /canvas — locked
// ════════════════════════════════════════════════════════════
const PageCanvasLocked = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column' }}>
    <TopBar active="canvas"/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Sidebar tab="tree"/>
      <div style={{ flex: 1, position: 'relative', background: 'var(--bg-primary)' }}>
        <LockedShade
          title="创作功能需要 AI 模型才能启用"
          body="创作页基于你的写作风格生成内容，需要 LLM 进行扩写、润色和续写。"
          missing={['LLM', 'Embedding']}
          ghost={<CanvasGhost/>}
        />
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// Embedding-changed confirmation Dialog (inside /settings)
// ════════════════════════════════════════════════════════════
const EmbeddingChangeDialog = () => (
  <div style={{
    position: 'absolute', inset: 0, background: 'rgba(40,30,20,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
  }}>
    <div style={{
      width: 480, background: 'var(--bg-elevated)',
      border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-xl)',
      boxShadow: 'var(--shadow-xl, 0 20px 50px rgba(0,0,0,.18))', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '20px 24px 12px', display: 'flex', gap: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
          background: 'var(--warning-subtle, #FEF3C7)', color: 'var(--warning)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <I.warn size={18}/>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 4 }}>
            更换 Embedding 模型将重建索引
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            不同模型的向量空间不兼容，旧索引将被丢弃，所有笔记需要重新嵌入。
          </div>
        </div>
      </div>

      {/* Diff */}
      <div style={{ padding: '0 24px 16px' }}>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ width: 10, height: 10, background: 'var(--text-tertiary)', borderRadius: 2 }}/>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>当前</span>
            <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)' }}>text-embedding-3-small · 1536 维</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, background: 'var(--accent)', borderRadius: 2 }}/>
            <span style={{ fontSize: 11, color: 'var(--accent)' }}>新</span>
            <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>text-embedding-3-large · 3072 维</span>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
          {[
            { n: '142', l: '笔记数' },
            { n: '~3 分钟', l: '预计耗时' },
            { n: '~$0.18', l: '预估成本' },
          ].map((s, i) => (
            <div key={i} style={{
              padding: 10, background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, fontFamily: 'var(--font-editor)' }}>{s.n}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.l}</div>
            </div>
          ))}
        </div>

        <div style={{
          fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7,
          padding: '8px 12px', background: 'var(--warning-subtle, #FEF3C7)',
          border: '1px solid var(--warning)', borderRadius: 'var(--radius-sm)',
          display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }}><I.info size={12}/></span>
          <span>重建过程中知识库与创作功能将不可用，请保持应用运行。重建失败可回滚到当前模型。</span>
        </div>
      </div>

      {/* Actions */}
      <div style={{
        padding: '14px 20px', background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex', justifyContent: 'flex-end', gap: 8,
      }}>
        <Btn variant="ghost">取消</Btn>
        <Btn variant="primary">确认并开始重建</Btn>
      </div>
    </div>
  </div>
);

const PageSettingsConfirmRebuild = () => (
  <div className="nt" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
    <TopBar active=""/>
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <SettingsNav active="model"/>
      <div className="nt-scroll" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-primary)', position: 'relative' }}>
        <div style={{ maxWidth: 640, margin: '0 auto', padding: 32, opacity: 0.4, pointerEvents: 'none' }}>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 6 }}>模型配置</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 28 }}>
            选择内置提供商，或自定义兼容 OpenAI API 的服务。
          </div>
          <div style={{ height: 200, background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-xl)' }}/>
        </div>
        <EmbeddingChangeDialog/>
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// Reindex in progress — full-screen blocking modal
// ════════════════════════════════════════════════════════════
const PageReindexing = () => (
  <div className="nt" style={{
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-primary)',
  }}>
    <div style={{ maxWidth: 540, width: '100%', padding: 32 }}>
      {/* Logo + lock badge */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 28, position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <NotusLogo size={56}/>
          <div style={{
            position: 'absolute', right: -6, bottom: -6,
            width: 26, height: 26, borderRadius: '50%',
            background: 'var(--bg-elevated)',
            border: '2px solid var(--bg-primary)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--accent)',
          }}>
            <Spinner size={14}/>
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 8 }}>正在重建索引</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          Embedding 模型已变更为 <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--text-primary)' }}>text-embedding-3-large</span><br/>
          为了保证检索质量，所有笔记将重新嵌入。
        </div>
      </div>

      {/* Progress card */}
      <div style={{
        background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-xl)', padding: 24, marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>87 / 142 篇</div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>61% · 约剩 1 分 12 秒</div>
        </div>
        <div style={{ height: 6, background: 'var(--bg-active)', borderRadius: 'var(--radius-full)',
          overflow: 'hidden', marginBottom: 14 }}>
          <div style={{ width: '61%', height: '100%', background: 'var(--accent)' }}/>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono)', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
        }}>
          <Spinner size={10}/>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            → 技术文章 / 分布式系统 / 一致性模型.md
          </span>
        </div>
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '16px 0' }}/>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          {[
            { n: '2,418', l: '已生成向量' },
            { n: '87', l: '已处理' },
            { n: '0', l: '失败' },
          ].map((s, i) => (
            <div key={i}>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, fontFamily: 'var(--font-editor)' }}>{s.n}</div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Cannot interrupt notice */}
      <div style={{
        display: 'flex', gap: 10, alignItems: 'flex-start',
        padding: '12px 14px', background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
        fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7,
      }}>
        <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }}><I.lock size={13}/></span>
        <div>
          <div style={{ fontWeight: 500, color: 'var(--text-primary)', marginBottom: 2 }}>
            过程不可中断
          </div>
          中断会导致索引损坏，需要从头开始。请勿关闭应用或切换网络。文件编辑、知识库、创作功能在重建期间均不可用。
        </div>
      </div>

      {/* Disabled exit */}
      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <button disabled style={{
          height: 32, padding: '0 16px', fontSize: 'var(--text-sm)',
          background: 'transparent', color: 'var(--text-tertiary)',
          border: 'none', cursor: 'not-allowed',
        }}>
          重建完成后将自动返回
        </button>
      </div>
    </div>
  </div>
);

// ════════════════════════════════════════════════════════════
// Reindex failed — allow rollback or retry
// ════════════════════════════════════════════════════════════
const PageReindexFailed = () => (
  <div className="nt" style={{
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-primary)',
  }}>
    <div style={{ maxWidth: 540, width: '100%', padding: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%',
          background: 'var(--danger-subtle, #FEE4E2)', color: 'var(--danger)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <I.warn size={28}/>
        </div>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600, marginBottom: 8 }}>重建索引失败</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          已处理 <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>87 / 142</strong> 篇时出错。<br/>
          你可以重试，或回滚到此前的 Embedding 模型。
        </div>
      </div>

      {/* Error detail */}
      <div style={{
        background: 'var(--bg-elevated)', border: '1px solid var(--danger)',
        borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3, fontWeight: 500,
            background: 'var(--danger-subtle, #FEE4E2)', color: 'var(--danger)' }}>API 错误</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>HTTP 429</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>· 23:14:08</span>
        </div>
        <div style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)', marginBottom: 8, lineHeight: 1.6 }}>
          Rate limit exceeded for text-embedding-3-large.
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          已嵌入的 87 篇笔记已暂存，重试时会从断点继续，不会重复消耗 API 配额。
        </div>
      </div>

      {/* Status row */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20,
      }}>
        <div style={{ padding: 12, background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>当前状态</div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--warning)' }}>
            索引不完整 · 知识库暂不可用
          </div>
        </div>
        <div style={{ padding: 12, background: 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>建议操作</div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>
            等待 60 秒后重试
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Btn variant="primary" style={{ width: '100%', height: 38 }}>
          <I.redo size={14}/> 从断点继续重试
        </Btn>
        <Btn variant="secondary" style={{ width: '100%', height: 38 }}>
          回滚到 text-embedding-3-small
        </Btn>
        <Btn variant="ghost" style={{ width: '100%', height: 32 }}>
          查看完整错误日志
        </Btn>
      </div>

      <div style={{
        marginTop: 20, padding: '10px 14px',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)', fontSize: 11,
        color: 'var(--text-secondary)', lineHeight: 1.7,
      }}>
        <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>提示：</strong>
        若重试持续失败，建议先回滚保证知识库可用，再排查 API Key 或网络问题。
      </div>
    </div>
  </div>
);

Object.assign(window, {
  PageKnowledgeLocked, PageCanvasLocked,
  PageSettingsConfirmRebuild, PageReindexing, PageReindexFailed,
});
