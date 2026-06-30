import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentLoopReasonLabel, getAgentToolLabel } from '../utils/agentDisplay';

function toPositiveInt(value) {
  const next = Number(value);
  return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
}

function makeMessageId(prefix = 'agent-loop') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function readSse(response, onEvent) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('服务未返回可读取的流');
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find((item) => item.trim().startsWith('data:'));
      if (!line) continue;
      const raw = line.replace(/^data:\s*/, '').trim();
      if (!raw) continue;
      await onEvent(JSON.parse(raw));
    }
  }

  if (buffer.trim()) {
    const line = buffer.split('\n').find((item) => item.trim().startsWith('data:'));
    if (line) {
      const raw = line.replace(/^data:\s*/, '').trim();
      if (raw) await onEvent(JSON.parse(raw));
    }
  }
}

async function readErrorResponse(response, fallback) {
  const text = await response.text().catch(() => '');
  const parsed = parseJson(text, null);
  return parsed?.error || parsed?.code || text || fallback;
}

function upsertStep(list = [], step = null) {
  if (!step) return list;
  const next = Array.isArray(list) ? list.map((item) => (
    step.status === 'running' && item.status === 'running' && item.id !== step.id
      ? { ...item, status: 'done' }
      : item
  )) : [];
  const index = next.findIndex((item) => item.id === step.id);
  if (index >= 0) next[index] = { ...next[index], ...step };
  else next.push(step);
  return next;
}

function completeSteps(list = []) {
  return (Array.isArray(list) ? list : []).map((step) => (
    step.status === 'running' ? { ...step, status: 'done' } : step
  ));
}

function toolLabel(name = '') {
  return getAgentToolLabel(name) || '执行工具';
}

function reasonLabel(reason = '') {
  return getAgentLoopReasonLabel(reason);
}

function buildEventStep(event = {}) {
  const loop = Number(event.loop_index || 0) || 0;
  if (event.type === 'session_created') {
    return {
      id: 'session',
      label: '创建 Agent 任务',
      status: 'done',
      detail: `已创建 Agentic Loop #${event.session_id}。`,
    };
  }
  if (event.type === 'session_resumed') {
    return {
      id: 'session',
      label: '恢复 Agent 任务',
      status: 'done',
      detail: `已恢复 Agentic Loop #${event.session_id}。`,
    };
  }
  if (event.type === 'snapshot_done') {
    return {
      id: 'snapshot',
      label: '生成文件快照',
      status: 'done',
      detail: `已记录 ${event.snapshot_count || 0} 个文件快照，用于冲突校验和回滚。`,
      tool: 'snapshotFiles',
      result: `${event.snapshot_count || 0} 个文件`,
    };
  }
  if (event.type === 'attachment_parse_start') {
    const source = String(event.source || '附件');
    return {
      id: `attachment-${source}`,
      label: event.source_kind === 'url' ? '解析网页链接' : '解析上传附件',
      status: 'running',
      detail: `正在读取：${source}`,
      tool: event.source_kind === 'url' ? 'parse_url' : 'parse_document',
      input: source,
    };
  }
  if (event.type === 'attachment_parse_done') {
    const source = String(event.source || '附件');
    const failed = event.status === 'error';
    const duplicate = Boolean(event.duplicate);
    return {
      id: `attachment-${source}`,
      label: event.source_kind === 'url' ? '解析网页链接' : '解析上传附件',
      status: failed ? 'error' : 'done',
      detail: failed
        ? (event.warning || '解析失败')
        : duplicate
          ? '已在本次对话中导入，跳过重复解析。'
          : `已读取 ${Number(event.textLength || 0)} 字。${event.warning ? `\n${event.warning}` : ''}`,
      tool: event.source_kind === 'url' ? 'parse_url' : 'parse_document',
      result: failed ? (event.errorCode || 'PARSE_FAILED') : `${Number(event.textLength || 0)} 字`,
    };
  }
  if (event.type === 'loop_start') {
    return {
      id: `loop-${loop}`,
      label: `执行第 ${loop || '?'} 轮`,
      status: 'running',
      detail: '正在让模型判断下一步需要调用的工具。',
    };
  }
  if (event.type === 'soft_limit_notice') {
    return {
      id: `soft-limit-${loop}`,
      label: '接近执行轮次提醒',
      status: 'done',
      detail: `当前已执行到第 ${loop || '?'} 轮，如任务仍未完成，后续可能需要确认是否继续。`,
    };
  }
  if (event.type === 'thinking') {
    return {
      id: `thinking-${loop || 'current'}`,
      label: '分析下一步',
      status: 'running',
      detail: event.text || '正在分析任务状态。',
    };
  }
  if (event.type === 'tool_start') {
    const id = `tool-${loop || 'x'}-${event.tool_name || 'unknown'}`;
    return {
      id,
      label: toolLabel(event.tool_name),
      status: 'running',
      detail: '正在执行工具调用。',
      tool: event.tool_name || '',
      input: event.tool_input_summary || '',
    };
  }
  if (event.type === 'tool_done') {
    const id = `tool-${loop || 'x'}-${event.tool_name || 'unknown'}`;
    return {
      id,
      label: toolLabel(event.tool_name),
      status: event.failed ? 'error' : 'done',
      detail: event.failed ? '工具调用失败。' : '工具调用已完成。',
      tool: event.tool_name || '',
      result: typeof event.result_summary === 'string'
        ? event.result_summary
        : JSON.stringify(event.result_summary || {}),
    };
  }
  if (event.type === 'waiting_preview_confirm') {
    return {
      id: 'waiting-preview',
      label: '等待确认修改预览',
      status: 'done',
      detail: '已生成文件修改预览，请确认后继续执行。',
      tool: 'preview_patch_files',
      result: event.operation_set_id ? `预览 #${event.operation_set_id}` : '预览已生成',
    };
  }
  if (event.type === 'interaction_request') {
    return {
      id: `question-card-${event.interaction?.id || loop || 'current'}`,
      label: '等待回答提问卡片',
      status: 'done',
      detail: '已生成提问卡片，请回答后继续执行。',
      tool: 'ask_question_card',
      result: event.interaction?.id ? `提问卡片 #${event.interaction.id}` : '提问卡片已生成',
    };
  }
  if (event.type === 'loop_done') {
    return {
      id: `loop-done-${event.reason || 'done'}`,
      label: reasonLabel(event.reason),
      status: ['goal_achieved', 'hard_limit_reached'].includes(event.reason) ? 'done' : 'error',
      detail: reasonLabel(event.reason),
    };
  }
  if (event.type === 'cancelled') {
    return {
      id: 'cancelled',
      label: '任务已取消',
      status: 'stopped',
      detail: '用户停止了当前 Agent 任务。',
    };
  }
  if (event.type === 'error') {
    return {
      id: 'error',
      label: '请求失败',
      status: 'error',
      detail: event.error || 'Agent Loop 请求失败',
    };
  }
  return null;
}

function normalizeOperationSets(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((item) => item?.id);
}

const FILE_MUTATION_TOOL_NAMES = new Set([
  'create_note',
  'preview_patch_files',
]);

export function useAgentLoopController({
  onAppendUserMessage,
  onAppendAssistantMessage,
  onConversationId,
  onConversationSettled,
  onOperationSets,
  onOperationSetHandled,
  onInteractionRequest,
  onApplySuccess,
  onRollbackSuccess,
  onFilesMayHaveChanged,
  onError,
} = {}) {
  const [pendingAgentTask, setPendingAgentTask] = useState(null);
  const [activeAgentSession, setActiveAgentSessionState] = useState(null);
  const [activeSteps, setActiveSteps] = useState([]);
  const [streamText, setStreamText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const controllerRef = useRef(null);
  const sessionRef = useRef(null);
  const stepsRef = useRef([]);
  const assistantTextRef = useRef('');
  const filesMayHaveChangedRef = useRef(false);

  useEffect(() => () => {
    controllerRef.current?.abort();
  }, []);

  const setActiveAgentSession = useCallback((patchOrUpdater) => {
    setActiveAgentSessionState((prev) => {
      const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(prev) : patchOrUpdater;
      const next = patch === null ? null : { ...(prev || {}), ...(patch || {}) };
      sessionRef.current = next;
      return next;
    });
  }, []);

  const setSteps = useCallback((updater) => {
    setActiveSteps((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      stepsRef.current = next;
      return next;
    });
  }, []);

  const appendStep = useCallback((step) => {
    if (!step) return;
    setSteps((prev) => upsertStep(prev, step));
  }, [setSteps]);

  const createAgentTask = useCallback((task) => {
    setError('');
    setPendingAgentTask({
      authorized_ops: ['modify', 'create'],
      authorized_paths: [''],
      search_knowledge_limit: 5,
      ...task,
      goal: String(task?.goal || '').trim(),
    });
  }, []);

  const cancelAgentTask = useCallback(() => {
    setPendingAgentTask(null);
  }, []);

  const clearActiveAgentSession = useCallback(() => {
    setPendingAgentTask(null);
    setActiveAgentSession(null);
    setSteps([]);
    setStreamText('');
    setError('');
  }, [setActiveAgentSession, setSteps]);

  const fetchSessionDetails = useCallback(async (sessionId, token) => {
    const id = toPositiveInt(sessionId);
    if (!id || !token) return null;
    const response = await fetch(`/api/agent/sessions/${id}?session_token=${encodeURIComponent(token)}`, {
      headers: { 'x-agent-session-token': token },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(await readErrorResponse(response, '读取 Agent 任务状态失败'));
    }
    const payload = await response.json();
    const session = payload.session ? { ...payload.session, token } : null;
    if (session) setActiveAgentSession(session);
    const operationSets = normalizeOperationSets(payload.operation_sets);
    if (operationSets.length > 0) onOperationSets?.(operationSets);
    return { ...payload, session, operation_sets: operationSets };
  }, [onOperationSets, setActiveAgentSession]);

  const appendAssistant = useCallback((message) => {
    onAppendAssistantMessage?.({
      id: makeMessageId('agent-loop-assistant'),
      role: 'assistant',
      content: '',
      ...message,
    });
  }, [onAppendAssistantMessage]);

  const notifyFilesMayHaveChanged = useCallback(async (context = {}) => {
    if (!filesMayHaveChangedRef.current) return;
    filesMayHaveChangedRef.current = false;
    await onFilesMayHaveChanged?.(context);
  }, [onFilesMayHaveChanged]);

  const startAgentLoop = useCallback(async (input, options = {}) => {
    const resumeSessionId = toPositiveInt(input?.session_id || input?.id);
    const resumeToken = input?.session_token || input?.token || sessionRef.current?.token || '';
    const isResume = Boolean(options.resume || resumeSessionId);
    const body = isResume
      ? {
        session_id: resumeSessionId,
        session_token: resumeToken,
        interaction_id: input?.interaction_id || input?.interactionId || undefined,
        llm_config_id: input?.llm_config_id || input?.llmConfigId || undefined,
      }
      : {
        goal: input?.goal,
        user_query: input?.user_query || input?.userQuery || input?.display_query || input?.displayQuery || input?.input_text || input?.inputText || '',
        display_query: input?.display_query || input?.displayQuery || input?.user_query || input?.userQuery || '',
        input_text: input?.input_text || input?.inputText || input?.user_query || input?.userQuery || input?.display_query || input?.displayQuery || '',
        kind: input?.kind || 'agent',
        authorized_paths: input?.authorized_paths || [''],
        authorized_ops: input?.authorized_ops || ['modify', 'create'],
        approval_mode: input?.approval_mode || input?.approvalMode || 'auto_confirm',
        conversation_id: input?.conversation_id || undefined,
        active_file_id: input?.active_file_id || undefined,
        llm_config_id: input?.llm_config_id || input?.llmConfigId || undefined,
        search_knowledge_limit: input?.search_knowledge_limit === undefined ? 5 : input.search_knowledge_limit,
        attachments: Array.isArray(input?.attachments) ? input.attachments : [],
        web_search_enabled: Boolean(input?.web_search_enabled ?? input?.webSearchEnabled),
        search_provider: input?.search_provider || input?.searchProvider || undefined,
        tool_profile: input?.tool_profile || input?.toolProfile || undefined,
      };

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    assistantTextRef.current = '';
    filesMayHaveChangedRef.current = false;
    setLoading(true);
    setError('');
    setStreamText('');
    setSteps([]);
    if (!isResume) setPendingAgentTask(null);

    if (options.appendUserMessage && input?.goal) {
      onAppendUserMessage?.({
        id: makeMessageId('agent-loop-user'),
        role: 'user',
        content: input.display_query || input.user_query || input.goal,
        attachments: input.attachments || [],
        meta: {
          agent_loop: true,
          route_reason: input.route_reason || '',
          web_search_enabled: Boolean(input?.web_search_enabled ?? input?.webSearchEnabled),
          search_provider: input?.search_provider || input?.searchProvider || null,
        },
      });
    }

    try {
      const response = await fetch('/api/agent/loop/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(await readErrorResponse(response, 'Agent Loop 请求失败'));
      }

      await readSse(response, async (event) => {
        const step = buildEventStep(event);
        if (step) appendStep(step);
        if (event.conversation_id) {
          onConversationId?.(Number(event.conversation_id));
        }
        if (
          FILE_MUTATION_TOOL_NAMES.has(event.tool_name)
          || (Array.isArray(event.changed_files) && event.changed_files.length > 0)
        ) {
          filesMayHaveChangedRef.current = true;
        }

        if (event.type === 'session_created') {
          setActiveAgentSession({
            id: event.session_id,
            token: event.session_token,
            conversation_id: event.conversation_id || null,
            status: 'running',
            loop_count: 0,
            reason: '',
          });
        } else if (event.type === 'session_resumed') {
          setActiveAgentSession((prev) => ({
            id: event.session_id || resumeSessionId,
            token: resumeToken || prev?.token,
            conversation_id: event.conversation_id || prev?.conversation_id || null,
            status: 'running',
            reason: '',
          }));
        } else if (event.type === 'loop_start') {
          setActiveAgentSession((prev) => ({
            status: 'running',
            loop_count: Number(event.loop_index || prev?.loop_count || 0),
            reason: '',
          }));
        } else if (event.type === 'thinking') {
          const text = String(event.text || '').trim();
          if (text) {
            assistantTextRef.current = assistantTextRef.current
              ? `${assistantTextRef.current}\n${text}`
              : text;
            setStreamText(assistantTextRef.current);
          }
        } else if (event.type === 'waiting_preview_confirm') {
          const current = sessionRef.current || {};
          const token = current.token || resumeToken;
          setActiveAgentSession({
            id: event.session_id || current.id,
            token,
            conversation_id: event.conversation_id || current.conversation_id || null,
            status: 'waiting_confirm',
            reason: 'waiting_preview_confirm',
            operation_set_id: event.operation_set_id || null,
          });
          let operationSet = null;
          try {
            const detail = await fetchSessionDetails(event.session_id || current.id, token);
            operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => (
              Number(item.id) === Number(event.operation_set_id)
            )) || normalizeOperationSets(detail?.operation_sets)[0] || null;
          } catch {}
          appendAssistant({
            content: '已生成批量修改预览，请确认后继续。',
            meta: {
              agent_loop: true,
              session_id: event.session_id || current.id,
              operation_set_id: event.operation_set_id || operationSet?.id || null,
            },
            operationSet,
            toolSteps: completeSteps(stepsRef.current),
          });
          setStreamText('');
          setLoading(false);
        } else if (event.type === 'interaction_request') {
          const current = sessionRef.current || {};
          const token = current.token || resumeToken;
          setActiveAgentSession({
            id: event.session_id || current.id,
            token,
            conversation_id: event.conversation_id || current.conversation_id || null,
            status: 'waiting_confirm',
            reason: event.reason || 'question_card_requested',
            interaction_id: event.interaction?.id || event.interaction_id || null,
          });
          if (event.interaction) onInteractionRequest?.(event.interaction);
          setStreamText('');
          setLoading(false);
        } else if (event.type === 'loop_done') {
          const current = sessionRef.current || {};
          const hardLimit = event.reason === 'hard_limit_reached';
          const waitingQuestionCard = event.reason === 'question_card_requested';
          const failed = ['consecutive_tool_failure', 'deadloop_detected', 'no_progress'].includes(event.reason);
          let operationSet = null;
          if (event.operation_set_id) {
            try {
              const detail = await fetchSessionDetails(event.session_id || current.id, current.token || resumeToken);
              operationSet = normalizeOperationSets(detail?.operation_sets).find((item) => (
                Number(item.id) === Number(event.operation_set_id)
              )) || null;
            } catch {}
          }
          setActiveAgentSession({
            id: event.session_id || current.id,
            token: current.token || resumeToken,
            conversation_id: event.conversation_id || current.conversation_id || null,
            status: hardLimit || waitingQuestionCard ? 'waiting_confirm' : failed ? 'failed' : 'completed',
            loop_count: Number(event.loop_index || current.loop_count || 0),
            reason: event.reason || '',
            interaction_id: event.interaction_id || current.interaction_id || null,
          });
          setSteps((prev) => completeSteps(upsertStep(prev, buildEventStep(event))));
          appendAssistant({
            content: assistantTextRef.current || reasonLabel(event.reason),
            meta: {
              agent_loop: true,
              session_id: event.session_id || current.id,
              status: hardLimit || waitingQuestionCard ? 'waiting_confirm' : failed ? 'failed' : 'completed',
              reason: event.reason || '',
              interaction_id: event.interaction_id || current.interaction_id || null,
              operation_set_id: event.operation_set_id || operationSet?.id || null,
            },
            operationSet,
            toolSteps: completeSteps(stepsRef.current),
          });
          setStreamText('');
          setLoading(false);
          onConversationSettled?.(event.conversation_id || current.conversation_id || null);
          await notifyFilesMayHaveChanged({ reason: event.reason || 'loop_done', event });
        } else if (event.type === 'cancelled') {
          setActiveAgentSession((prev) => ({ status: 'cancelled', reason: 'cancelled' }));
          setSteps((prev) => completeSteps(upsertStep(prev, buildEventStep(event))));
          setStreamText('');
          setLoading(false);
          await notifyFilesMayHaveChanged({ reason: 'cancelled', event });
        } else if (event.type === 'error') {
          const nextError = new Error(event.error || 'Agent Loop 请求失败');
          nextError.code = event.code;
          throw nextError;
        }
      });
    } catch (nextError) {
      if (nextError.name === 'AbortError') {
        appendStep(buildEventStep({ type: 'cancelled' }));
      } else {
        const message = nextError.message || 'Agent Loop 请求失败';
        setError(message);
        appendStep(buildEventStep({ type: 'error', error: message }));
        onError?.(nextError);
      }
      setStreamText('');
      setLoading(false);
      await notifyFilesMayHaveChanged({
        reason: nextError.name === 'AbortError' ? 'cancelled' : 'error',
        error: nextError,
      });
      if (nextError.name === 'AbortError') return;
      throw nextError;
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [
    appendAssistant,
    appendStep,
    fetchSessionDetails,
    notifyFilesMayHaveChanged,
    onAppendUserMessage,
    onConversationId,
    onConversationSettled,
    onError,
    onInteractionRequest,
    setActiveAgentSession,
    setSteps,
  ]);

  const confirmAgentTask = useCallback(async (task) => {
    const target = task || pendingAgentTask;
    if (!target?.goal) return;
    try {
      await startAgentLoop(target, { appendUserMessage: true });
    } catch {}
  }, [pendingAgentTask, startAgentLoop]);

  const runOperationSetAction = useCallback(async (operationSet, action, options = {}) => {
    const session = sessionRef.current;
    if (!session?.id || !session?.token) throw new Error('缺少 Agent 任务状态，无法处理预览');
    const operationSetId = operationSet?.id || session.operation_set_id;
    if (!operationSetId) throw new Error('缺少修改预览 ID');
    const response = await fetch('/api/agent/loop/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        session_id: session.id,
        session_token: session.token,
        operation_set_id: operationSetId,
        current_conversation_id: options.currentConversationId || session.conversation_id || undefined,
        action,
        patch_index: options.patchIndex === undefined ? undefined : options.patchIndex,
        file_path: options.filePath || undefined,
        force: Boolean(options.force),
        approval_mode: options.approvalMode || undefined,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.success) {
      if (payload.conflict) {
        throw new Error('文件已经变化，请检查冲突后重新确认');
      }
      throw new Error(payload.error || payload.code || '处理修改失败');
    }
    onOperationSetHandled?.(operationSetId, action, payload.operation_set || null);
    if (['apply', 'apply_all', 'apply_file'].includes(action)) {
      await onApplySuccess?.(payload, operationSet);
    } else if (action === 'rollback_file') {
      await onRollbackSuccess?.(payload, operationSet);
    }
    if (payload.session) setActiveAgentSession({ ...payload.session, token: session.token });
    return payload;
  }, [onApplySuccess, onOperationSetHandled, onRollbackSuccess, setActiveAgentSession]);

  const applyOperationSet = useCallback((operationSet, options = {}) => (
    runOperationSetAction(operationSet, options.action || 'apply_all', options)
  ), [runOperationSetAction]);

  const applyOperationFile = useCallback((operationSet, patchIndex, options = {}) => (
    runOperationSetAction(operationSet, 'apply_file', { ...options, patchIndex })
  ), [runOperationSetAction]);

  const rollbackOperationFile = useCallback((operationSet, patchIndex, options = {}) => (
    runOperationSetAction(operationSet, 'rollback_file', { ...options, patchIndex })
  ), [runOperationSetAction]);

  const discardPendingOperationSet = useCallback((operationSet, options = {}) => (
    runOperationSetAction(operationSet, 'discard_pending', options)
  ), [runOperationSetAction]);

  const rejectOperationSet = useCallback(async (operationSet) => {
    const session = sessionRef.current;
    if (!session?.id || !session?.token) return;
    const operationSetId = operationSet?.id || session.operation_set_id;
    const response = await fetch('/api/agent/loop/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: session.id,
        session_token: session.token,
        operation_set_id: operationSetId || undefined,
        action: 'reject',
      }),
    });
    if (!response.ok) {
      throw new Error(await readErrorResponse(response, '撤销预览失败'));
    }
    if (operationSetId) onOperationSetHandled?.(operationSetId, 'cancelled');
    setActiveAgentSession({ status: 'cancelled', reason: 'cancelled' });
  }, [onOperationSetHandled, setActiveAgentSession]);

  const extendAgentSession = useCallback(async (sessionInput = null) => {
    try {
      const session = sessionInput || sessionRef.current;
      const token = session?.token || sessionRef.current?.token;
      if (!session?.id || !token) return;
      const response = await fetch('/api/agent/loop/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: session.id,
          session_token: token,
          action: 'extend',
          extra_loops: 10,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || payload.code || '继续执行失败');
      }
      await startAgentLoop({ session_id: session.id, session_token: token }, { resume: true });
    } catch (extendError) {
      const message = extendError.message || '继续执行失败';
      setError(message);
      onError?.(extendError);
    }
  }, [onError, startAgentLoop]);

  const rollbackAgentSession = useCallback(async (sessionInput = null) => {
    try {
      const session = sessionInput || sessionRef.current;
      const token = session?.token || sessionRef.current?.token;
      if (!session?.id || !token) return;
      const response = await fetch('/api/agent/sessions/' + session.id + '/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: token }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || payload.code || '回滚任务失败');
      }
      setActiveAgentSession({ status: 'rolled_back', reason: 'rolled_back' });
      await onRollbackSuccess?.(payload, session);
    } catch (rollbackError) {
      const message = rollbackError.message || '回滚任务失败';
      setError(message);
      onError?.(rollbackError);
    }
  }, [onError, onRollbackSuccess, setActiveAgentSession]);

  const stopAgentLoop = useCallback(async () => {
    controllerRef.current?.abort();
    const session = sessionRef.current;
    setLoading(false);
    setStreamText('');
    setSteps((prev) => upsertStep(completeSteps(prev), buildEventStep({ type: 'cancelled' })));
    if (!session?.id || !session?.token) {
      setActiveAgentSession((prev) => (prev ? { status: 'cancelled', reason: 'cancelled' } : prev));
      return;
    }
    try {
      await fetch('/api/agent/loop/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session.id, session_token: session.token }),
      });
    } catch {}
    setActiveAgentSession({ status: 'cancelled', reason: 'cancelled' });
  }, [setActiveAgentSession, setSteps]);

  return {
    pendingAgentTask,
    activeAgentSession,
    activeSteps,
    streamText,
    loading,
    error,
    createAgentTask,
    cancelAgentTask,
    clearActiveAgentSession,
    confirmAgentTask,
    startAgentLoop,
    stopAgentLoop,
    applyOperationSet,
    applyOperationFile,
    rollbackOperationFile,
    discardPendingOperationSet,
    rejectOperationSet,
    extendAgentSession,
    rollbackAgentSession,
    fetchSessionDetails,
  };
}
