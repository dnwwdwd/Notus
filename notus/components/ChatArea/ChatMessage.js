// Chat message components: UserBubble, AiBubble, RetrievalStatus
import { Icons } from '../ui/Icons';
import { StreamingText } from '../ui/StreamingText';
import { SourceCard } from '../ui/SourceCard';

export const UserBubble = ({ children }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0' }}>
    <div style={{
      maxWidth: '75%',
      background: 'var(--bg-user-bubble)',
      padding: '10px 14px',
      borderRadius: 'var(--radius-lg)',
      fontSize: 'var(--text-sm)',
      lineHeight: 1.6,
    }}>
      {children}
    </div>
  </div>
);

export const RetrievalStatus = ({ stage, sources = 3 }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '8px 0 12px',
    padding: '8px 12px',
    background: 'var(--accent-subtle)',
    border: '1px solid var(--accent-subtle)',
    borderRadius: 'var(--radius-md)',
    fontSize: 12,
    color: 'var(--accent)',
  }}>
    {stage === 'searching' && (
      <><Icons.search size={13} /><span>正在从笔记中检索相关段落…</span></>
    )}
    {stage === 'found' && (
      <><Icons.check size={13} /><span>找到 {sources} 篇相关笔记 · 正在组织答案</span></>
    )}
    {stage === 'insufficient' && (
      <><Icons.warn size={13} /><span>找到少量相关内容，但证据不足 · 只会给出保守结论</span></>
    )}
  </div>
);

export const AiBubble = ({ text, streaming, citations, onCitationClick, citationSelection, messageId, children }) => (
  <div style={{ margin: '16px 0' }}>
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 8,
      color: 'var(--text-secondary)',
      fontSize: 'var(--text-sm)',
    }}>
      <span style={{ color: 'var(--accent)' }}><Icons.sparkles size={13} /></span>
      <span>Notus</span>
    </div>
    {text !== undefined
      ? <StreamingText text={text} streaming={streaming} />
      : <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>{children}</div>}
    {text !== undefined && children}
    {citations && citations.length > 0 && (
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 8 }}>
          {citations.length} 个来源
        </div>
        {citations.map((c, i) => (
          <SourceCard
            key={i}
            file={c.file}
            path={c.path}
            quote={c.quote}
            lines={c.lines}
            imageProxyUrl={c.image_proxy_url}
            imageAltText={c.image_alt_text}
            imageCaption={c.image_caption}
            selected={citationSelection?.messageId === messageId && citationSelection?.citationIndex === i}
            onClick={() => onCitationClick?.(c, { messageId, citationIndex: i })}
          />
        ))}
      </div>
    )}
  </div>
);
