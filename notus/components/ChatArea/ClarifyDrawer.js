import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Icons } from '../ui/Icons';

export const NONE_OF_THE_ABOVE_OPTION_ID = '__none_of_the_above__';

function buildFallbackQuestionOptions(label = '', questionId = '') {
  const text = `${String(questionId || '').trim()} ${String(label || '').trim()}`.trim();
  if (/\bprimary_intent\b/.test(text)) {
    return [
      { id: 'edit', label: '直接修改文档', description: '生成并应用当前任务的文档修改', answer_value: 'edit' },
      { id: 'text', label: '继续讨论', description: '先讨论方案，不直接修改文档', answer_value: 'text' },
      { id: 'analyze', label: '先分析文章', description: '只分析现有内容，不写入文档', answer_value: 'analyze' },
    ];
  }
  if (/\bsource_content_ref\b/.test(text)) {
    return [
      { id: 'previous_assistant_message', label: '上一条助手回复', description: '沿用刚才生成的内容', answer_value: 'previous_assistant_message' },
      { id: 'recent_user_message', label: '最近一条用户消息', description: '使用最近一次输入作为来源', answer_value: 'recent_user_message' },
      { id: 'previous_user_message', label: '更早的用户消息', description: '从更早的对话中选择来源', answer_value: 'previous_user_message' },
    ];
  }
  if (/\btarget_location\b/.test(text)) {
    return [
      { id: 'document_end', label: '文末', description: '追加到当前文档最后', answer_value: 'document_end' },
      { id: 'document_start', label: '文首', description: '放到当前文档开头', answer_value: 'document_start' },
      { id: 'after_target', label: '指定段落之后', description: '放在选定内容后面', answer_value: 'after_target' },
    ];
  }
  if (/\bwrite_mode\b/.test(text)) {
    return [
      { id: 'append_new_blocks', label: '追加新段落', description: '保留原文并在目标位置补充内容', answer_value: 'append_new_blocks' },
      { id: 'replace_target', label: '替换目标段落', description: '用新内容替换选定部分', answer_value: 'replace_target' },
      { id: 'insert_before_target', label: '插入到目标前', description: '把新内容放到选定部分之前', answer_value: 'insert_before_target' },
    ];
  }

  if (/(是否|要不要|需不需要|需要吗|可以吗|确认|同意|启用|开启|保留|删除|覆盖|写入)/.test(text)) {
    return [
      { id: 'yes', label: '是，需要', description: '按当前任务继续执行', answer_value: 'yes' },
      { id: 'no', label: '否，不需要', description: '不执行这项操作', answer_value: 'no' },
      { id: 'undecided', label: '暂不确定', description: '先保留当前状态', answer_value: 'undecided' },
    ];
  }
  if (/(位置|哪里|写到|放到|插入|目标|范围|章节|段落)/.test(text)) {
    return [
      { id: 'document_end', label: '文末', description: '追加到当前文档最后', answer_value: 'document_end' },
      { id: 'document_start', label: '文首', description: '放到当前文档开头', answer_value: 'document_start' },
      { id: 'after_target', label: '指定段落之后', description: '放在选定内容后面', answer_value: 'after_target' },
    ];
  }
  if (/(名称|命名|tag|标签|标题)/i.test(text)) {
    return [
      { id: 'keep_current', label: '沿用当前名称', description: '保持已有标题或标签', answer_value: 'keep_current' },
      { id: 'versioned', label: '使用版本号', description: '按版本信息生成名称', answer_value: 'versioned' },
      { id: 'descriptive', label: '使用描述性名称', description: '根据内容生成清晰名称', answer_value: 'descriptive' },
    ];
  }
  if (/(风格|格式|语气|长度|详细|版本)/.test(text)) {
    return [
      { id: 'concise', label: '简洁版', description: '保留重点，减少铺陈', answer_value: 'concise' },
      { id: 'detailed', label: '详细版', description: '补充背景和过程', answer_value: 'detailed' },
      { id: 'keep_current', label: '保持当前格式', description: '沿用已有表达方式', answer_value: 'keep_current' },
    ];
  }
  return [
    { id: 'recommended', label: '按 Agent 建议', description: '采用当前任务更合适的方案', answer_value: 'recommended' },
    { id: 'keep_current', label: '保持当前设置', description: '沿用已有内容或配置', answer_value: 'keep_current' },
    { id: 'undecided', label: '暂不决定', description: '先保留选择，继续整理', answer_value: 'undecided' },
  ];
}

function getQuestionOptions(question = {}) {
  const providedOptions = Array.isArray(question.options)
    ? question.options.filter((option) => option?.id && option?.label)
    : [];
  if (providedOptions.length >= 2) return providedOptions;
  const ids = new Set(providedOptions.map((option) => option.id));
  return [
    ...providedOptions,
  ...buildFallbackQuestionOptions(question.label || question.question || question.title || question.id, question.id)
      .filter((option) => !ids.has(option.id)),
  ].slice(0, 5);
}

function buildInitialAnswers(interaction, answerDraft = null) {
  const responseAnswers = interaction?.response?.answers && typeof interaction.response.answers === 'object'
    ? interaction.response.answers
    : {};
  const prefilledAnswers = interaction?.payload?.prefilled_answers && typeof interaction.payload.prefilled_answers === 'object'
    ? interaction.payload.prefilled_answers
    : {};
  const draftAnswers = answerDraft && typeof answerDraft === 'object' ? answerDraft : {};

  return (Array.isArray(interaction?.payload?.questions) ? interaction.payload.questions : []).reduce((acc, question) => {
    const current = draftAnswers[question.id] || responseAnswers[question.id] || prefilledAnswers[question.id] || null;
    acc[question.id] = {
      optionId: current?.selected_option_id || current?.option_id || current?.value || '',
      optionIds: Array.isArray(current?.option_ids) ? current.option_ids : [],
      text: current?.text || '',
      customText: current?.text || current?.custom_text || '',
      label: current?.label || '',
      skipped: Boolean(current?.skipped),
    };
    return acc;
  }, {});
}

function isQuestionAnswered(question, current = {}) {
  if (!question) return false;
  if (current.skipped) return false;
  if (question.type === 'text_input') return Boolean(String(current.text || current.customText || '').trim());
  return Boolean(String(current.customText || '').trim() || current.optionId);
}

function isQuestionResolved(question, current = {}) {
  return Boolean(current?.skipped) || isQuestionAnswered(question, current);
}

function findFirstUnansweredIndex(questions = [], answers = {}) {
  const index = questions.findIndex((question) => !isQuestionResolved(question, answers[question.id] || {}));
  return index >= 0 ? index : 0;
}

function getQuestionTitle(question = {}) {
  return String(question.question || question.title || question.label || question.id || '').trim();
}

function getDrawerTitle(interaction = {}) {
  const raw = String(interaction?.payload?.kicker || interaction?.payload?.title || '').trim();
  const normalized = raw.replace(/^Notus\s*·\s*/i, '').replace(/^Agent\s+/i, '').trim();
  return normalized || '需要你确认';
}

function getQuestionStates(questions = [], activeIndex = 0, answers = {}) {
  return questions.map((question, index) => {
    if (index === activeIndex) return 'current';
    const current = answers[question.id] || {};
    return isQuestionAnswered(question, current) ? 'done' : 'pending';
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
              background: state === 'done' ? 'var(--success)' : 'var(--border-primary)',
            }}
          />
        );
      })}
    </div>
  );
}

export function ClarifyDrawer({
  interaction,
  onSubmit,
  onRetry,
  onCancel,
  onPhaseChange,
  submitting = false,
  submitLabel = '开始检索',
  retryLabel = '重试',
  narrow = false,
  answerDraft = null,
  onAnswerDraftChange,
}) {
  const questions = useMemo(
    () => (Array.isArray(interaction?.payload?.questions) ? interaction.payload.questions : []),
    [interaction]
  );
  const isPending = interaction?.status === 'pending';
  const isRetryable = interaction?.status === 'failed';
  const isStale = interaction?.status === 'stale';
  const [answers, setAnswers] = useState(() => buildInitialAnswers(interaction, answerDraft));
  const [activeIndex, setActiveIndex] = useState(() => findFirstUnansweredIndex(questions, buildInitialAnswers(interaction, answerDraft)));
  const [phase, setPhase] = useState(() => (isRetryable ? 'failed' : isStale ? 'stale' : 'expanded-question'));
  const optionRefs = useRef([]);
  const customInputRef = useRef(null);
  const answerDraftRef = useRef(answerDraft);

  useEffect(() => {
    answerDraftRef.current = answerDraft;
  }, [answerDraft]);

  useEffect(() => {
    const nextAnswers = buildInitialAnswers(interaction, answerDraftRef.current);
    setAnswers(nextAnswers);
    setActiveIndex(findFirstUnansweredIndex(questions, nextAnswers));
    setPhase(isRetryable ? 'failed' : isStale ? 'stale' : 'expanded-question');
  }, [interaction, isRetryable, isStale, questions]);

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [onPhaseChange, phase]);

  useEffect(() => {
    if (phase === 'expanded-question') {
      window.requestAnimationFrame(() => {
        optionRefs.current[0]?.focus?.();
        if (!optionRefs.current[0]) customInputRef.current?.focus?.();
      });
    }
  }, [activeIndex, phase]);

  const resolvedCount = useMemo(
    () => questions.filter((question) => isQuestionResolved(question, answers[question.id] || {})).length,
    [answers, questions]
  );
  const currentQuestion = questions[activeIndex] || null;
  const currentQuestionOptions = currentQuestion ? getQuestionOptions(currentQuestion) : [];
  const allResolved = questions.length > 0 && resolvedCount === questions.length;
  const currentAnswer = currentQuestion ? (answers[currentQuestion.id] || {}) : {};
  const dots = getQuestionStates(questions, activeIndex, answers);
  const footerHint = interaction?.payload?.footer_hint
    || (allResolved ? '回答完成后提交' : `${questions.length} 个问题，可以跳过未确定的内容`);

  const handleAnswerPatch = (questionId, patch = {}) => {
    const nextAnswers = {
      ...answers,
      [questionId]: {
        ...answers[questionId],
        ...patch,
        skipped: false,
      },
    };
    setAnswers(nextAnswers);
    onAnswerDraftChange?.(nextAnswers);
  };

  const selectOptionAndAdvance = (questionId, patch = {}) => {
    const nextAnswers = {
      ...answers,
      [questionId]: {
        ...answers[questionId],
        ...patch,
        skipped: false,
      },
    };
    setAnswers(nextAnswers);
    onAnswerDraftChange?.(nextAnswers);
    if (!isPending) return;
    const questionIndex = questions.findIndex((question) => question.id === questionId);
    if (questionIndex >= 0 && questionIndex < questions.length - 1) {
      setActiveIndex(questionIndex + 1);
    }
  };

  const skipQuestionAndAdvance = (questionId) => {
    const nextAnswers = {
      ...answers,
      [questionId]: {
        ...answers[questionId],
        optionId: '',
        optionIds: [],
        text: '',
        customText: '',
        label: '未回答',
        skipped: true,
      },
    };
    setAnswers(nextAnswers);
    onAnswerDraftChange?.(nextAnswers);
    const questionIndex = questions.findIndex((question) => question.id === questionId);
    if (questionIndex >= 0 && questionIndex < questions.length - 1) {
      setActiveIndex(questionIndex + 1);
    }
  };

  const buildSubmitPayload = () => Object.fromEntries(questions.map((question) => {
    const current = answers[question.id] || {};
    return [question.id, {
      option_id: current.optionId || '',
      option_ids: current.optionIds || [],
      text: current.text || '',
      custom_text: current.customText || '',
      skipped: Boolean(current.skipped),
    }];
  }));

  const handlePrimaryAction = () => {
    if (phase === 'expanded-question') {
      if (!currentQuestion) return;
      if (activeIndex < questions.length - 1) {
        setActiveIndex((prev) => Math.min(prev + 1, questions.length - 1));
        return;
      }
      if (!isPending || submitting) return;
      onSubmit?.(interaction, buildSubmitPayload());
      return;
    }
  };

  const handleKeyDown = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (phase === 'failed') {
        if (isRetryable) {
          onRetry?.(interaction);
        }
      } else if (phase === 'expanded-question' && currentQuestion && activeIndex === questions.length - 1) {
        onSubmit?.(interaction, buildSubmitPayload());
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && phase === 'expanded-question' && currentQuestion) {
      const tag = String(event.target?.tagName || '').toLowerCase();
      if (tag === 'textarea') return;
      event.preventDefault();
      handlePrimaryAction();
    }
  };

  if (!interaction || questions.length === 0) return null;

  return (
    <div
      onKeyDown={handleKeyDown}
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
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
          {getDrawerTitle(interaction)}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-full)' }}>
          {`${activeIndex + 1} / ${questions.length}`}
        </span>
        {isPending && onCancel ? (
          <button
            type="button"
            aria-label="取消提问"
            title="取消提问"
            disabled={submitting}
            onClick={() => onCancel(interaction)}
            style={{
              width: 26,
              height: 26,
              borderRadius: 'var(--radius-sm)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-tertiary)',
              opacity: submitting ? 0.55 : 1,
              cursor: submitting ? 'not-allowed' : 'pointer',
            }}
          >
            <Icons.x size={15} />
          </button>
        ) : null}
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
            {[
              ...currentQuestionOptions,
              ...(currentQuestionOptions.some((option) => option.id === NONE_OF_THE_ABOVE_OPTION_ID)
                ? []
                : [{ id: NONE_OF_THE_ABOVE_OPTION_ID, label: '以上选项都不是' }]),
            ].map((option, index) => {
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
                  onClick={() => selectOptionAndAdvance(currentQuestion.id, {
                    optionId: option.id,
                    optionIds: [option.id],
                    text: currentQuestion.type === 'text_input' ? option.label : '',
                    customText: '',
                    label: option.label,
                    skipped: false,
                  })}
                />
              );
            })}

            {
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
                        optionIds: [],
                        label: nextText ? '自定义回答' : '',
                      });
                      return;
                    }
                    handleAnswerPatch(currentQuestion.id, {
                      customText: nextText,
                      text: nextText,
                      optionId: nextText ? 'custom' : '',
                      optionIds: nextText ? ['custom'] : [],
                      label: nextText ? '自定义回答' : '',
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
            }
          </div>
        </div>
      ) : (
        <div style={{ padding: narrow ? '14px 14px 16px' : '16px 16px 18px', display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>
            上次提交没有完成
          </div>
          <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
            可以重新提交当前回答，Agent 会从原任务继续执行。
          </div>
        </div>
      )}

      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {phase === 'expanded-question' ? <Dots states={dots} /> : null}
        {phase === 'failed' && !narrow ? (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            上次续跑失败了，可以直接重试。
          </span>
        ) : !narrow ? (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{footerHint}</span>
        ) : null}
        <div style={{ flex: 1 }} />
        {(phase === 'expanded-question' && isPending) ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label="上一题"
            title="上一题"
            disabled={activeIndex === 0 || submitting}
            onClick={() => setActiveIndex((prev) => Math.max(prev - 1, 0))}
            style={{ width: 28, padding: 0, justifyContent: 'center' }}
          >
            <Icons.chevronLeft size={14} />
          </Button>
        ) : null}
        {phase === 'failed' && onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onCancel(interaction)}>
            放弃
          </Button>
        ) : null}
        {isPending && phase === 'expanded-question' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => skipQuestionAndAdvance(currentQuestion.id)}
          >
            跳过此题
          </Button>
        ) : null}
        {isRetryable && phase === 'failed' ? (
          <Button type="button" variant="primary" size="sm" onClick={() => onRetry?.(interaction)}>
            {retryLabel}
          </Button>
        ) : null}
        {isPending && phase === 'expanded-question' && activeIndex < questions.length - 1 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-label="下一题"
            title="下一题"
            disabled={submitting}
            onClick={handlePrimaryAction}
            style={{ width: 28, padding: 0, justifyContent: 'center' }}
          >
            <Icons.chevronRight size={14} />
          </Button>
        ) : null}
        {isPending && phase === 'expanded-question' && activeIndex === questions.length - 1 ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={submitting}
            disabled={submitting}
            onClick={handlePrimaryAction}
          >
            {submitLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
