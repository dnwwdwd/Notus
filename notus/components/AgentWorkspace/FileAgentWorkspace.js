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
import { useAgentLoopController } from '../../hooks/useAgentLoopController';
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

function mapFileMention(file) {
  const path = String(file?.path || '').trim();
  const name = String(file?.name || path.split('/').pop() || file?.title || '未命名文件').trim();
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
    searchText: `${name} ${file?.name || ''} ${path}`,
  };
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

export function FileAgentWorkspace({ allFiles = [], fileTree = [], refreshFiles, onFilesChanged, beforeAgentRun }) {
  const { openSettings } = useSettingsDialog();
  const toast = useToast();
  const { status: appStatus, loading: appStatusLoading } = useAppStatus();
  const { configs: llmConfigs, activeConfigId, loading: llmConfigsLoading, setActiveConfig } = useLlmConfigs();
  const [messages, setMessages] = useState([]);
  const [conversationList, setConversationList] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [conversationListLoading, setConversationListLoading] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState(null);
  const [exportingConversationId, setExportingConversationId] = useState(null);
  const [pendingOperationSets, setPendingOperationSets] = useState([]);
  const [pendingInteractions, setPendingInteractions] = useState([]);
  const [interactionSubmittingId, setInteractionSubmittingId] = useState(null);
  const [clarifyPhase, setClarifyPhase] = useState('expanded-question');
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState(null);
  const [agentConfirmMode, setAgentConfirmMode] = useState(() => readConfirmMode());
  const [skills, setSkills] = useState([]);
  const restoredConversationRef = useRef(false);

  const aiState = deriveAiReadiness({
    appStatus,
    appStatusLoading,
    llmConfigs,
    llmConfigsLoading,
  });
  const aiUiState = useStableAiReadiness(aiState);
  const mentionOptions = useMemo(() => dedupeMentionOptions([
    ...allFiles.map(mapFileMention).filter((item) => item.preview),
    ...collectFolderMentions(fileTree),
    ...collectFolderMentionsFromFiles(allFiles),
    ...skills.map(mapSkillMention).filter(Boolean),
  ]), [allFiles, fileTree, skills]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/skills', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : { skills: [] })
      .then((payload) => {
        if (!cancelled) setSkills((Array.isArray(payload?.skills) ? payload.skills : []).filter((skill) => skill?.enabled && skill?.status === 'valid'));
      })
      .catch(() => { if (!cancelled) setSkills([]); });
    return () => { cancelled = true; };
  }, []);
  const operationSetById = useMemo(() => Object.fromEntries(
    pendingOperationSets.map((item) => [String(item.id || item.operation_set_id), item])
  ), [pendingOperationSets]);
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

  const fetchConversationList = useCallback(async () => {
    const response = await fetch('/api/conversations?kind=canvas&limit=80', { cache: 'no-store' });
    const payload = await readApiResponse(response, '读取对话列表失败');
    return Array.isArray(payload) ? payload : [];
  }, []);

  const setPersistedActiveConversationId = useCallback((conversationId) => {
    const nextId = normalizeConversationId(conversationId);
    setActiveConversationId(nextId);
    saveActiveConversationId(nextId);
  }, []);

  const refreshConversationList = useCallback(async (preferredId = null) => {
    const rows = await fetchConversationList();
    setConversationList(rows);
    if (preferredId && rows.some((item) => Number(item.id) === Number(preferredId))) {
      setPersistedActiveConversationId(preferredId);
    }
    return rows;
  }, [fetchConversationList, setPersistedActiveConversationId]);

  const loadConversation = useCallback(async (conversationId) => {
    const response = await fetch(`/api/conversations/${conversationId}`, { cache: 'no-store' });
    const payload = await readApiResponse(response, '读取对话详情失败');
    setMessages(mapConversationMessages(payload.messages, 'canvas'));
    setPendingOperationSets(Array.isArray(payload.pending_operation_sets) ? payload.pending_operation_sets : []);
    setPendingInteractions(Array.isArray(payload.pending_interactions) ? payload.pending_interactions : []);
    setPersistedActiveConversationId(conversationId);
    setHistoryDrawerOpen(false);
    return payload;
  }, [setPersistedActiveConversationId]);

  useEffect(() => {
    let cancelled = false;
    setConversationListLoading(true);
    fetchConversationList()
      .then(async (rows) => {
        if (cancelled) return;
        setConversationList(rows);
        if (restoredConversationRef.current) return;
        restoredConversationRef.current = true;
        const savedId = readActiveConversationId();
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
        if (!cancelled) setConversationListLoading(false);
      });
    return () => { cancelled = true; };
  }, [fetchConversationList, loadConversation]);

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

  const agentLoop = useAgentLoopController({
    onAppendUserMessage: (message) => setMessages((previous) => [...previous, message]),
    onAppendAssistantMessage: (message) => setMessages((previous) => upsertById(previous, message)),
    onInteractionRequest: (interaction) => setPendingInteractions((previous) => upsertById(previous, interaction)),
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
  });
  const sessionLocked = ['running', 'waiting_confirm'].includes(agentLoop.activeAgentSession?.status);

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
    authorized_paths: [''],
    authorized_ops: ['modify', 'create'],
    search_knowledge_limit: 5,
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
    onTaskAccepted: options.onTaskAccepted,
    };
  }, [activeConversationId, selectedLlmConfigId]);

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
    if (agentLoop.loading) {
      toast('当前 Agent 任务仍在执行，请先停止或等待完成', 'info');
      return;
    }
    setPersistedActiveConversationId(null);
    setMessages([]);
    setPendingOperationSets([]);
    setPendingInteractions([]);
    setHistoryDrawerOpen(false);
    agentLoop.clearActiveAgentSession();
  }, [agentLoop, setPersistedActiveConversationId, toast]);

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
      body: JSON.stringify({ ...body, schema_version: interaction.schema_version }),
    });
    const payload = await readApiResponse(response, '回答提问卡片失败');
    if (payload.interaction) setPendingInteractions((previous) => upsertById(previous, payload.interaction));
    if (payload.answer_message) {
      const nextMessage = mapConversationMessages([payload.answer_message], 'canvas')[0];
      if (nextMessage) setMessages((previous) => upsertById(previous, nextMessage));
    }
    return payload;
  }, []);

  const resumeInteraction = useCallback(async (interaction) => {
    const session = agentLoop.activeAgentSession || {};
    const sessionId = Number(interaction?.payload?.agent_session_id || session.id || 0);
    if (!sessionId || !session.token) {
      toast('当前 Agent 任务状态已失效，请重新发起任务', 'warning');
      return;
    }
    await agentLoop.startAgentLoop({
      session_id: sessionId,
      session_token: session.token,
      interaction_id: interaction.id,
      llm_config_id: selectedLlmConfigId || undefined,
    }, { resume: true });
  }, [agentLoop, selectedLlmConfigId, toast]);

  const handleInteractionSubmit = useCallback(async (interaction, answers) => {
    setInteractionSubmittingId(interaction.id);
    try {
      const payload = await respondToInteraction(interaction, { response: { answers } });
      if (payload.should_continue) await resumeInteraction(payload.interaction || interaction);
    } catch (error) {
      toast(error.message || '回答提问卡片失败', 'error');
    } finally {
      setInteractionSubmittingId(null);
    }
  }, [respondToInteraction, resumeInteraction, toast]);

  const handleMcpApproval = useCallback(async (interaction, decision) => {
    setInteractionSubmittingId(interaction.id);
    try {
      const payload = await respondToInteraction(interaction, { action: decision });
      if (payload.should_continue) await resumeInteraction(payload.interaction || interaction);
    } catch (error) {
      toast(error.message || 'MCP 授权失败', 'error');
    } finally {
      setInteractionSubmittingId(null);
    }
  }, [respondToInteraction, resumeInteraction, toast]);

  const displayedMessages = useMemo(() => messages.map((message) => {
    const operationSetId = String(message?.meta?.operation_set_id || message?.operationSet?.id || '');
    return operationSetId && operationSetById[operationSetId]
      ? { ...message, operationSet: operationSetById[operationSetId] }
      : message;
  }), [messages, operationSetById]);
  const inputDisabled = !aiUiState.ready || agentLoop.loading || sessionLocked || Boolean(activeInteraction && clarifyPhase !== 'collapsed');

  return (
    <div className="notus-file-agent-workspace" style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--bg-primary)' }}>
      <div className="notus-file-agent-workspace__header" style={{ height: 48, padding: '0 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <Tooltip content="查看历史对话"><span><IconButton label="查看历史对话" size={30} active={historyDrawerOpen} onClick={() => setHistoryDrawerOpen(true)}><Icons.clock size={14} /></IconButton></span></Tooltip>
          <Tooltip content="新建对话"><span><IconButton label="新建对话" size={30} disabled={agentLoop.loading || sessionLocked} onClick={handleNewConversation}><Icons.plus size={14} /></IconButton></span></Tooltip>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <AgentWorkspace
          messages={displayedMessages}
          streamText={agentLoop.streamText}
          loading={agentLoop.loading}
          error={agentLoop.error}
          activeSteps={agentLoop.activeSteps}
          llmConfigs={llmConfigs}
          selectedConfigId={selectedLlmConfigId}
          onConfigChange={handleConfigChange}
          onSend={handleSend}
          onStop={agentLoop.stopAgentLoop}
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
        />
        {aiUiState.showLockedState ? <AiLockedState compact variant="panel" onAction={() => openSettings('model')} /> : null}
      </div>
      {activeInteraction ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 8, padding: '44px 12px 0', background: 'linear-gradient(180deg, transparent, var(--bg-primary) 28%)' }}>
          {activeInteraction.kind === 'mcp_approval' ? <McpApprovalDrawer interaction={activeInteraction} submitting={interactionSubmittingId === activeInteraction.id} onDecision={(decision) => handleMcpApproval(activeInteraction, decision)} /> : <ClarifyDrawer interaction={activeInteraction} submitting={interactionSubmittingId === activeInteraction.id} submitLabel="继续执行" onPhaseChange={setClarifyPhase} onSubmit={handleInteractionSubmit} onRetry={resumeInteraction} onCancel={(interaction) => respondToInteraction(interaction, { action: 'cancel' }).catch(() => {})} />}
        </div>
      ) : null}
      <ConversationDrawer
        open={historyDrawerOpen}
        onClose={() => setHistoryDrawerOpen(false)}
        conversations={conversationList}
        activeConversationId={activeConversationId}
        loading={conversationListLoading}
        onSelect={(id) => loadConversation(id).catch((error) => toast(error.message || '读取对话失败', 'error'))}
        onDelete={handleDeleteConversation}
        onExport={handleExportConversation}
        onViewAgentLogs={() => openSettings('logs')}
        deletingConversationId={deletingConversationId}
        exportingConversationId={exportingConversationId}
      />
    </div>
  );
}
