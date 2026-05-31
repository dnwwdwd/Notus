import { useEffect, useMemo, useRef, useState } from 'react';
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
      text: current?.text || '',
      customText: current?.text || current?.custom_text || '',
      label: current?.label || '',
    };
    return acc;
  }, {});
}

function isQuestionAnswered(question, current = {}) {
  if (!question) return false;
  if (question.type === 'text_input') return Boolean(String(current.text || current.customText || '').trim());
  return Boolean(String(current.customText || '').trim() || current.optionId);
}

function findFirstUnansweredIndex(questions = [], answers = {}) {
  const index = questions.findIndex((question) => !isQuestionAnswered(question, answers[question.id] || {}));
  return index >= 0 ? index : 0;
}

function getQuestionTitle(question = {}) {
  return String(question.question || question.title || question.label || question.id || '').trim();
}

function buildAnswerPreview(question, current = {}) {
  const customText = String(current.customText || current.text || '').trim();
  if (customText) {
    return {
      text: customText,
      custom: true,
    };
  }
  const optionId = String(current.optionId || '').trim();
  const option = (Array.isArray(question.options) ? question.options : []).find((item) => item.id === optionId) || null;
  return {
    text: option?.label || current.label || optionId || '未回答',
    custom: false,
  };
}

function getQuestionStates(questions = [], activeIndex = 0, answers = {}) {
  return questions.map((question, index) => {
    if (index === activeIndex) return 'current';
    return isQuestionAnswered(question, answers[question.id] || {}) ? 'done' : 'pending';
  });
}

function AnswerRow({ buttonRef, selected, dimmed, label, hint, disabled, onClick }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        background: selected ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
        border: selected ? '1px solid var(--accent)' : '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all var(--transition-fast)',
        opacity: dimmed ? 0.56 : 1,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          marginTop: 2,
          flexShrink: 0,
          border: selected ? '4px solid var(--accent)' : '1.5px solid var(--border-primary)',
          background: selected ? 'var(--bg-elevated)' : 'transparent',
          transition: 'all var(--transition-fast)',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.55, color: 'var(--text-primary)', fontWeight: selected ? 500 : 400 }}>
          {label}
        </div>
        {hint ? (
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.45 }}>
            {hint}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function Dots({ states = [] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {states.map((state, index) => {
        const baseStyle = {
          width: 7,
          height: 7,
          borderRadius: '50%',
        };
        if (state === 'current') {
          return (
            <div
              key={`${state}-${index}`}
              style={{
                ...baseStyle,
                width: 9,
                height: 9,
                background: 'var(--accent)',
                boxShadow: '0 0 0 2px var(--bg-elevated), 0 0 0 3.5px var(--accent)',
              }}
            />
          );
        }
        return (
          <div
            key={`${state}-${index}`}
            style={{
              ...baseStyle,
              background: state === 'done' ? 'var(--accent)' : 'var(--border-primary)',
            }}
          />
        );
      })}
    </div>
  );
}

function ReviewRow({
  question,
  current,
  index,
  editing,
  disabled,
  onClick,
  narrow,
  rowRef,
}) {
  const preview = buildAnswerPreview(question, current);
  return (
    <button
      ref={rowRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: narrow ? '10px 14px' : '12px 16px',
        background: editing ? 'var(--accent-subtle)' : 'transparent',
        borderTop: index === 0 ? 'none' : '1px solid var(--border-subtle)',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          marginTop: 2,
          borderRadius: '50%',
          flexShrink: 0,
          background: 'var(--accent-subtle)',
          color: 'var(--accent)',
          fontSize: 10,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {index + 1}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 3, lineHeight: 1.45 }}>
          {getQuestionTitle(question)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--text-primary)', lineHeight: 1.55 }}>
          {preview.custom ? <Badge tone="accent">自定义</Badge> : null}
          <span style={{ fontWeight: 500 }}>{preview.text || '未回答'}</span>
        </div>
      </div>
      <span style={{ fontSize: 11, marginTop: 4, color: editing ? 'var(--accent)' : 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <Icons.edit size={10} />
        {editing ? '正在改' : '修改'}
      </span>
    </button>
  );
}

export function ClarifyDrawer({
  interaction,
  onSubmit,
  onRetry,
  onCancel,
  onPhaseChange,
  onFocusInput,
  submitting = false,
  submitLabel = '开始检索',
  retryLabel = '重试',
  narrow = false,
  sheet = false,
}) {
  const questions = useMemo(
    () => (Array.isArray(interaction?.payload?.questions) ? interaction.payload.questions : []),
    [interaction]
  );
  const statusMeta = STATUS_META[interaction?.status] || STATUS_META.pending;
  const isPending = interaction?.status === 'pending';
  const isRetryable = interaction?.status === 'failed';
  const isStale = interaction?.status === 'stale';
  const [answers, setAnswers] = useState(() => buildInitialAnswers(interaction));
  const [activeIndex, setActiveIndex] = useState(() => findFirstUnansweredIndex(questions, buildInitialAnswers(interaction)));
  const [phase, setPhase] = useState(() => (isRetryable ? 'failed' : isStale ? 'stale' : 'expanded-question'));
  const [swipeStartY, setSwipeStartY] = useState(null);
  const optionRefs = useRef([]);
  const customInputRef = useRef(null);
  const reviewRowRefs = useRef([]);

  useEffect(() => {
    const nextAnswers = buildInitialAnswers(interaction);
    setAnswers(nextAnswers);
    setActiveIndex(findFirstUnansweredIndex(questions, nextAnswers));
    setPhase(isRetryable ? 'failed' : isStale ? 'stale' : 'expanded-question');
  }, [interaction, isRetryable, isStale, questions]);

  useEffect(() => {
    onPhaseChange?.(phase);
    if (phase === 'collapsed') {
      onFocusInput?.();
    }
  }, [onFocusInput, onPhaseChange, phase]);

  useEffect(() => {
    if (phase === 'expanded-question') {
      window.requestAnimationFrame(() => {
        optionRefs.current[0]?.focus?.();
        if (!optionRefs.current[0]) customInputRef.current?.focus?.();
      });
    } else if (phase === 'expanded-review') {
      window.requestAnimationFrame(() => {
        reviewRowRefs.current[0]?.focus?.();
      });
    }
  }, [activeIndex, phase]);

  const answeredCount = useMemo(
    () => questions.filter((question) => isQuestionAnswered(question, answers[question.id] || {})).length,
    [answers, questions]
  );
  const currentQuestion = questions[activeIndex] || null;
  const allAnswered = questions.length > 0 && answeredCount === questions.length;
  const expandedPhase = isRetryable ? 'failed' : isStale ? 'stale' : allAnswered ? 'expanded-review' : 'expanded-question';
  const currentAnswer = currentQuestion ? (answers[currentQuestion.id] || {}) : {};
  const canAdvanceCurrent = currentQuestion ? isQuestionAnswered(currentQuestion, currentAnswer) : false;
  const dots = getQuestionStates(questions, activeIndex, answers);
  const collapsedSummary = interaction?.payload?.collapsed_summary
    || (answeredCount > 0 ? `已回答 ${answeredCount} / ${questions.length}` : '先确认几个问题');

  const footerHint = interaction?.payload?.footer_hint
    || (allAnswered ? '检查无误后再开始' : `${questions.length} 个问题，约 30 秒`);

  const handleAnswerPatch = (questionId, patch = {}) => {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: {
        ...prev[questionId],
        ...patch,
      },
    }));
  };

  const buildSubmitPayload = () => Object.fromEntries(questions.map((question) => {
    const current = answers[question.id] || {};
    return [question.id, {
      option_id: current.optionId || '',
      option_ids: current.optionIds || [],
      text: current.text || '',
      custom_text: current.customText || '',
    }];
  }));

  const handlePrimaryAction = () => {
    if (phase === 'expanded-question') {
      if (!canAdvanceCurrent) return;
      if (activeIndex < questions.length - 1) {
        setActiveIndex((prev) => Math.min(prev + 1, questions.length - 1));
        return;
      }
      setPhase('expanded-review');
      return;
    }
    if (!allAnswered || !isPending || submitting) return;
    onSubmit?.(interaction, buildSubmitPayload());
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape' && !isStale) {
      event.preventDefault();
      setPhase('collapsed');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if ((phase === 'expanded-review' || phase === 'failed') && allAnswered) {
        if (isRetryable) {
          onRetry?.(interaction);
        } else {
          onSubmit?.(interaction, buildSubmitPayload());
        }
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && phase === 'expanded-question' && canAdvanceCurrent) {
      const tag = String(event.target?.tagName || '').toLowerCase();
      if (tag === 'textarea') return;
      event.preventDefault();
      handlePrimaryAction();
    }
  };

  const handleTouchStart = (event) => {
    if (!sheet) return;
    setSwipeStartY(event.touches?.[0]?.clientY || null);
  };

  const handleTouchEnd = (event) => {
    if (!sheet || swipeStartY === null) return;
    const endY = event.changedTouches?.[0]?.clientY || swipeStartY;
    const delta = endY - swipeStartY;
    if (phase === 'collapsed') {
      if (delta < -40) {
        setPhase(expandedPhase);
      }
    } else if (delta > 56) {
      setPhase('collapsed');
    }
    setSwipeStartY(null);
  };

  if (!interaction || questions.length === 0) return null;

  if (phase === 'collapsed') {
    return (
      <div
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onClick={() => setPhase(isRetryable ? 'failed' : isStale ? 'stale' : allAnswered ? 'expanded-review' : 'expanded-question')}
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid color-mix(in srgb, var(--accent) 18%, var(--border-primary))',
          borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
          boxShadow: '0 -8px 24px -8px rgba(60, 40, 20, 0.12), 0 -2px 6px -2px rgba(60, 40, 20, 0.06)',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
        }}
      >
        <div style={{ width: 34, height: 4, borderRadius: 999, background: 'var(--border-primary)', marginRight: 2 }} />
        <div style={{ display: 'grid', gap: 2, minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
              <Icons.sparkles size={13} />
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {interaction?.payload?.title || '确认后继续'}
            </span>
            <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {collapsedSummary}
          </div>
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          展开
        </span>
      </div>
    );
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid color-mix(in srgb, var(--accent) 18%, var(--border-primary))',
        borderBottom: 'none',
        borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
        boxShadow: '0 -8px 24px -8px rgba(60, 40, 20, 0.12), 0 -2px 6px -2px rgba(60, 40, 20, 0.06)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 4px' }}>
        <div style={{ width: 36, height: 3, borderRadius: 999, background: 'var(--border-primary)' }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 16px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icons.sparkles size={13} />
        </span>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
          Notus · {interaction?.payload?.kicker || interaction?.payload?.title || '确认后继续'}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-full)' }}>
          {phase === 'expanded-review' || phase === 'failed' ? `${questions.length} / ${questions.length}` : `${activeIndex + 1} / ${questions.length}`}
        </span>
        <button
          type="button"
          title="收起，先用普通对话"
          onClick={() => setPhase('collapsed')}
          style={{
            width: 22,
            height: 22,
            borderRadius: 'var(--radius-sm)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-tertiary)',
          }}
        >
          <Icons.chevronDown size={13} />
        </button>
      </div>

      {phase === 'stale' ? (
        <div style={{ padding: narrow ? '14px 14px 16px' : '16px 16px 18px', display: 'grid', gap: 12 }}>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>
            当前内容已经变化
          </div>
          <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
            这张澄清抽屉对应的上下文已经失效，请重新发起一次请求。
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button type="button" variant="ghost" size="sm" onClick={() => onCancel?.(interaction)}>
              关闭
            </Button>
          </div>
        </div>
      ) : phase === 'expanded-question' ? (
        <div style={{ padding: narrow ? '12px 14px' : '14px 16px' }}>
          <div style={{ fontSize: narrow ? 15 : 16, lineHeight: 1.55, color: 'var(--text-primary)', fontWeight: 600, letterSpacing: -0.1, marginBottom: 12 }}>
            {getQuestionTitle(currentQuestion)}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {(currentQuestion.options || []).map((option, index) => {
              const selected = currentAnswer.optionId === option.id && !String(currentAnswer.customText || '').trim();
              return (
                <AnswerRow
                  key={option.id}
                  buttonRef={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  selected={selected}
                  dimmed={Boolean(String(currentAnswer.customText || '').trim())}
                  label={option.label}
                  hint={option.description}
                  disabled={!isPending}
                  onClick={() => handleAnswerPatch(currentQuestion.id, {
                    optionId: option.id,
                    optionIds: [option.id],
                    text: '',
                    customText: '',
                    label: option.label,
                  })}
                />
              );
            })}

            {currentQuestion.allow_custom || currentQuestion.type === 'text_input' ? (
              <div
                style={{
                  background: 'var(--bg-elevated)',
                  border: `1px solid ${String(currentAnswer.customText || currentAnswer.text || '').trim() ? 'var(--accent)' : 'var(--border-primary)'}`,
                  borderRadius: 'var(--radius-md)',
                  overflow: 'hidden',
                }}
              >
                <div style={{ padding: '8px 12px 2px', fontSize: 11, color: String(currentAnswer.customText || currentAnswer.text || '').trim() ? 'var(--accent)' : 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icons.edit size={11} />
                  <span>{currentQuestion.type === 'text_input' ? '直接输入答案' : '自定义回答'}</span>
                </div>
                <input
                  ref={customInputRef}
                  type="text"
                  value={currentQuestion.type === 'text_input' ? (currentAnswer.text || currentAnswer.customText || '') : (currentAnswer.customText || '')}
                  disabled={!isPending}
                  placeholder={currentQuestion.custom_placeholder || '自己补充更准确的说法'}
                  onChange={(event) => {
                    const nextText = event.target.value;
                    if (currentQuestion.type === 'text_input') {
                      handleAnswerPatch(currentQuestion.id, {
                        text: nextText,
                        customText: nextText,
                        optionId: '',
                      });
                      return;
                    }
                    handleAnswerPatch(currentQuestion.id, {
                      customText: nextText,
                      text: nextText,
                      optionId: nextText ? 'custom' : '',
                    });
                  }}
                  style={{
                    width: '100%',
                    minHeight: 36,
                    padding: '2px 12px 10px',
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: 'var(--text-primary)',
                    fontSize: 'var(--text-sm)',
                    lineHeight: 1.55,
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div>
          {(isRetryable ? questions.filter((question) => isQuestionAnswered(question, answers[question.id] || {})) : questions).map((question, index) => (
            <ReviewRow
              key={question.id}
              rowRef={(node) => {
                reviewRowRefs.current[index] = node;
              }}
              question={question}
              current={answers[question.id] || {}}
              index={index}
              narrow={narrow}
              editing={activeIndex === index && phase === 'expanded-review'}
              disabled={!isPending}
              onClick={() => {
                if (!isPending) return;
                setActiveIndex(index);
                setPhase('expanded-question');
              }}
            />
          ))}
        </div>
      )}

      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {phase === 'expanded-question' ? <Dots states={dots} /> : null}
        {phase !== 'expanded-question' && !narrow ? (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {phase === 'failed' ? '上次续跑失败了，可以直接重试。' : '点任意一行可以回去修改'}
          </span>
        ) : !narrow ? (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{footerHint}</span>
        ) : null}
        <div style={{ flex: 1 }} />
        {(phase === 'expanded-question' && activeIndex > 0 && isPending) ? (
          <button
            type="button"
            onClick={() => setActiveIndex((prev) => Math.max(prev - 1, 0))}
            style={{ height: 26, padding: '0 8px', fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 2, borderRadius: 'var(--radius-sm)' }}
          >
            <Icons.chevronRight size={11} style={{ transform: 'rotate(180deg)' }} />
            上一题
          </button>
        ) : null}
        {(phase === 'expanded-review' || phase === 'failed') && onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onCancel(interaction)}>
            放弃
          </Button>
        ) : null}
        {isRetryable && phase === 'failed' ? (
          <Button type="button" variant="primary" size="sm" onClick={() => onRetry?.(interaction)}>
            {retryLabel}
          </Button>
        ) : null}
        {isPending ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={submitting}
            disabled={phase === 'expanded-question' ? !canAdvanceCurrent : !allAnswered}
            onClick={handlePrimaryAction}
          >
            {phase === 'expanded-question'
              ? (activeIndex === questions.length - 1 ? '回顾答案' : '下一题')
              : submitLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
