import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentWorkspace } from './AgentWorkspace';
import { ClarifyDrawer } from '../ChatArea/ClarifyDrawer';
import { ConversationDrawer } from '../ChatArea/ConversationDrawer';
import { IconButton } from '../ui/IconButton';
import { Icons } from '../ui/Icons';
import { Spinner } from '../ui/Spinner';
import { Tooltip } from '../ui/Tooltip';
import { AiLockedState } from '../ui/AiLockedState';
import { useToast } from '../ui/Toast';
import { useAppStatus } from '../../contexts/AppStatusContext';
import { buildRestoredAgentTimeline, useAgentLoopController } from '../../hooks/useAgentLoopController';
import { useLlmConfigs } from '../../hooks/useLlmConfigs';
import { useStableAiReadiness } from '../../hooks/useStableAiReadiness';
import { deriveAiReadiness } from '../../utils/aiReadiness';
import { mapConversationMessages } from '../../utils/conversations';
import {
  buildConversationExportFileName,
  downloadTextFile,
  formatConversationExportMarkdown,
} from '../../utils/conversationExport';
import { readApiResponse } from '../../utils/http';
import { useSettingsDialog } from '../../contexts/SettingsDialogContext';
import { segmentsToAgentInput } from '../../utils/messageMentions';
import { normalizeConversationId, readActiveConversationId, saveActiveConversationId } from '../../utils/activeConversationPersistence';
import { dispatchAgentResourceChange } from '../../utils/agentResourceEvents';
import { shouldClearAgentPresentation } from '../../utils/agentSessionRestore';

const CONFIRM_MODE_STORAGE_KEY = 'notus-files-agent-confirm-mode';
const AUTO_CONFIRM = 'auto_confirm';
const MANUAL_CONFIRM = 'manual_confirm';

function readConfirmMode() {
  if (typeof window === 'undefined') return AUTO_CONFIRM;
  try {
    return window.localStorage.getItem(CONFIRM_MODE_STORAGE_KEY) === MANUAL_CONFIRM
      ? MANUAL_CONFIRM
      : AUTO_CONFIRM;
  } catch {
    return AUTO_CONFIRM;
  }
}

function upsertById(list = [], item = null) {
  if (!item) return list;
  const id = String(item.id || item.operation_set_id || '');
  if (!id) return [...list, item];
  const index = list.findIndex((entry) => String(entry?.id || entry?.operation_set_id || '') === id);
  if (index < 0) return [...list, item];
  const next = [...list];
  next[index] = { ...next[index], ...item };
  return next;
}

function collectConversationOperationSets(payload = {}) {
  const sessionSets = (Array.isArray(payload?.agent_sessions) ? payload.agent_sessions : [])
    .flatMap((session) => Array.isArray(session?.operation_sets) ? session.operation_sets : []);
  return [...(Array.isArray(payload?.pending_operation_sets) ? payload.pending_operation_sets : []), ...sessionSets]
    .reduce((items, operationSet) => upsertById(items, operationSet), []);
}

function timelineFromSession(session = {}) {
  const restored = buildRestoredAgentTimeline(session);
  const activeSteps = Array.isArray(restored.steps) ? restored.steps : [];
  const streamText = session.status === 'completed' ? '' : String(restored.draft || '');
  if (activeSteps.length === 0 && !streamText) return null;
  const sessionId = String(session.id || '');
  if (!sessionId) return null;
  return {
    sessionId,
    userMessageId: Number(session?.task?.user_message_id || session?.user_message_id || 0) || null,
    activeSteps,
    streamText,
    loading: false,
    sessionStatus: session.status || '',
  };
}

function mapFileMention(file) {
  const path = String(file?.path || '').trim();
  const title = String(file?.title || '').trim();
  const fileName = String(file?.name || path.split('/').pop() || '').trim();
  const name = fileName || title || '未命名文件';
  return {
    value: String(file?.id || path),
    id: String(file?.id || path),
    name,
    path,
    type: 'file',
    token: `@{${path}}`,
    label: name,
    preview: path,
    kind: 'file',
    searchText: [fileName, title, path].filter(Boolean).join(' '),
  };
}

function collectFileMentions(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    if (node?.type === 'file') return [mapFileMention(node)];
    return collectFileMentions(node?.children || []);
  });
}

function mapSkillMention(skill) {
  const id = String(skill?.id || '').trim();
  const name = String(skill?.name || '未命名 Skill').trim();
  if (!id) return null;
  return {
    value: `skill:${id}`,
    id,
    name,
    path: id,
    type: 'skill',
    token: `@{skill:${id}}`,
    label: name,
    preview: `${skill?.description || '本地 Skill'} · ${skill?.source_label || '本机'}`,
    description: String(skill?.description || '未提供 Skill 描述'),
    kind: 'skill',
    searchText: `${name} ${skill?.description || ''} ${skill?.source_label || ''}`,
  };
}

function collectFolderMentions(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    if (node?.type !== 'folder') return [];
    const path = String(node.path || '').trim();
    const name = String(node.name || node.title || path || '未命名目录').trim();
    const current = path ? [{
      value: `folder:${path}`,
      id: `folder:${path}`,
      name,
      path,
      type: 'folder',
      token: `@{folder:${path}}`,
      label: name,
      preview: path,
      kind: 'folder',
      searchText: `${name} ${path}`,
    }] : [];
    return current.concat(collectFolderMentions(node.children));
  });
}

function collectFolderMentionsFromFiles(files = []) {
  const folderPaths = new Set();
  (Array.isArray(files) ? files : []).forEach((file) => {
    const parts = String(file?.path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    parts.slice(0, -1).forEach((_, index) => {
      folderPaths.add(parts.slice(0, index + 1).join('/'));
    });
  });
  return [...folderPaths].map((path) => ({
    value: `folder:${path}`,
    id: `folder:${path}`,
    name: path.split('/').pop() || path,
    path,
    type: 'folder',
    token: `@{folder:${path}}`,
    label: path.split('/').pop() || path,
    preview: path,
    kind: 'folder',
    searchText: path,
  }));
}

function dedupeMentionOptions(options = []) {
  const seen = new Set();
  return (Array.isArray(options) ? options : []).filter((option) => {
    const key = String(option?.token || option?.value || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function McpApprovalDrawer({ interaction, submitting, onDecision }) {
  const approval = interaction?.payload?.approval || {};
  const serverName = approval.server_name || 'MCP Server';
  const toolName = approval.tool_name || '未知工具';
  const input = approval.input && typeof approval.input === 'object' ? JSON.stringify(approval.input, null, 2) : '';
  const options = [
    { id: 'once', label: '仅本次允许', description: '只允许下一次相同工具调用。' },
    { id: 'session', label: '本次任务允许', description: '当前 Agent session 内允许。' },
    { id: 'always', label: '以后默认允许', description: '保存为此 Server 工具的默认允许。' },
    { id: 'deny', label: '拒绝', description: '继续任务，但不调用该工具。' },
  ];
  return (
    <section aria-label="MCP 工具授权" style={{ width: 'min(620px, 100%)', margin: '0 auto', padding: 16, border: '1px solid var(--border-subtle)', borderRadius: 16, background: 'var(--bg-elevated)', boxShadow: '0 -12px 30px rgba(45,45,45,0.10)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}><Icons.mcp size={17} style={{ color: 'var(--accent)' }} />允许 MCP 工具调用？</div>
      <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.65, color: 'var(--text-secondary)' }}><strong>{serverName}</strong> 想调用 <code>{toolName}</code>。MCP 返回内容属于外部数据，授权只适用于这项工具调用。</div>
      {input ? <pre style={{ margin: '10px 0 0', maxHeight: 118, overflow: 'auto', padding: 10, borderRadius: 10, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{input}</pre> : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginTop: 12 }}>{options.map((option) => <button key={option.id} type="button" disabled={submitting} onClick={() => onDecision?.(option.id)} style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '9px 10px', background: option.id === 'deny' ? 'var(--bg-secondary)' : 'var(--bg-primary)', color: option.id === 'deny' ? 'var(--text-secondary)' : 'var(--text-primary)', textAlign: 'left', cursor: submitting ? 'wait' : 'pointer' }}><span style={{ display: 'block', fontSize: 12, fontWeight: 700 }}>{option.label}</span><span style={{ display: 'block', marginTop: 3, fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>{option.description}</span></button>)}</div>
    </section>
  );
}

function ResourceApprovalDrawer({ interaction, submitting, onDecision, onPhaseChange }) {
  const payload = interaction?.payload || {};
  const actionLabels = { skill_install: '安装 Skill', skill_update: '覆盖修订 Skill', skill_uninstall: '卸载 Skill', skill_disable: '停用外部 Skill', mcp_remove: '删除 MCP Server' };
  const detail = [payload.target ? `目标：${payload.target}` : '', Array.isArray(payload.files) && payload.files.length ? `文件：${payload.files.join('、')}` : ''].filter(Boolean).join('；');
  const cardInteraction = {
    ...interaction,
    payload: {
      ...payload,
      title: `确认${actionLabels[payload.action] || '资源操作'}？`,
      kicker: 'Agent 需要你确认',
      submit_label: '确认执行',
      footer_hint: detail || '确认后将继续当前 Agent 任务',
      collapsed_summary: detail || '等待确认',
      questions: [{ id: 'resource_decision', label: detail || '是否继续执行该操作？', type: 'single_select', required: true, allow_custom: false, options: [{ id: 'confirm', label: '确认执行', description: '执行这项资源操作。', answer_value: 'confirm' }, { id: 'cancel', label: '取消', description: '不执行，保留草稿。', answer_value: 'cancel' }] }],
    },
  };
  return <ClarifyDrawer interaction={cardInteraction} submitting={submitting} submitLabel="确认执行" onPhaseChange={onPhaseChange} onSubmit={(_, answers) => onDecision?.(answers?.resource_decision?.option_id === 'confirm' ? 'confirm' : 'cancel')} onRetry={() => {}} onCancel={() => onDecision?.('cancel')} />;
}

export function FileAgentWorkspace({ allFiles = [], fileTree = [], refreshFiles, onFilesChanged, onAgentPanelLockChange, beforeAgentRun, fullWidth = false, onOpenDiffFile }) {
  const { openSettings } = useSettingsDialog();
  const toast = useToast();
  const { status: appStatus, loading: appStatusLoading } = useAppStatus();
  const { configs: llmConfigs, activeConfigId, loading: llmConfigsLoading, setActiveConfig } = useLlmConfigs();
  const [messages, setMessages] = useState([]);
  const [conversationList, setConversationList] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [restoringConversation, setRestoringConversation] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState(null);
  const [exportingConversationId, setExportingConversationId] = useState(null);
  const [pendingOperationSets, setPendingOperationSets] = useState([]);
  const [pendingInteractions, setPendingInteractions] = useState([]);
  const [agentResumeJobs, setAgentResumeJobs] = useState([]);
  const [restoredAgentSessions, setRestoredAgentSessions] = useState([]);
  const [interactionAnswerDrafts, setInteractionAnswerDrafts] = useState({});
  const [interactionSubmittingId, setInteractionSubmittingId] = useState(null);
  const [clarifyPhase, setClarifyPhase] = useState('expanded-question');
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState(null);
  const [agentConfirmMode, setAgentConfirmMode] = useState(() => readConfirmMode());
  const [skills, setSkills] = useState([]);
  const restoredConversationRef = useRef(false);
  const autoResumedJobRef = useRef(new Set());
  const subscribedSessionIdsRef = useRef(new Set());
  const conversationLoadSequenceRef = useRef(0);
  const agentLoopRef = useRef(null);
  const [liveSessionTimelines, setLiveSessionTimelines] = useState({});
  const resumeAgentTaskInFlightRef = useRef(false);

  const aiState = deriveAiReadiness({
    appStatus,
    appStatusLoading,
    llmConfigs,
    llmConfigsLoading,
  });
  const aiUiState = useStableAiReadiness(aiState);
  const mentionOptions = useMemo(() => dedupeMentionOptions([
    ...collectFileMentions(fileTree),
    ...allFiles.map(mapFileMention).filter((item) => item.preview),
    ...collectFolderMentions(fileTree),
    ...collectFolderMentionsFromFiles(allFiles),
    ...skills.map(mapSkillMention).filter(Boolean),
  ]), [allFiles, fileTree, skills]);
  const restoredSessionTimelines = useMemo(() => restoredAgentSessions.reduce((timelines, session) => {
    const timeline = timelineFromSession(session);
    if (timeline) timelines[timeline.sessionId] = timeline;
    return timelines;
  }, {}), [restoredAgentSessions]);

  useEffect(() => {
    let cancelled = false;
    const refreshSkills = () => fetch('/api/skills', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : { skills: [] })
      .then((payload) => {
        if (!cancelled) setSkills((Array.isArray(payload?.skills) ? payload.skills : []).filter((skill) => skill?.enabled && skill?.status === 'valid'));
      })
      .catch(() => { if (!cancelled) setSkills([]); });
    refreshSkills();
    window.addEventListener('notus-skills-changed', refreshSkills);
    return () => { cancelled = true; window.removeEventListener('notus-skills-changed', refreshSkills); };
  }, []);
  const operationSetById = useMemo(() => Object.fromEntries(
    pendingOperationSets.map((item) => [String(item.id || item.operation_set_id), item])
  ), [pendingOperationSets]);
  const operationSetBySessionId = useMemo(() => pendingOperationSets.reduce((items, item) => {
    const sessionId = String(item?.agent_session_id || item?.session_id || '');
    if (sessionId) items[sessionId] = item;
    return items;
  }, {}), [pendingOperationSets]);
  const activeInteraction = useMemo(() => {
    const rows = [...pendingInteractions].reverse();
    return rows.find((item) => item.status === 'pending')
      || rows.find((item) => item.status === 'failed')
      || rows.find((item) => item.status === 'stale')
      || null;
  }, [pendingInteractions]);

  useEffect(() => {
    if (llmConfigs.length === 0) {
      setSelectedLlmConfigId(null);
      return;
    }
    setSelectedLlmConfigId((previous) => {
      if (previous && llmConfigs.some((item) => String(item.id) === String(previous))) return previous;
      if (activeConfigId && llmConfigs.some((item) => String(item.id) === String(activeConfigId))) return activeConfigId;
      return llmConfigs[0]?.id || null;
    });
  }, [activeConfigId, llmConfigs]);

  const fetchConversationList = useCallback(async (query = '') => {
    const params = new URLSearchParams({ kind: 'canvas', limit: '80' });
    if (String(query || '').trim()) params.set('q', String(query).trim());
    const response = await fetch(`/api/conversations?${params.toString()}`, { cache: 'no-store' });
    const payload = await readApiResponse(response, '读取对话列表失败');
    return Array.isArray(payload) ? payload : [];
  }, []);

  const setPersistedActiveConversationId = useCallback((conversationId) => {
    const nextId = normalizeConversationId(conversationId);
    setActiveConversationId(nextId);
    saveActiveConversationId(nextId);
  }, []);

  const refreshConversationList = useCallback(async (preferredId = null, query = historySearchQuery) => {
    const rows = await fetchConversationList(query);
    setConversationList(rows);
    if (preferredId && rows.some((item) => Number(item.id) === Number(preferredId))) {
      setPersistedActiveConversationId(preferredId);
    }
    return rows;
  }, [fetchConversationList, historySearchQuery, setPersistedActiveConversationId]);

  const loadConversation = useCallback(async (conversationId) => {
    const loadSequence = conversationLoadSequenceRef.current + 1;
    conversationLoadSequenceRef.current = loadSequence;
    setRestoringConversation(true);
    // 对话切换只解绑本地流，不取消服务端任务。这样目标对话不会继承旧会话的
    // loading/session 锁，返回原对话时仍能看到并继续可恢复任务。
    agentLoopRef.current?.clearActiveAgentSession();
    setPendingInteractions([]);
    setAgentResumeJobs([]);
    setRestoredAgentSessions([]);
    setLiveSessionTimelines({});
    subscribedSessionIdsRef.current.clear();
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { cache: 'no-store' });
      const payload = await readApiResponse(response, '读取对话详情失败');
      if (loadSequence !== conversationLoadSequenceRef.current) return null;
      setMessages(mapConversationMessages(payload.messages, 'canvas'));
      setPendingOperationSets(collectConversationOperationSets(payload));
      setPendingInteractions(Array.isArray(payload.pending_interactions) ? payload.pending_interactions : []);
      setAgentResumeJobs(Array.isArray(payload.agent_resume_jobs) ? payload.agent_resume_jobs : []);
      setRestoredAgentSessions(Array.isArray(payload.agent_sessions) ? payload.agent_sessions : []);
      setPersistedActiveConversationId(conversationId);
      setHistoryDrawerOpen(false);
      return payload;
    } finally {
      if (loadSequence === conversationLoadSequenceRef.current) setRestoringConversation(false);
    }
  }, [setPersistedActiveConversationId]);

  useEffect(() => {
    let cancelled = false;
    const savedId = readActiveConversationId();
    if (savedId) setRestoringConversation(true);
    setConversationListLoading(true);
    fetchConversationList()
      .then(async (rows) => {
        if (cancelled) return;
        setConversationList(rows);
        if (restoredConversationRef.current) return;
        restoredConversationRef.current = true;
        if (!savedId) return;
        if (!rows.some((item) => Number(item.id) === savedId)) {
          saveActiveConversationId(null);
          return;
        }
        try {
          await loadConversation(savedId);
        } catch {
          saveActiveConversationId(null);
        }
      })
      .catch(() => {
        if (!cancelled) setConversationList([]);
      })
      .finally(() => {
        if (!cancelled) {
          setConversationListLoading(false);
          setRestoringConversation(false);
        }
      });
    return () => { cancelled = true; };
  }, [fetchConversationList, loadConversation]);

  useEffect(() => {
    if (!historyDrawerOpen) return undefined;
    const timer = window.setTimeout(() => {
      setConversationListLoading(true);
      fetchConversationList(historySearchQuery)
        .then((rows) => setConversationList(rows))
        .catch(() => setConversationList([]))
        .finally(() => setConversationListLoading(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [fetchConversationList, historyDrawerOpen, historySearchQuery]);

  useEffect(() => {
    if (!historyDrawerOpen) return undefined;
    const timer = window.setInterval(() => {
      fetchConversationList(historySearchQuery)
        .then((rows) => setConversationList(rows))
        .catch(() => {});
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [fetchConversationList, historyDrawerOpen, historySearchQuery]);

  const notifyFilesChanged = useCallback(async () => {
    await refreshFiles?.({ background: true });
    await onFilesChanged?.();
  }, [onFilesChanged, refreshFiles]);

  const handleOperationSets = useCallback((operationSets = []) => {
    setPendingOperationSets((previous) => (
      (Array.isArray(operationSets) ? operationSets : []).reduce((next, item) => upsertById(next, item), previous)
    ));
  }, []);

  const handleOperationSetHandled = useCallback((operationSetId, _action, operationSet = null) => {
    if (operationSet) setPendingOperationSets((previous) => upsertById(previous, operationSet));
    setMessages((previous) => previous.map((message) => (
      Number(message?.meta?.operation_set_id || 0) === Number(operationSetId)
        ? { ...message, operationSet: operationSet || message.operationSet || null }
        : message
    )));
  }, []);

  const handleSessionTimeline = useCallback((timeline) => {
    const sessionId = String(timeline?.sessionId || '');
    if (!sessionId) return;
    setLiveSessionTimelines((previous) => ({ ...previous, [sessionId]: timeline }));
  }, []);

  const agentLoop = useAgentLoopController({
    onAppendUserMessage: (message) => setMessages((previous) => {
      const messageId = String(message?.id || '');
      const clientMessageId = String(message?.clientMessageId || '');
      const index = previous.findIndex((item) => String(item?.id || '') === messageId
        || (clientMessageId && String(item?.clientMessageId || '') === clientMessageId));
      if (index < 0) return [...previous, message];
      const next = [...previous];
      next[index] = { ...next[index], ...message };
      return next;
    }),
    onAppendAssistantMessage: (message) => setMessages((previous) => upsertById(previous, message)),
    onInteractionRequest: (interaction) => {
      setPendingInteractions((previous) => upsertById(previous, interaction));
      refreshConversationList().catch(() => {});
    },
    onConversationId: (conversationId) => {
      if (conversationId) setPersistedActiveConversationId(conversationId);
    },
    onConversationSettled: (conversationId) => {
      if (conversationId) refreshConversationList(Number(conversationId)).catch(() => {});
    },
    onOperationSets: handleOperationSets,
    onOperationSetHandled: handleOperationSetHandled,
    onApplySuccess: notifyFilesChanged,
    onRollbackSuccess: notifyFilesChanged,
    onFilesMayHaveChanged: notifyFilesChanged,
    onError: (error) => toast(error.message || 'Agent 请求失败', 'error'),
    onSessionTimeline: handleSessionTimeline,
  });
  agentLoopRef.current = agentLoop;
  const sessionTimelines = useMemo(() => ({
    ...restoredSessionTimelines,
    ...liveSessionTimelines,
  }), [liveSessionTimelines, restoredSessionTimelines]);
  const restoreAgentSession = agentLoop.restoreAgentSession;
  const resumeAgentLoop = agentLoop.startAgentLoop;
  const activeAgentSessionId = String(agentLoop.activeAgentSession?.id || '');
  const sessionLocked = agentLoop.activeAgentSession?.status === 'running';
  // 只有真实在途请求才锁输入。可恢复错误、断线续跑和额度等待都已经停住，
  // 应保留工具链续跑入口，同时允许用户发送新消息或切到新对话。
  // 任务独立于界面可见性；只在正在提交同一张卡片时短暂阻止重复切换。
  const agentPanelLocked = Boolean(interactionSubmittingId);
  const agentPanelLockMessage = sessionLocked ? '任务仍在后台执行，正在保存提问卡片回答，请稍候。' : '正在保存提问卡片回答，请稍候。';
  const agentPresentationRef = useRef({
    activeSession: agentLoop.activeAgentSession,
    activeSteps: agentLoop.activeSteps,
    streamText: agentLoop.streamText,
  });

  useEffect(() => {
    onAgentPanelLockChange?.({ locked: agentPanelLocked, message: agentPanelLockMessage });
    return () => onAgentPanelLockChange?.({ locked: false, message: '' });
  }, [agentPanelLockMessage, agentPanelLocked, onAgentPanelLockChange]);

  useEffect(() => {
    agentPresentationRef.current = {
      activeSession: agentLoop.activeAgentSession,
      activeSteps: agentLoop.activeSteps,
      streamText: agentLoop.streamText,
    };
  }, [agentLoop.activeAgentSession, agentLoop.activeSteps, agentLoop.streamText]);

  useEffect(() => {
    const reversedSessions = [...restoredAgentSessions].reverse();
    const hasPersistedTimeline = (item) => (
      (Array.isArray(item?.run_events) && item.run_events.length > 0)
      || (Array.isArray(item?.run_logs) && item.run_logs.length > 0)
    );
    const session = reversedSessions.find((item) => (
      ['created', 'running', 'waiting_interaction', 'queued_resume', 'waiting_limit_confirmation', 'waiting_retry', 'waiting_model_recovery'].includes(item.status)
    )) || reversedSessions.find((item) => ['failed', 'cancelled'].includes(item.status) && hasPersistedTimeline(item))
      || reversedSessions.find((item) => item.status === 'completed' && hasPersistedTimeline(item));
    // 历史详情只用于页面首次恢复。新消息启动后，旧 completed session 不能再把
    // 当前 session 的实时工具记录覆盖掉。
    if (session && !agentLoop.loading && !activeAgentSessionId) {
      restoreAgentSession(session);
    } else if (!session && !agentLoop.loading && shouldClearAgentPresentation({
      activeSession: agentPresentationRef.current.activeSession,
      activeSteps: agentPresentationRef.current.activeSteps,
      streamText: agentPresentationRef.current.streamText,
    })) {
      // 新任务处于 loading 时，历史详情仍可能是空数组；此时不能清空展示状态，
      // 否则会把刚回显的用户消息和任务时间线移除，后台 Worker 却仍会继续执行。
      restoreAgentSession(null);
    }
    // 首次返回对话时，为每个运行中或已入队的 session 建立独立 SSE 订阅。
    // 后发 FIFO 任务已经在创建时订阅，不得借此重复请求或覆盖其当前展示。
    if (!activeAgentSessionId) {
      restoredAgentSessions.filter((item) => ['created', 'running', 'queued_resume'].includes(item.status)).forEach((item) => {
        const sessionId = String(item.id || '');
        if (!sessionId || subscribedSessionIdsRef.current.has(sessionId)) return;
        subscribedSessionIdsRef.current.add(sessionId);
        resumeAgentLoop({
          session_id: item.id,
          control_ticket: item.control_tickets?.resume,
          read_ticket: item.control_tickets?.read,
          control_tickets: item.control_tickets,
          llm_config_id: selectedLlmConfigId || undefined,
        }, { resume: true }).catch(() => {
          subscribedSessionIdsRef.current.delete(sessionId);
        });
      });
    }
    const queuedJob = agentResumeJobs.find((job) => job.status === 'queued' && job.resume_ticket);
    const queuedSession = queuedJob
      ? (agentLoop.getAgentSession?.(queuedJob.session_id)
        || restoredAgentSessions.find((item) => Number(item?.id) === Number(queuedJob.session_id))
        || {})
      : null;
    const queuedControlTicket = queuedSession?.control_tickets?.resume;
    if (!queuedJob || !queuedControlTicket || autoResumedJobRef.current.has(queuedJob.id)) return;
    autoResumedJobRef.current.add(queuedJob.id);
    resumeAgentLoop({
      session_id: queuedJob.session_id,
      resume_job_id: queuedJob.id,
      resume_ticket: queuedJob.resume_ticket,
      control_ticket: queuedControlTicket,
      read_ticket: queuedSession.control_tickets?.read,
      control_tickets: queuedSession.control_tickets,
      llm_config_id: selectedLlmConfigId || undefined,
    }, { resume: true }).catch(() => {
      autoResumedJobRef.current.delete(queuedJob.id);
    });
  }, [activeAgentSessionId, agentLoop.loading, agentResumeJobs, restoreAgentSession, restoredAgentSessions, resumeAgentLoop, selectedLlmConfigId]);

  const resumeFailedAgentTask = useCallback(async (targetSessionId = null) => {
    if (resumeAgentTaskInFlightRef.current) return;
    const targetId = String(targetSessionId || '');
    const session = targetId
      ? (agentLoop.getAgentSession?.(targetId) || restoredAgentSessions.find((item) => String(item?.id || '') === targetId) || {})
      : (agentLoop.activeAgentSession || {});
    const resumeTicket = session.control_tickets?.resume || session.control_ticket;
    if (!session.id || (!resumeTicket && !session.token)) {
      toast('当前 Agent 任务的恢复凭据已失效，请刷新会话后再试', 'warning');
      return;
    }
    resumeAgentTaskInFlightRef.current = true;
    try {
      await agentLoop.startAgentLoop({
        session_id: session.id,
        session_token: session.token,
        control_ticket: resumeTicket,
        read_ticket: session.control_tickets?.read,
        control_tickets: session.control_tickets,
        llm_config_id: selectedLlmConfigId || undefined,
      }, { resume: true });
    } catch (error) {
      toast(error.message || '继续 Agent 任务失败', 'error');
    } finally {
      resumeAgentTaskInFlightRef.current = false;
    }
  }, [agentLoop, restoredAgentSessions, selectedLlmConfigId, toast]);

  const handleConversationRewritten = useCallback((payload = {}) => {
    // 服务端会返回本次截断实际取消的 session。只清理这些 session，既阻止晚到 SSE
    // 把旧 prompt 的执行记录写回，也不误删改写点之前仍应保留的工具历史。
    const cancelledSessionIds = new Set((Array.isArray(payload.cancelled_session_ids) ? payload.cancelled_session_ids : [])
      .map((sessionId) => String(sessionId || ''))
      .filter(Boolean));
    agentLoop.discardAgentSessions([...cancelledSessionIds]);
    setLiveSessionTimelines((previous) => Object.fromEntries(Object.entries(previous)
      .filter(([sessionId]) => !cancelledSessionIds.has(String(sessionId)))));
    setRestoredAgentSessions((previous) => previous.filter((session) => !cancelledSessionIds.has(String(session?.id || ''))));
    setPendingInteractions((previous) => previous.filter((interaction) => !cancelledSessionIds.has(String(interaction?.payload?.agent_session_id || ''))));
    setPendingOperationSets((previous) => previous.filter((operationSet) => !cancelledSessionIds.has(String(operationSet?.session_id || operationSet?.agent_session_id || ''))));
    setAgentResumeJobs((previous) => previous.filter((job) => !cancelledSessionIds.has(String(job?.session_id || ''))));
  }, [agentLoop]);

  const updateConfirmMode = useCallback((value) => {
    const next = value === MANUAL_CONFIRM ? MANUAL_CONFIRM : AUTO_CONFIRM;
    setAgentConfirmMode(next);
    try { window.localStorage.setItem(CONFIRM_MODE_STORAGE_KEY, next); } catch {}
  }, []);

  const handleConfigChange = useCallback((nextId) => {
    if (!nextId) return;
    setSelectedLlmConfigId(nextId);
    setActiveConfig(nextId).catch((error) => {
      setSelectedLlmConfigId(activeConfigId || llmConfigs[0]?.id || null);
      toast(error.message || '切换模型失败', 'error');
    });
  }, [activeConfigId, llmConfigs, setActiveConfig, toast]);

  const buildAgentTask = useCallback((query, options = {}) => {
    const mentions = Array.isArray(options.mentions) ? options.mentions : [];
    const skillMentions = mentions.filter((mention) => mention?.type === 'skill').map((mention) => String(mention.id || mention.path || '')).filter(Boolean);
    const mentionSegments = Array.isArray(options.mentionSegments) ? options.mentionSegments : [];
    const agentInput = segmentsToAgentInput(mentionSegments) || query;
    return {
    goal: `用户任务：${agentInput}`,
    user_query: query,
    display_query: query,
    kind: 'canvas',
    conversation_id: activeConversationId || undefined,
    llm_config_id: options.llmConfigId || selectedLlmConfigId || undefined,
    authorized_ops: ['modify', 'create'],
    attachments: options.attachments || [],
    images: options.images || [],
    media_items: options.mediaItems || [],
    mentions,
    mention_segments: mentionSegments,
    skill_mentions: skillMentions,
    web_search_enabled: Boolean(options.webSearchEnabled),
    search_provider: options.searchProvider || undefined,
    mcp_selection: options.mcpSelection || { mode: 'off' },
    route_reason: 'files_agent_input',
    skip_user_message_append: Boolean(options.skipUserMessageAppend),
    rewriteUserMessageId: Number(options.rewriteUserMessageId || 0) || null,
    onTaskAccepted: (accepted) => {
      options.onTaskAccepted?.(accepted);
      refreshConversationList(accepted?.conversationId || null).catch(() => {});
    },
    };
  }, [activeConversationId, refreshConversationList, selectedLlmConfigId]);

  const handleSend = useCallback(async (query, options = {}) => {
    const llmConfigId = options.llmConfigId || selectedLlmConfigId;
    if (!llmConfigId) {
      toast('请先在模型配置中新增至少一个 LLM 配置', 'warning');
      return;
    }
    if (typeof beforeAgentRun === 'function') {
      const ready = await beforeAgentRun();
      if (!ready) return;
    }
    await agentLoop.confirmAgentTask({
      ...buildAgentTask(query, { ...options, llmConfigId }),
      approval_mode: agentConfirmMode,
    });
  }, [agentConfirmMode, agentLoop, beforeAgentRun, buildAgentTask, selectedLlmConfigId, toast]);

  const handleNewConversation = useCallback(() => {
    // 用户明确选择新对话后，初始化中的“恢复上次对话”异步流程不得再写回旧会话。
    restoredConversationRef.current = true;
    conversationLoadSequenceRef.current += 1;
    agentLoop.clearActiveAgentSession();
    setPersistedActiveConversationId(null);
    setMessages([]);
    setPendingOperationSets([]);
    setPendingInteractions([]);
    setAgentResumeJobs([]);
    setRestoredAgentSessions([]);
    setLiveSessionTimelines({});
    subscribedSessionIdsRef.current.clear();
    setHistorySearchQuery('');
    setRestoringConversation(false);
    setHistoryDrawerOpen(false);
  }, [agentLoop, setPersistedActiveConversationId]);

  const handleDeleteConversation = useCallback(async (conversationId) => {
    setDeletingConversationId(Number(conversationId));
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('删除历史对话失败');
      if (Number(activeConversationId) === Number(conversationId)) handleNewConversation();
      await refreshConversationList();
      toast('历史对话已删除', 'success');
    } catch (error) {
      toast(error.message || '删除历史对话失败', 'error');
    } finally {
      setDeletingConversationId(null);
    }
  }, [activeConversationId, handleNewConversation, refreshConversationList, toast]);

  const handleExportConversation = useCallback(async (conversationId, conversation) => {
    setExportingConversationId(Number(conversationId));
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, { cache: 'no-store' });
      const payload = await readApiResponse(response, '读取对话详情失败');
      const isActive = Number(activeConversationId) === Number(conversationId);
      const content = formatConversationExportMarkdown({
        conversation: { ...(conversation || {}), ...payload },
        messages: isActive ? messages : mapConversationMessages(payload.messages, 'canvas'),
        agentSessions: payload.agent_sessions || [],
        pendingOperationSets: isActive ? pendingOperationSets : payload.pending_operation_sets || [],
        source: 'Notus 文件工作区',
      });
      downloadTextFile(buildConversationExportFileName(payload), content);
      toast('对话已导出为 Markdown 文件', 'success');
    } catch (error) {
      toast(error.message || '导出对话失败', 'error');
    } finally {
      setExportingConversationId(null);
    }
  }, [activeConversationId, messages, pendingOperationSets, toast]);

  const respondToInteraction = useCallback(async (interaction, body) => {
    const response = await fetch(`/api/interactions/${interaction.id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        schema_version: interaction.schema_version,
        resume_ticket: interaction.resume_ticket,
      }),
    });
    const payload = await readApiResponse(response, '回答提问卡片失败');
    if (payload.interaction) setPendingInteractions((previous) => upsertById(previous, payload.interaction));
    if (payload.answer_message) {
      const nextMessage = mapConversationMessages([payload.answer_message], 'canvas')[0];
      if (nextMessage) setMessages((previous) => upsertById(previous, nextMessage));
    }
    return payload;
  }, []);

  const resumeInteraction = useCallback(async (interaction, resume = {}) => {
    const session = agentLoop.activeAgentSession || {};
    const sessionId = Number(interaction?.payload?.agent_session_id || session.id || 0);
    const targetSession = agentLoop.getAgentSession?.(sessionId)
      || restoredAgentSessions.find((item) => Number(item?.id) === sessionId)
      || session;
    const resumeJob = resume.resume_job || agentResumeJobs.find((job) => Number(job.interaction_id) === Number(interaction?.id));
    const resumeTicket = resume.resume_ticket || resumeJob?.resume_ticket;
    if (!sessionId || !resumeJob?.id || !resumeTicket) {
      toast('当前 Agent 任务状态已失效，请重新发起任务', 'warning');
      return;
    }
    await agentLoop.startAgentLoop({
      session_id: sessionId,
      resume_job_id: resumeJob.id,
      resume_ticket: resumeTicket,
      control_ticket: targetSession.control_tickets?.resume,
      read_ticket: targetSession.control_tickets?.read,
      control_tickets: targetSession.control_tickets,
      llm_config_id: selectedLlmConfigId || undefined,
    }, { resume: true });
  }, [agentLoop, agentResumeJobs, restoredAgentSessions, selectedLlmConfigId, toast]);

  const handleInteractionSubmit = useCallback(async (interaction, answers) => {
    setInteractionSubmittingId(interaction.id);
    try {
      const payload = await respondToInteraction(interaction, { response: { answers } });
      if (payload.should_continue) {
        setInteractionAnswerDrafts((previous) => {
          const next = { ...previous };
          delete next[String(interaction.id)];
          return next;
        });
      }
      if (payload.should_continue) await resumeInteraction(payload.interaction || interaction, payload);
    } catch (error) {
      toast(error.message || '回答提问卡片失败', 'error');
    } finally {
      setInteractionSubmittingId(null);
    }
  }, [respondToInteraction, resumeInteraction, toast]);

  const handleInteractionAnswerDraftChange = useCallback((interactionId, answers) => {
    if (!interactionId) return;
    setInteractionAnswerDrafts((previous) => ({ ...previous, [String(interactionId)]: answers }));
  }, []);

  const handleMcpApproval = useCallback(async (interaction, decision) => {
    setInteractionSubmittingId(interaction.id);
    try {
      const payload = await respondToInteraction(interaction, { action: decision });
      if (payload.should_continue) await resumeInteraction(payload.interaction || interaction, payload);
    } catch (error) {
      toast(error.message || 'MCP 授权失败', 'error');
    } finally {
      setInteractionSubmittingId(null);
    }
  }, [respondToInteraction, resumeInteraction, toast]);

  const handleResourceApproval = useCallback(async (interaction, decision) => {
    setInteractionSubmittingId(interaction.id);
    try {
      const payload = await respondToInteraction(interaction, { action: decision });
      if (payload.resolution_status === 'resolved') dispatchAgentResourceChange(interaction?.payload?.action);
      if (payload.should_continue) await resumeInteraction(payload.interaction || interaction, payload);
    } catch (error) { toast(error.message || '资源操作失败', 'error'); } finally { setInteractionSubmittingId(null); }
  }, [respondToInteraction, resumeInteraction, toast]);

  const displayedMessages = useMemo(() => messages.map((message) => {
    const operationSetId = String(message?.meta?.operation_set_id || message?.operationSet?.id || '');
    const sessionId = String(message?.meta?.session_id || '');
    const operationSet = operationSetById[operationSetId] || operationSetBySessionId[sessionId] || message?.operationSet || null;
    return operationSet ? { ...message, operationSet } : message;
  }), [messages, operationSetById, operationSetBySessionId]);
  // 后台运行、暂停、失败和提问卡都不再锁住输入；新消息会以同会话 FIFO 入队。
  // 仅模型尚未就绪或输入组件自身正在上传时禁用。
  const inputDisabled = !aiUiState.ready;

  return (
    <div className="notus-file-agent-workspace" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--bg-primary)' }}>
      <div className="notus-file-agent-workspace__header" style={{ height: 48, padding: '0 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <Tooltip content="查看历史对话"><span><IconButton label="查看历史对话" size={30} active={historyDrawerOpen} onClick={() => setHistoryDrawerOpen(true)}><Icons.clock size={14} /></IconButton></span></Tooltip>
          <Tooltip content="新建对话"><span><IconButton label="新建对话" size={30} onClick={handleNewConversation}><Icons.plus size={14} /></IconButton></span></Tooltip>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <AgentWorkspace
          messages={displayedMessages}
          interactions={pendingInteractions}
          streamText={agentLoop.streamText}
          loading={agentLoop.loading}
          error={agentLoop.error}
          activeSteps={agentLoop.activeSteps}
          activeSessionId={agentLoop.activeAgentSession?.id || null}
          activeSessionStatus={agentLoop.activeAgentSession?.status || ''}
          sessionTimelines={sessionTimelines}
          llmConfigs={llmConfigs}
          selectedConfigId={selectedLlmConfigId}
          onConfigChange={handleConfigChange}
          onSend={handleSend}
          onStop={agentLoop.stopAgentLoop}
          onResumeAgentTask={resumeFailedAgentTask}
          onConversationRewritten={handleConversationRewritten}
          onApplyOperationSet={(operationSet) => agentLoop.applyOperationSet(operationSet)}
          onApplyOperationFile={(operationSet, patchIndex) => agentLoop.applyOperationFile(operationSet, patchIndex)}
          onRollbackOperationFile={(operationSet, patchIndex) => agentLoop.rollbackOperationFile(operationSet, patchIndex)}
          onDiscardOperationFile={(operationSet) => agentLoop.discardPendingOperationSet(operationSet)}
          disabled={inputDisabled}
          placeholder="输入任务，或使用 @ 查找并引用文件…"
          agentConfirmMode={agentConfirmMode}
          onAgentConfirmModeChange={updateConfirmMode}
          attachmentMode="parsed"
          mentionOptions={mentionOptions}
          fullWidth={fullWidth}
          onOpenDiffFile={onOpenDiffFile}
          restoringConversation={restoringConversation}
        />
        {aiUiState.showLockedState ? <AiLockedState compact variant="panel" onAction={() => openSettings('model')} /> : null}
      </div>
      {activeInteraction ? (
        <div className="notus-agent-interaction-timeline" style={{ position: 'relative', zIndex: 2, padding: '0 12px 12px' }}>
          {activeInteraction.kind === 'mcp_approval' ? <McpApprovalDrawer interaction={activeInteraction} submitting={interactionSubmittingId === activeInteraction.id} onDecision={(decision) => handleMcpApproval(activeInteraction, decision)} /> : activeInteraction.kind === 'resource_approval' ? <ResourceApprovalDrawer interaction={activeInteraction} submitting={interactionSubmittingId === activeInteraction.id} onPhaseChange={setClarifyPhase} onDecision={(decision) => handleResourceApproval(activeInteraction, decision)} /> : <ClarifyDrawer interaction={activeInteraction} answerDraft={interactionAnswerDrafts[String(activeInteraction.id)]} onAnswerDraftChange={(answers) => handleInteractionAnswerDraftChange(activeInteraction.id, answers)} submitting={interactionSubmittingId === activeInteraction.id} submitLabel="继续执行" onPhaseChange={setClarifyPhase} onSubmit={handleInteractionSubmit} onRetry={resumeInteraction} onCancel={(interaction) => respondToInteraction(interaction, { action: 'cancel' }).catch(() => {})} />}
        </div>
      ) : null}
      <ConversationDrawer
        open={historyDrawerOpen}
        onClose={() => { setHistoryDrawerOpen(false); setHistorySearchQuery(''); }}
        conversations={conversationList}
        activeConversationId={activeConversationId}
        loading={conversationListLoading}
        searchQuery={historySearchQuery}
        onSearchQueryChange={setHistorySearchQuery}
        emptyText={historySearchQuery.trim() ? '没有匹配的历史对话' : '暂无历史对话'}
        onSelect={(id) => loadConversation(id).catch((error) => toast(error.message || '读取对话失败', 'error'))}
        onDelete={handleDeleteConversation}
        onExport={handleExportConversation}
        onViewAgentLogs={(conversationId) => openSettings('logs', { conversationId })}
        deletingConversationId={deletingConversationId}
        exportingConversationId={exportingConversationId}
      />
    </div>
  );
}
