import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
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
import { navigateWithFallback } from '../../utils/navigation';

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
  const name = String(file?.title || file?.name || path || '未命名文件').trim();
  return {
    value: String(file?.id || path),
    token: `@{${path}}`,
    label: name.replace(/\.md$/i, ''),
    preview: path,
    kind: 'file',
    searchText: `${name} ${file?.name || ''} ${path}`,
  };
}

function collectFolderMentions(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).flatMap((node) => {
    if (node?.type !== 'folder') return [];
    const path = String(node.path || '').trim();
    const name = String(node.name || node.title || path || '未命名目录').trim();
    const current = path ? [{
      value: `folder:${path}`,
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

export function FileAgentWorkspace({ allFiles = [], fileTree = [], refreshFiles, onFilesChanged, beforeAgentRun }) {
  const router = useRouter();
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
  ]), [allFiles, fileTree]);
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

  const refreshConversationList = useCallback(async (preferredId = null) => {
    const rows = await fetchConversationList();
    setConversationList(rows);
    if (preferredId && rows.some((item) => Number(item.id) === Number(preferredId))) {
      setActiveConversationId(Number(preferredId));
    }
    return rows;
  }, [fetchConversationList]);

  const loadConversation = useCallback(async (conversationId) => {
    const response = await fetch(`/api/conversations/${conversationId}`, { cache: 'no-store' });
    const payload = await readApiResponse(response, '读取对话详情失败');
    setMessages(mapConversationMessages(payload.messages, 'canvas'));
    setPendingOperationSets(Array.isArray(payload.pending_operation_sets) ? payload.pending_operation_sets : []);
    setPendingInteractions(Array.isArray(payload.pending_interactions) ? payload.pending_interactions : []);
    setActiveConversationId(Number(conversationId));
    setHistoryDrawerOpen(false);
    return payload;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setConversationListLoading(true);
    fetchConversationList()
      .then((rows) => {
        if (!cancelled) setConversationList(rows);
      })
      .catch(() => {
        if (!cancelled) setConversationList([]);
      })
      .finally(() => {
        if (!cancelled) setConversationListLoading(false);
      });
    return () => { cancelled = true; };
  }, [fetchConversationList]);

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
      if (conversationId) setActiveConversationId(Number(conversationId));
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

  const buildAgentTask = useCallback((query, options = {}) => ({
    goal: `用户任务：${query}`,
    user_query: query,
    display_query: query,
    kind: 'canvas',
    conversation_id: activeConversationId || undefined,
    llm_config_id: options.llmConfigId || selectedLlmConfigId || undefined,
    authorized_paths: [''],
    authorized_ops: ['modify', 'create'],
    search_knowledge_limit: 5,
    attachments: options.attachments || [],
    web_search_enabled: Boolean(options.webSearchEnabled),
    search_provider: options.searchProvider || undefined,
    route_reason: 'files_agent_input',
    skip_user_message_append: Boolean(options.skipUserMessageAppend),
  }), [activeConversationId, selectedLlmConfigId]);

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
    setActiveConversationId(null);
    setMessages([]);
    setPendingOperationSets([]);
    setPendingInteractions([]);
    setHistoryDrawerOpen(false);
    agentLoop.clearActiveAgentSession();
  }, [agentLoop, toast]);

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

  const displayedMessages = useMemo(() => messages.map((message) => {
    const operationSetId = String(message?.meta?.operation_set_id || message?.operationSet?.id || '');
    return operationSetId && operationSetById[operationSetId]
      ? { ...message, operationSet: operationSetById[operationSetId] }
      : message;
  }), [messages, operationSetById]);
  const inputDisabled = !aiUiState.ready || agentLoop.loading || sessionLocked || Boolean(activeInteraction && clarifyPhase !== 'collapsed');

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', background: 'var(--bg-primary)' }}>
      <div style={{ height: 48, padding: '0 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
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
        {aiUiState.showLockedState ? <AiLockedState compact variant="panel" onAction={() => navigateWithFallback(router, '/settings/model')} /> : null}
      </div>
      {activeInteraction ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 8, padding: '44px 12px 0', background: 'linear-gradient(180deg, transparent, var(--bg-primary) 28%)' }}>
          <ClarifyDrawer
            interaction={activeInteraction}
            submitting={interactionSubmittingId === activeInteraction.id}
            submitLabel="继续执行"
            onPhaseChange={setClarifyPhase}
            onSubmit={handleInteractionSubmit}
            onRetry={resumeInteraction}
            onCancel={(interaction) => respondToInteraction(interaction, { action: 'cancel' }).catch(() => {})}
          />
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
        onViewAgentLogs={(id) => navigateWithFallback(router, `/settings/logs?conversation_id=${encodeURIComponent(id)}`)}
        deletingConversationId={deletingConversationId}
        exportingConversationId={exportingConversationId}
      />
    </div>
  );
}
