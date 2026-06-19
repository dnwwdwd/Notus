import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { AgentWorkspace } from '../components/AgentWorkspace/AgentWorkspace';
import { AiLockedState } from '../components/ui/AiLockedState';
import { useApp } from '../contexts/AppContext';
import { useAppStatus } from '../contexts/AppStatusContext';
import { useLlmConfigs } from '../hooks/useLlmConfigs';
import { useStableAiReadiness } from '../hooks/useStableAiReadiness';
import { deriveAiReadiness } from '../utils/aiReadiness';
import { navigateWithFallback } from '../utils/navigation';
import { readSse } from '../utils/readSse';

const SUGGESTIONS = [
  '我最近写了什么？',
  '关于缓存的三种策略有哪些差别？',
  '整理一下我对“慢”的思考',
  '读书笔记里提到过哪些决策模型？',
];

function upsertMessage(list, message) {
  if (!message?.id) return list;
  const next = [...list];
  const index = next.findIndex((item) => String(item.id) === String(message.id));
  if (index >= 0) next[index] = message;
  else next.push(message);
  return next;
}

function buildKnowledgeSteps(stage, done = false) {
  if (done) {
    return [
      {
        id: 'search_knowledge',
        label: '检索知识库',
        status: 'done',
        detail: '已完成知识库召回、证据聚合和回答模式判断。',
        tool: 'search_knowledge',
        result: stage?.sources ? '找到 ' + stage.sources + ' 条可用来源' : '已完成',
      },
      { id: 'answer', label: '生成回答', status: 'done', detail: '已输出回答内容。' },
    ];
  }
  if (!stage) {
    return [{ id: 'answer', label: '生成回答', status: 'running', detail: '正在根据检索结果组织回答。' }];
  }
  const sourceText = stage.sources ? '当前找到 ' + stage.sources + ' 条候选来源。' : '正在召回相关笔记。';
  return [
    {
      id: 'search_knowledge',
      label: stage.stage === 'insufficient' ? '检查证据充分性' : '检索知识库',
      status: 'running',
      detail: sourceText,
      tool: 'search_knowledge',
      input: 'scope: 本地知识库',
    },
  ];
}

function buildAnswerStage(event) {
  const sectionCount = Array.isArray(event.sections) ? event.sections.length : 0;
  const matchedFileCount = Array.isArray(event.matched_files) ? event.matched_files.length : 0;
  const chunkCount = Array.isArray(event.chunks) ? event.chunks.length : 0;
  const citationCount = Number(event.citation_count || 0);
  const sources = citationCount || sectionCount || matchedFileCount || chunkCount;
  return {
    stage: event.sufficiency === false || event.answer_mode === 'no_evidence' ? 'insufficient' : 'found',
    sources,
  };
}

export default function KnowledgePage() {
  const router = useRouter();
  const { activeFile } = useApp();
  const { status: appStatus, loading: appStatusLoading } = useAppStatus();
  const { configs: llmConfigs, activeConfigId, loading: llmConfigsLoading, setActiveConfig } = useLlmConfigs();
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [streamText, setStreamText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeSteps, setActiveSteps] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const requestControllerRef = useRef(null);

  useEffect(() => {
    if (llmConfigs.length === 0) {
      setSelectedLlmConfigId(null);
      return;
    }
    setSelectedLlmConfigId((prev) => {
      if (prev && llmConfigs.some((item) => String(item.id) === String(prev))) return prev;
      if (activeConfigId && llmConfigs.some((item) => String(item.id) === String(activeConfigId))) return activeConfigId;
      return llmConfigs[0]?.id || null;
    });
  }, [activeConfigId, llmConfigs]);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
  }, []);

  const handleLlmConfigChange = useCallback(async (nextConfigId) => {
    setSelectedLlmConfigId(nextConfigId);
    try {
      await setActiveConfig(nextConfigId);
    } catch {
      // 页面下拉仍然可用；保存失败时后端请求会继续按传入配置执行。
    }
  }, [setActiveConfig]);

  const handleSend = useCallback(async (query, options = {}) => {
    const llmConfigId = options.llmConfigId || selectedLlmConfigId;
    if (!llmConfigId) {
      setError('请先在模型配置中新增至少一个 LLM 配置');
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setError('');
    setStreamText('');
    setActiveSteps(buildKnowledgeSteps({ sources: 0 }));
    setMessages((prev) => [...prev, {
      id: 'u-' + Date.now(),
      role: 'user',
      content: query,
      attachments: options.attachments || [],
      meta: {
        web_search_enabled: Boolean(options.webSearchEnabled),
        search_provider: options.searchProvider || null,
      },
    }]);

    try {
      let answer = '';
      let citations = [];
      let documents = [];
      let documentStats = null;
      let sourceCount = 0;
      let assistantMeta = null;
      let finalStage = null;
      let resolvedConversationId = activeConversationId;

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          conversation_id: activeConversationId || undefined,
          query,
          llm_config_id: llmConfigId,
          modelConfigId: llmConfigId,
          active_file_id: activeFile?.id || null,
          reference_mode: 'auto',
          webSearchEnabled: Boolean(options.webSearchEnabled),
          searchProvider: options.searchProvider || null,
          attachments: options.attachments || [],
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'AI 请求失败');
      }

      await readSse(response, (event) => {
        if (event.conversation_id) resolvedConversationId = Number(event.conversation_id);
        if (event.type === 'chunks') {
          documents = Array.isArray(event.documents) ? event.documents : [];
          documentStats = event.document_stats || null;
          finalStage = buildAnswerStage(event);
          setActiveSteps(buildKnowledgeSteps(finalStage));
        } else if (event.type === 'assistant_meta') {
          assistantMeta = event;
          documentStats = event.document_stats || documentStats;
          if (event.answer_mode === 'clarify_needed') setActiveSteps([{ id: 'clarify', label: '确认问题范围', status: 'done', detail: '需要补充问题范围后再继续检索。' }]);
        } else if (event.type === 'token') {
          answer += event.text || '';
          setStreamText(answer);
          setActiveSteps(buildKnowledgeSteps(finalStage || null));
        } else if (event.type === 'citations') {
          citations = event.citations || [];
          sourceCount = Number(event.source_count || event.citations?.length || 0);
        } else if (event.type === 'done') {
          const finalMeta = event.meta || assistantMeta;
          const finalMessage = {
            id: event.message_id || 'a-' + Date.now(),
            role: 'assistant',
            content: answer || event.answer || '',
            citations,
            documents,
            documentStats,
            sourceCount: Number(event.source_count || finalMeta?.source_count || sourceCount || citations.length || 0),
            meta: finalMeta,
            toolSteps: buildKnowledgeSteps(finalStage, true),
          };
          setMessages((prev) => upsertMessage(prev, finalMessage));
          if (resolvedConversationId) setActiveConversationId(resolvedConversationId);
          setStreamText('');
          setActiveSteps([]);
          setLoading(false);
        } else if (event.type === 'error') {
          throw new Error(event.error || 'AI 请求失败');
        }
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'AI 请求失败');
        setActiveSteps([{ id: 'error', label: '请求失败', status: 'error', detail: err.message || 'AI 请求失败' }]);
      } else {
        setActiveSteps([{ id: 'stopped', label: '已中止执行', status: 'stopped', detail: '用户停止了当前生成。' }]);
      }
      setStreamText('');
      setLoading(false);
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }, [activeConversationId, activeFile?.id, selectedLlmConfigId]);

  const aiReadiness = deriveAiReadiness({
    appStatus,
    llmConfigs,
    llmConfigsLoading,
    appStatusLoading,
  });
  const aiUiState = useStableAiReadiness(aiReadiness);

  return (
    <Shell active="knowledge" tocDisabled navigateOnFileSelect={false}>
      <AgentWorkspace
        pageTitle="Notus Agent Workspace"
        modeLabel="知识库问答"
        messages={messages}
        streamText={streamText}
        loading={loading}
        error={error}
        activeSteps={activeSteps}
        suggestions={SUGGESTIONS}
        llmConfigs={llmConfigs}
        selectedConfigId={selectedLlmConfigId}
        onConfigChange={handleLlmConfigChange}
        onSend={handleSend}
        onStop={() => requestControllerRef.current?.abort()}
        disabled={aiUiState.showLockedState}
        placeholder="从你的知识库中查找答案…"
      />
      {aiUiState.showLockedState ? (
        <AiLockedState
          variant="modal"
          title="知识库功能尚未解锁"
          description={aiUiState.description || '请先完成模型配置。'}
          onAction={() => navigateWithFallback(router, '/settings/model')}
        />
      ) : null}
    </Shell>
  );
}
