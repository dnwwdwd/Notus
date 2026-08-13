import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Icons } from '../ui/Icons';

const STATUS_META = {
  pending: {
    label: '待确认',
    tone: 'accent',
  },
  processing: {
    label: '正在处理',
    tone: 'default',
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
      optionId: current?.selected_option_id || current?.option_id || current?.value || '',
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

function isQuestionVisible(question, answers = {}) {
  const dependency = question?.depends_on || question?.dependsOn;
  if (!dependency?.question_id || !Array.isArray(dependency.values) || dependency.values.length === 0) return true;
  const current = answers[dependency.question_id] || {};
  return dependency.values.includes(String(current.optionId || '').trim());
}

function visibleQuestions(questions = [], answers = {}) {
  return questions.filter((question) => isQuestionVisible(question, answers));
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
      className={`notus-agent-question-card__option notus-agent-pressable${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}`}
    >
      <span className="notus-agent-question-card__option-mark" aria-hidden="true" />
      <span className="notus-agent-question-card__option-copy">
        <span className="notus-agent-question-card__option-label">{label}</span>
        {hint ? <span className="notus-agent-question-card__option-hint">{hint}</span> : null}
      </span>
    </button>
  );
}

function QuestionCardHeader({
  title,
  summary,
  expanded,
  onToggle,
  status,
  controlsId,
}) {
  return (
    <button
      type="button"
      className="notus-agent-tool-row notus-agent-question-card__toggle"
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={onToggle}
    >
      <span className="notus-agent-toolchain__icon" aria-hidden="true">
        <Icons.sparkles size={14} />
      </span>
      <span className="notus-agent-toolchain__label">{title}</span>
      {summary ? <span className="notus-agent-question-card__summary">{summary}</span> : null}
      {status ? <span className="notus-agent-question-card__status">{status}</span> : null}
      <Icons.chevronRight size={14} className={expanded ? 'notus-agent-tool-chevron is-open' : 'notus-agent-tool-chevron'} aria-hidden="true" />
    </button>
  );
}

function QuestionProgress({ states = [] }) {
  return (
    <div className="notus-agent-question-card__progress" aria-label={`已回答 ${states.filter((state) => state === 'done').length} 题`}>
      {states.map((state, index) => (
        <span key={`${state}-${index}`} className={`notus-agent-question-card__progress-dot is-${state}`} />
      ))}
    </div>
  );
}

function Dots({ states = [] }) {
  return <QuestionProgress states={states} />;
}

function ReviewRow({
  question,
  current,
  index,
  editing,
  disabled,
  onClick,
  rowRef,
}) {
  const preview = buildAnswerPreview(question, current);
  return (
    <button
      ref={rowRef}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`notus-agent-question-card__review-row notus-agent-tool-row${editing ? ' is-editing' : ''}`}
    >
      <span className="notus-agent-question-card__review-index" aria-hidden="true">{index + 1}</span>
      <span className="notus-agent-question-card__review-copy">
        <span className="notus-agent-question-card__review-question">{getQuestionTitle(question)}</span>
        <span className="notus-agent-question-card__review-answer">
          {preview.custom ? <span className="notus-agent-question-card__custom-label">自定义</span> : null}
          <span>{preview.text || '未回答'}</span>
        </span>
      </span>
      <span className="notus-agent-question-card__review-edit">
        <Icons.edit size={10} />
        {editing ? '正在修改' : '修改'}
      </span>
    </button>
  );
}

export function ClarifyDrawer({
  interaction,
  answerDraft,
  onAnswerDraftChange,
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
  const [answers, setAnswers] = useState(() => answerDraft || buildInitialAnswers(interaction));
  const [activeIndex, setActiveIndex] = useState(() => findFirstUnansweredIndex(questions, answerDraft || buildInitialAnswers(interaction)));
  const [phase, setPhase] = useState(() => (isRetryable ? 'failed' : isStale ? 'stale' : 'expanded-question'));
  const [swipeStartY, setSwipeStartY] = useState(null);
  const optionRefs = useRef([]);
  const customInputRef = useRef(null);
  const reviewRowRefs = useRef([]);
  const answerDraftRef = useRef(answerDraft);
  const activeQuestions = useMemo(() => visibleQuestions(questions, answers), [answers, questions]);

  useEffect(() => {
    answerDraftRef.current = answerDraft;
  }, [answerDraft]);

  useEffect(() => {
    const nextAnswers = answerDraftRef.current || buildInitialAnswers(interaction);
    const nextQuestions = visibleQuestions(questions, nextAnswers);
    const restoredAllAnswered = nextQuestions.length > 0
      && nextQuestions.every((question) => isQuestionAnswered(question, nextAnswers[question.id] || {}));
    setAnswers(nextAnswers);
    setActiveIndex(findFirstUnansweredIndex(nextQuestions, nextAnswers));
    setPhase(isRetryable ? 'failed' : isStale ? 'stale' : restoredAllAnswered ? 'expanded-review' : 'expanded-question');
    // 同一张卡片的父级重渲染（切换文件、布局收起）不能清空用户尚未提交的回答。
    // 卡片 schema 更新会带来新的 interaction id；同一 id 只恢复一次内存草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interaction?.id, isRetryable, isStale]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(activeQuestions.length - 1, 0)));
  }, [activeQuestions.length]);

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
    () => activeQuestions.filter((question) => isQuestionAnswered(question, answers[question.id] || {})).length,
    [activeQuestions, answers]
  );
  const currentQuestion = activeQuestions[activeIndex] || null;
  const allAnswered = activeQuestions.length > 0 && answeredCount === activeQuestions.length;
  const expandedPhase = isRetryable ? 'failed' : isStale ? 'stale' : allAnswered ? 'expanded-review' : 'expanded-question';
  const currentAnswer = currentQuestion ? (answers[currentQuestion.id] || {}) : {};
  const canAdvanceCurrent = currentQuestion ? isQuestionAnswered(currentQuestion, currentAnswer) : false;
  const dots = getQuestionStates(activeQuestions, activeIndex, answers);
  const collapsedSummary = interaction?.payload?.collapsed_summary
    || (answeredCount > 0 ? `已回答 ${answeredCount} / ${activeQuestions.length}` : '先确认几个问题');

  const footerHint = interaction?.payload?.footer_hint
    || (allAnswered ? '检查无误后再开始' : `${activeQuestions.length} 个问题，约 30 秒`);

  const updateAnswers = (updater) => {
    setAnswers((previous) => {
      const current = answerDraftRef.current || previous;
      const next = typeof updater === 'function' ? updater(current) : updater;
      answerDraftRef.current = next;
      onAnswerDraftChange?.(next);
      return next;
    });
  };

  const handleAnswerPatch = (questionId, patch = {}) => {
    updateAnswers((previous) => ({
      ...previous,
      [questionId]: {
        ...previous[questionId],
        ...patch,
      },
    }));
  };

  const selectOptionAndAdvance = (question, option) => {
    if (!question || !option || !isPending) return;
    const nextAnswers = {
      ...answers,
      [question.id]: {
        ...(answers[question.id] || {}),
        optionId: option.id,
        optionIds: [option.id],
        text: '',
        customText: '',
        label: option.label,
      },
    };
    updateAnswers(nextAnswers);
    const nextQuestions = visibleQuestions(questions, nextAnswers);
    const currentIndex = nextQuestions.findIndex((item) => item.id === question.id);
    if (currentIndex >= 0 && currentIndex < nextQuestions.length - 1) {
      setActiveIndex(currentIndex + 1);
      return;
    }
    setPhase('expanded-review');
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
      goToNextQuestion();
      return;
    }
    if (!allAnswered || !isPending || submitting) return;
    onSubmit?.(interaction, buildSubmitPayload());
  };

  const goToPreviousQuestion = () => {
    if (!isPending || phase !== 'expanded-question' || activeIndex <= 0) return;
    setActiveIndex((prev) => Math.max(prev - 1, 0));
  };

  const goToNextQuestion = () => {
    if (!isPending || phase !== 'expanded-question' || !canAdvanceCurrent) return;
    if (activeIndex < activeQuestions.length - 1) {
      setActiveIndex((prev) => Math.min(prev + 1, activeQuestions.length - 1));
      return;
    }
    setPhase('expanded-review');
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
    if (phase === 'expanded-question' && isPending) {
      const tag = String(event.target?.tagName || '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea') {
        if (event.key === 'ArrowLeft' && activeIndex > 0) {
          event.preventDefault();
          goToPreviousQuestion();
          return;
        }
        if (event.key === 'ArrowRight' && canAdvanceCurrent) {
          event.preventDefault();
          goToNextQuestion();
          return;
        }
      }
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

  if (!interaction || activeQuestions.length === 0) return null;

  if (phase === 'collapsed') {
    return (
      <section className={`notus-agent-question-card is-collapsed${narrow ? ' is-narrow' : ''}`} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} aria-label="提问卡片">
        <QuestionCardHeader
          title={interaction?.payload?.title || '需要你的回答'}
          summary={collapsedSummary}
          status={statusMeta.label}
          expanded={false}
          controlsId={`agent-question-${interaction.id}`}
          onToggle={() => setPhase(isRetryable ? 'failed' : isStale ? 'stale' : allAnswered ? 'expanded-review' : 'expanded-question')}
        />
      </section>
    );
  }

  return (
    <section
      onKeyDown={handleKeyDown}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className={`notus-agent-question-card${narrow ? ' is-narrow' : ''}`}
      aria-label="提问卡片"
    >
      <QuestionCardHeader
        title={interaction?.payload?.kicker || interaction?.payload?.title || '需要你的回答'}
        summary={phase === 'expanded-review' || phase === 'failed' ? `已回答 ${activeQuestions.length} 题` : `第 ${activeIndex + 1} / ${activeQuestions.length} 题`}
        status={statusMeta.label}
        expanded
        controlsId={`agent-question-${interaction.id}`}
        onToggle={() => setPhase('collapsed')}
      />

      {phase === 'stale' ? (
        <div id={`agent-question-${interaction.id}`} className="notus-agent-question-card__detail">
          <div className="notus-agent-question-card__title">
            当前内容已经变化
          </div>
          <div className="notus-agent-question-card__description">
            这张提问卡片对应的上下文已经失效，请重新发起一次请求。
          </div>
          <div className="notus-agent-question-card__actions">
            <Button type="button" variant="ghost" size="sm" className="notus-agent-pressable" onClick={() => onCancel?.(interaction)}>
              关闭
            </Button>
          </div>
        </div>
      ) : phase === 'expanded-question' ? (
        <div id={`agent-question-${interaction.id}`} className="notus-agent-question-card__detail">
          <div className="notus-agent-question-card__title">
            {getQuestionTitle(currentQuestion)}
          </div>
          <div className="notus-agent-question-card__options">
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
                  onClick={() => selectOptionAndAdvance(currentQuestion, option)}
                />
              );
            })}

            {currentQuestion.allow_custom || currentQuestion.type === 'text_input' ? (
              <div className={`notus-agent-question-card__custom${String(currentAnswer.customText || currentAnswer.text || '').trim() ? ' has-value' : ''}`}>
                <div className="notus-agent-question-card__custom-label">
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
                  className="notus-agent-question-card__custom-input"
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div id={`agent-question-${interaction.id}`} className="notus-agent-question-card__review">
          {(isRetryable ? activeQuestions.filter((question) => isQuestionAnswered(question, answers[question.id] || {})) : activeQuestions).map((question, index) => (
            <ReviewRow
              key={question.id}
              rowRef={(node) => {
                reviewRowRefs.current[index] = node;
              }}
              question={question}
              current={answers[question.id] || {}}
              index={index}
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

      <div className="notus-agent-question-card__footer">
        {phase === 'expanded-question' ? <Dots states={dots} /> : null}
        {phase !== 'expanded-question' && !narrow ? (
          <span className="notus-agent-question-card__hint">
            {phase === 'failed' ? '上次续跑失败了，可以直接重试。' : '点任意一行可以回去修改'}
          </span>
        ) : !narrow ? (
          <span className="notus-agent-question-card__hint">{footerHint}</span>
        ) : null}
        <div className="notus-agent-question-card__footer-spacer" />
        {(phase === 'expanded-question' && activeIndex > 0 && isPending) ? (
          <button
            type="button"
            aria-label="上一题"
            title="上一题（←）"
            onClick={goToPreviousQuestion}
            className="notus-agent-question-card__icon-action notus-agent-pressable"
          >
            <Icons.chevronRight size={11} style={{ transform: 'rotate(180deg)' }} />
          </button>
        ) : null}
        {(phase === 'expanded-review' || phase === 'failed') && onCancel ? (
          <Button type="button" variant="ghost" size="sm" className="notus-agent-pressable" onClick={() => onCancel(interaction)}>
            放弃
          </Button>
        ) : null}
        {isRetryable && phase === 'failed' ? (
          <Button type="button" variant="primary" size="sm" className="notus-agent-pressable" onClick={() => onRetry?.(interaction)}>
            {retryLabel}
          </Button>
        ) : null}
        {isPending && phase === 'expanded-question' && activeIndex < activeQuestions.length - 1 ? (
          <button
            type="button"
            aria-label="下一题"
            title="下一题（→）"
            disabled={!canAdvanceCurrent}
            onClick={goToNextQuestion}
            className="notus-agent-question-card__icon-action notus-agent-pressable"
          >
            <Icons.chevronRight size={13} />
          </button>
        ) : null}
        {isPending && !(phase === 'expanded-question' && activeIndex < activeQuestions.length - 1) ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={submitting}
            disabled={phase === 'expanded-question' ? !canAdvanceCurrent : !allAnswered}
            onClick={handlePrimaryAction}
            className="notus-agent-pressable"
          >
            {phase === 'expanded-question'
              ? '回顾答案'
              : submitLabel}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
