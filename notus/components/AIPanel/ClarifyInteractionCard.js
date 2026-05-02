import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icons } from '../ui/Icons';

const STATUS_META = {
  pending: {
    label: '待确认',
    tone: 'accent',
    description: '补齐这些信息后，系统会直接继续生成预览。',
  },
  stale: {
    label: '已失效',
    tone: 'default',
    description: '文章内容已经变化，这张卡片不能直接继续执行了。',
  },
  failed: {
    label: '生成失败',
    tone: 'warning',
    description: '你的回答已经记录，但上一次自动续跑没有成功。',
  },
};

function buildInitialAnswers(interaction) {
  const responseAnswers = interaction?.response?.answers && typeof interaction.response.answers === 'object'
    ? interaction.response.answers
    : {};
  const prefilledAnswers = interaction?.payload?.prefilled_answers && typeof interaction.payload.prefilled_answers === 'object'
    ? interaction.payload.prefilled_answers
    : {};

  return (Array.isArray(interaction?.payload?.questions) ? interaction.payload.questions : []).reduce((acc, question) => {
    const current = responseAnswers[question.id] || prefilledAnswers[question.id] || null;
    acc[question.id] = {
      optionId: current?.value || '',
      optionIds: Array.isArray(current?.option_ids) ? current.option_ids : [],
      text: current?.text || current?.custom_text || '',
      customText: current?.text || current?.custom_text || '',
    };
    return acc;
  }, {});
}

function cardGridColumns(isWide) {
  return isWide ? 'repeat(2, minmax(0, 1fr))' : '1fr';
}

function renderPrefilledLabel(slot) {
  if (slot === 'primary_intent') return '已理解的主意图';
  if (slot === 'source_content_ref') return '已理解的内容来源';
  if (slot === 'target_location') return '已理解的位置';
  if (slot === 'write_mode') return '已理解的写入方式';
  return '已理解';
}

function OptionButton({ active, label, description, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        minHeight: 68,
        padding: '12px 14px',
        borderRadius: 14,
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 32%, var(--border-primary))' : 'var(--border-subtle)'}`,
        background: active ? 'var(--accent-subtle)' : 'var(--bg-primary)',
        color: active ? 'var(--accent)' : 'var(--text-primary)',
        textAlign: 'left',
        display: 'grid',
        gap: 4,
        cursor: 'pointer',
        transition: 'background var(--transition-fast), border-color var(--transition-fast)',
      }}
    >
      <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 12, color: active ? 'var(--accent)' : 'var(--text-secondary)', lineHeight: 1.6 }}>
        {description}
      </span>
    </button>
  );
}

export function ClarifyInteractionCard({
  interaction,
  onSubmit,
  onRetry,
  submitting = false,
  showRetry = false,
}) {
  const [answers, setAnswers] = useState(() => buildInitialAnswers(interaction));
  const [isWide, setIsWide] = useState(false);

  useEffect(() => {
    setAnswers(buildInitialAnswers(interaction));
  }, [interaction]);

  useEffect(() => {
    const sync = () => setIsWide(typeof window !== 'undefined' && window.innerWidth >= 960);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const statusMeta = STATUS_META[interaction?.status] || STATUS_META.pending;
  const questions = Array.isArray(interaction?.payload?.questions) ? interaction.payload.questions : [];
  const prefilledAnswers = interaction?.payload?.prefilled_answers && typeof interaction.payload.prefilled_answers === 'object'
    ? interaction.payload.prefilled_answers
    : {};
  const canSubmit = interaction?.status === 'pending' && questions.every((question) => {
    if (!question.required) return true;
    const current = answers[question.id] || {};
    if (question.type === 'text_input') return Boolean(String(current.text || '').trim());
    return Boolean(current.optionId || String(current.customText || '').trim());
  });

  const missingSlots = useMemo(() => {
    return Array.isArray(interaction?.response?.missing_slots) ? interaction.response.missing_slots : [];
  }, [interaction]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit || submitting) return;
        const payload = Object.fromEntries(questions.map((question) => {
          const current = answers[question.id] || {};
          return [question.id, {
            option_id: current.optionId || '',
            option_ids: current.optionIds || [],
            text: current.text || '',
            custom_text: current.customText || '',
          }];
        }));
        onSubmit?.(interaction, payload);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.target?.blur?.();
        }
      }}
      style={{
        background: 'var(--bg-ai-bubble)',
        border: '1px solid var(--accent-subtle)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        marginTop: 12,
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}><Icons.sparkles size={14} /></span>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {interaction?.payload?.title || '继续执行前还需要确认'}
        </span>
        <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
      </div>

      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
        {interaction?.payload?.description || statusMeta.description}
      </div>

      {interaction?.payload?.decision_summary ? (
        <div style={{
          display: 'grid',
          gap: 4,
          padding: '10px 12px',
          borderRadius: 12,
          background: 'var(--bg-primary)',
          border: '1px solid var(--border-subtle)',
        }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>当前理解</span>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', lineHeight: 1.7 }}>
            {interaction.payload.decision_summary}
          </span>
        </div>
      ) : null}

      {Object.entries(prefilledAnswers).length > 0 && (
        <div style={{ display: 'grid', gap: 8 }}>
          {Object.entries(prefilledAnswers).map(([slot, value]) => (
            <div
              key={slot}
              style={{
                display: 'grid',
                gap: 4,
                padding: '10px 12px',
                borderRadius: 12,
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{renderPrefilledLabel(slot)}</span>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
                {value?.label || value?.text || value?.value || '已理解'}
              </span>
            </div>
          ))}
        </div>
      )}

      {questions.map((question) => {
        const current = answers[question.id] || {};
        const unresolved = missingSlots.includes(question.id);
        return (
          <div key={question.id} style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {question.label}
                </span>
                {question.required ? <Badge tone="default">必填</Badge> : null}
                {unresolved ? <Badge tone="warning">待补充</Badge> : null}
              </div>
              {question.description ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  {question.description}
                </div>
              ) : null}
            </div>

            {question.type === 'text_input' ? (
              <input
                value={current.text || ''}
                disabled={interaction?.status !== 'pending'}
                onChange={(event) => {
                  const nextText = event.target.value;
                  setAnswers((prev) => ({
                    ...prev,
                    [question.id]: {
                      ...prev[question.id],
                      text: nextText,
                      customText: nextText,
                    },
                  }));
                }}
                placeholder={question.custom_placeholder || '请输入'}
                style={{
                  width: '100%',
                  minHeight: 40,
                  padding: '0 12px',
                  borderRadius: 12,
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-primary)',
                  color: 'var(--text-primary)',
                }}
              />
            ) : (
              <>
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: cardGridColumns(isWide) }}>
                  {(question.options || []).map((option) => (
                    <OptionButton
                      key={option.id}
                      active={current.optionId === option.id || (current.optionIds || []).includes(option.id)}
                      label={option.label}
                      description={option.description}
                      onClick={() => {
                        setAnswers((prev) => ({
                          ...prev,
                          [question.id]: {
                            ...prev[question.id],
                            optionId: option.id,
                            optionIds: question.type === 'multi_select'
                              ? Array.from(new Set([...(prev[question.id]?.optionIds || []), option.id]))
                              : [option.id],
                          },
                        }));
                      }}
                    />
                  ))}
                </div>
                {question.allow_custom && (
                  <input
                    value={current.customText || ''}
                    disabled={interaction?.status !== 'pending'}
                    onChange={(event) => {
                      const nextText = event.target.value;
                      setAnswers((prev) => ({
                        ...prev,
                        [question.id]: {
                          ...prev[question.id],
                          customText: nextText,
                          ...(question.type === 'single_select' && !prev[question.id]?.optionId
                            ? { optionId: nextText ? 'custom' : '' }
                            : {}),
                        },
                      }));
                    }}
                    placeholder={question.custom_placeholder || '补充说明'}
                    style={{
                      width: '100%',
                      minHeight: 40,
                      padding: '0 12px',
                      borderRadius: 12,
                      border: '1px solid var(--border-primary)',
                      background: 'var(--bg-primary)',
                      color: 'var(--text-primary)',
                    }}
                  />
                )}
              </>
            )}
          </div>
        );
      })}

      {interaction?.status === 'failed' && !showRetry ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          你的回答已经保存。请使用下方的“重试生成预览”继续，不需要重新回答。
        </div>
      ) : null}

      <div style={{
        display: 'flex',
        gap: 8,
        justifyContent: 'flex-end',
        flexDirection: isWide ? 'row' : 'column',
      }}>
        {showRetry && interaction?.status === 'failed' ? (
          <Button type="button" variant="primary" size="sm" onClick={() => onRetry?.(interaction)}>
            重试生成预览
          </Button>
        ) : null}
        {interaction?.status === 'pending' ? (
          <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} loading={submitting}>
            确认并继续
          </Button>
        ) : null}
      </div>
    </form>
  );
}
