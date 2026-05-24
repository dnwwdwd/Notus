// Chat message components: UserBubble, AiBubble, RetrievalStatus
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '../ui/Icons';
import { StreamingText } from '../ui/StreamingText';
import { SourceCard } from '../ui/SourceCard';
import { getVisibleDocumentLabel } from '../../lib/documentLabels';

const ANSWER_MODE_META = {
  clarify_needed: { label: '需澄清', tone: 'muted' },
  weak_evidence: { label: '证据偏弱', tone: 'warn' },
  conflicting_evidence: { label: '证据冲突', tone: 'warn' },
  no_evidence: { label: '未找到证据', tone: 'muted' },
};

function answerModeBadgeStyle(tone = 'muted') {
  if (tone === 'warn') {
    return {
      background: 'rgba(196, 120, 26, 0.12)',
      color: 'var(--warning, #a65d00)',
      border: '1px solid rgba(196, 120, 26, 0.18)',
    };
  }

  return {
    background: 'var(--bg-elevated)',
    color: 'var(--text-tertiary)',
    border: '1px solid var(--border-subtle)',
  };
}

function TypingDots() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        color: 'var(--accent)',
      }}
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'currentColor',
            opacity: 0.26,
            animation: `notusTypingPulse 1.1s ease-in-out ${index * 0.14}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

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

export const RetrievalStatus = ({ stage, sources = 0, embedded = false }) => (
  <div style={{
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: embedded ? 0 : '8px 0 12px',
    padding: embedded ? '10px 12px' : '8px 12px',
    background: embedded
      ? 'color-mix(in srgb, var(--accent-subtle) 52%, var(--bg-primary))'
      : 'var(--accent-subtle)',
    border: `1px solid ${embedded ? 'color-mix(in srgb, var(--accent) 16%, var(--border-primary))' : 'var(--accent-subtle)'}`,
    borderRadius: embedded ? 14 : 'var(--radius-md)',
    fontSize: 12,
    color: embedded ? 'var(--text-secondary)' : 'var(--accent)',
  }}>
    {stage === 'searching' && (
      <><TypingDots /><span>正在从笔记中检索相关段落…</span></>
    )}
    {stage === 'found' && (
      <><Icons.check size={13} /><span>找到 {sources} 组相关证据 · 正在组织答案</span></>
    )}
    {stage === 'insufficient' && (
      <><Icons.warn size={13} /><span>找到 {sources} 组相关证据，但证据还不够强 · 只会给出保守结论</span></>
    )}
  </div>
);

function WorkspaceDocumentSummary({ documents = [], stats = null }) {
  const visibleDocuments = Array.isArray(documents) ? documents.filter(Boolean).slice(0, 6) : [];
  const documentCount = Number(stats?.document_count || visibleDocuments.length || 0);
  if (documentCount <= 0) return null;
  const fullCount = Number(stats?.full_document_count || 0);
  const truncatedCount = Number(stats?.truncated_document_count || 0);
  const staleCount = Number(stats?.stale_document_count || 0);

  return (
    <div style={{
      marginTop: 12,
      paddingTop: 10,
      borderTop: '1px solid var(--border-subtle)',
      color: 'var(--text-tertiary)',
      fontSize: 12,
      lineHeight: 1.6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Icons.file size={13} />
        <span>
          本次读取 {documentCount} 篇 Markdown
          {fullCount > 0 ? ` · 完整 ${fullCount}` : ''}
          {truncatedCount > 0 ? ` · 节选 ${truncatedCount}` : ''}
          {staleCount > 0 ? ` · ${staleCount} 篇索引待更新` : ''}
        </span>
      </div>
      {visibleDocuments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {visibleDocuments.map((doc) => {
            const label = getVisibleDocumentLabel(doc, '未命名文档');
            return (
              <span
                key={`${doc.id || doc.path}-${doc.path || doc.title}`}
                title={doc.path || label}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  maxWidth: 220,
                  padding: '2px 7px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

function buildLoadingSteps(retrievalStage = null) {
  if (!retrievalStage?.stage) {
    return ['正在生成…'];
  }

  const sources = Number(retrievalStage.sources || 0);
  if (retrievalStage.stage === 'searching') {
    return ['正在分析问题', '正在从笔记中检索相关段落'];
  }
  if (retrievalStage.stage === 'found') {
    return [
      sources > 0 ? `找到 ${sources} 组相关证据` : '已找到相关证据',
      '正在组织答案',
    ];
  }
  if (retrievalStage.stage === 'insufficient') {
    return [
      sources > 0 ? `找到 ${sources} 组相关证据` : '证据还不够强',
      '正在整理保守回答',
    ];
  }
  return ['正在生成…'];
}

function LoadingBubblePlaceholder({ retrievalStage = null }) {
  const steps = useMemo(() => buildLoadingSteps(retrievalStage), [retrievalStage]);
  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = steps[stepIndex % steps.length] || steps[0] || '正在生成…';

  useEffect(() => {
    setStepIndex(0);
  }, [steps]);

  useEffect(() => {
    if (steps.length <= 1) return undefined;
    const timer = window.setInterval(() => {
      setStepIndex((prev) => (prev + 1) % steps.length);
    }, 1100);
    return () => window.clearInterval(timer);
  }, [steps]);

  return (
    <div
      style={{
        minHeight: 40,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderRadius: 16,
          background: 'color-mix(in srgb, var(--accent-subtle) 58%, var(--bg-elevated))',
          color: 'var(--text-secondary)',
          fontSize: 12,
        }}
      >
        <TypingDots />
        <span>{currentStep}</span>
      </div>
    </div>
  );
}

export const AiBubble = ({
  text,
  streaming,
  citations,
  sourceCount,
  retrievalStage,
  assistantNote,
  documents,
  documentStats,
  onCitationClick,
  citationSelection,
  messageId,
  answerMode,
  children,
}) => {
  const modeMeta = ANSWER_MODE_META[answerMode] || null;
  const hasStreamText = text !== undefined && String(text || '').trim().length > 0;
  const showLoadingBubble = Boolean(streaming && !hasStreamText);
  const hasBodyChildren = text !== undefined || children || retrievalStage || assistantNote || (citations && citations.length > 0) || (documents && documents.length > 0);

  return (
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
      {modeMeta && (
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '2px 8px',
          borderRadius: 999,
          fontSize: 11,
          lineHeight: 1.2,
          ...answerModeBadgeStyle(modeMeta.tone),
        }}>
          {modeMeta.label}
        </span>
      )}
    </div>
    {hasBodyChildren ? (
      <div style={{
        padding: '14px 16px',
        borderRadius: 18,
        background: 'var(--bg-ai-bubble)',
        display: 'grid',
        gap: 12,
      }}>
        {retrievalStage && !showLoadingBubble ? (
          <RetrievalStatus stage={retrievalStage.stage} sources={retrievalStage.sources} embedded />
        ) : null}
        {text !== undefined
          ? (showLoadingBubble ? <LoadingBubblePlaceholder retrievalStage={retrievalStage} /> : <StreamingText text={text} streaming={streaming} />)
          : <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7 }}>{children}</div>}
        {text !== undefined && children}
        {assistantNote ? (
          <div style={{
            paddingTop: 2,
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.7,
          }}>
            {assistantNote}
          </div>
        ) : null}
        <WorkspaceDocumentSummary documents={documents} stats={documentStats} />
        {citations && citations.length > 0 && (
          <div style={{ display: 'grid', gap: 8 }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
              {(Number(sourceCount) > 0 ? Number(sourceCount) : citations.length)} 个来源
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
    ) : null}
  </div>
  );
};
