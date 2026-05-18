import { useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Icons } from '../ui/Icons';

const STATUS_META = {
  pending: {
    label: '待确认',
    tone: 'accent',
  },
  stale: {
    label: '已失效',
    tone: 'default',
  },
  failed: {
    label: '可重试',
    tone: 'warning',
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

function OptionButton({ active, label, description, disabled, onClick, onMouseEnter }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        width: '100%',
        minHeight: description ? 58 : 44,
        padding: '10px 12px',
        borderRadius: 10,
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 34%, var(--border-primary))' : 'var(--border-subtle)'}`,
        background: active ? 'color-mix(in srgb, var(--accent-subtle) 76%, var(--bg-primary))' : 'var(--bg-primary)',
        color: active ? 'var(--accent)' : 'var(--text-primary)',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
        opacity: disabled ? 0.72 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          marginTop: 1,
          flexShrink: 0,
          border: `1px solid ${active ? 'var(--accent)' : 'var(--border-primary)'}`,
          background: active ? 'var(--accent)' : 'transparent',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {active ? <Icons.check size={12} /> : null}
      </span>
      <span style={{ minWidth: 0, display: 'grid', gap: description ? 3 : 0 }}>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, lineHeight: 1.45 }}>{label}</span>
        {description ? (
          <span style={{ fontSize: 12, color: active ? 'var(--accent)' : 'var(--text-secondary)', lineHeight: 1.55 }}>
            {description}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function QuestionStatus({ index, answered }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        flexShrink: 0,
        background: answered ? 'var(--accent)' : 'var(--bg-elevated)',
        color: answered ? '#fff' : 'var(--text-tertiary)',
        border: `1px solid ${answered ? 'var(--accent)' : 'var(--border-subtle)'}`,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 700,
        marginTop: 1,
      }}
    >
      {answered ? <Icons.check size={13} /> : index + 1}
    </span>
  );
}

function TextAnswerInput({ value, disabled, label, placeholder, onChange }) {
  return (
    <input
      value={value || ''}
      disabled={disabled}
      aria-label={label}
      autoComplete="off"
      onChange={(event) => onChange?.(event.target.value)}
      placeholder={placeholder || '自定义答案'}
      style={{
        width: '100%',
        minHeight: 42,
        padding: '0 12px',
        borderRadius: 10,
        border: '1px solid var(--border-primary)',
        background: 'var(--bg-primary)',
        color: 'var(--text-primary)',
      }}
    />
  );
}

function questionAnswered(question, current = {}) {
  if (question.type === 'text_input') return Boolean(String(current.text || '').trim());
  return Boolean(String(current.customText || '').trim() || current.optionId);
}

function QuestionRow({ question, index, current, disabled, onAnswer }) {
  const answered = questionAnswered(question, current);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '22px minmax(0, 1fr)',
        gap: 10,
        padding: '12px 0',
        borderTop: index === 0 ? 'none' : '1px solid var(--border-subtle)',
      }}
    >
      <QuestionStatus index={index} answered={answered} />
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)', minWidth: 0 }}>
            {question.label}
          </div>
          {question.required ? (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
              必填
            </span>
          ) : null}
        </div>

        {question.type === 'text_input' ? (
          <TextAnswerInput
            value={current.text || ''}
            disabled={disabled}
            label={question.label}
            placeholder={question.custom_placeholder || '自定义答案'}
            onChange={(nextText) => {
              onAnswer({
                text: nextText,
                customText: nextText,
              });
            }}
          />
        ) : (
          <>
            <div style={{ display: 'grid', gap: 6 }}>
              {(question.options || []).map((option) => {
                const active = current.optionId === option.id || (current.optionIds || []).includes(option.id);
                return (
                  <OptionButton
                    key={option.id}
                    active={active}
                    label={option.label}
                    description={option.description}
                    disabled={disabled}
                    onClick={() => {
                      onAnswer({
                        optionId: option.id,
                        optionIds: question.type === 'multi_select'
                          ? Array.from(new Set([...(current.optionIds || []), option.id]))
                          : [option.id],
                        customText: '',
                      });
                    }}
                  />
                );
              })}
            </div>

            {question.allow_custom ? (
              <TextAnswerInput
                value={current.customText || ''}
                disabled={disabled}
                label={`${question.label} 自定义答案`}
                placeholder={question.custom_placeholder || '自定义答案'}
                onChange={(nextText) => {
                  onAnswer({
                    customText: nextText,
                    optionId: question.type === 'single_select' && nextText ? 'custom' : (current.optionId || ''),
                  });
                }}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function ClarifyInteractionCard({
  interaction,
  onSubmit,
  onRetry,
  submitting = false,
}) {
  const [answers, setAnswers] = useState(() => buildInitialAnswers(interaction));

  useEffect(() => {
    setAnswers(buildInitialAnswers(interaction));
  }, [interaction]);

  const statusMeta = STATUS_META[interaction?.status] || STATUS_META.pending;
  const questions = Array.isArray(interaction?.payload?.questions) ? interaction.payload.questions : [];
  const isPending = interaction?.status === 'pending';
  const isRetryable = interaction?.status === 'failed';
  const canSubmit = isPending && questions.every((question) => {
    if (!question.required) return true;
    const current = answers[question.id] || {};
    if (question.type === 'text_input') return Boolean(String(current.text || '').trim());
    return Boolean(String(current.customText || '').trim() || current.optionId);
  });

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
      style={{
        width: '100%',
        maxHeight: 'min(72vh, 620px)',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        padding: '16px',
        borderRadius: 20,
        border: '1px solid color-mix(in srgb, var(--accent) 16%, var(--border-primary))',
        background: 'color-mix(in srgb, var(--bg-primary) 92%, var(--bg-elevated))',
        boxShadow: '0 20px 50px rgba(20, 20, 19, 0.18)',
        display: 'grid',
        gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icons.sparkles size={14} />
        </span>
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {interaction?.payload?.title || '确认后继续'}
        </span>
        <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
      </div>

      <div style={{ display: 'grid' }}>
        {questions.map((question, index) => {
          const current = answers[question.id] || {};
          const disabled = !isPending;
          return (
            <QuestionRow
              key={question.id}
              question={question}
              index={index}
              current={current}
              disabled={disabled}
              onAnswer={(patch) => {
                setAnswers((prev) => ({
                  ...prev,
                  [question.id]: {
                    ...prev[question.id],
                    ...patch,
                  },
                }));
              }}
            />
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        {isRetryable ? (
          <Button type="button" variant="primary" size="sm" onClick={() => onRetry?.(interaction)}>
            重试生成预览
          </Button>
        ) : null}
        {isPending ? (
          <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} loading={submitting}>
            确认并继续
          </Button>
        ) : null}
      </div>
    </form>
  );
}
