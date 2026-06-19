import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Shell } from '../components/Layout/Shell';
import { AgentWorkspace } from '../components/AgentWorkspace/AgentWorkspace';
import { AiLockedState } from '../components/ui/AiLockedState';
import { useToast } from '../components/ui/Toast';
import { useApp } from '../contexts/AppContext';
import { useAppStatus } from '../contexts/AppStatusContext';
import { useLlmConfigs } from '../hooks/useLlmConfigs';
import { useStableAiReadiness } from '../hooks/useStableAiReadiness';
import { deriveAiReadiness } from '../utils/aiReadiness';
import { navigateWithFallback } from '../utils/navigation';
import { readSse } from '../utils/readSse';

const SUGGESTIONS = [
  '把这篇文章改得更简洁',
  '为当前草稿补一个开头',
  '整理成一篇结构清晰的文章',
  '检查逻辑并给出修改建议',
];

function blocksFromMarkdown(markdown) {
  const source = String(markdown || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [{ id: 'b_1', type: 'paragraph', content: '（空白草稿）' }];
  return source.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).map((content, index) => ({
    id: 'b_' + (index + 1),
    type: /^#{1,6}\s/m.test(content) ? 'heading' : 'paragraph',
    content,
  }));
}

function markdownFromBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((block) => String(block.content || '').trim()).filter(Boolean).join('\n\n');
}

function titleFromFile(file) {
  return file?.title || file?.name || file?.path || '未命名创作';
}

function upsertMessage(list, message) {
  if (!message?.id) return list;
  const next = [...list];
  const index = next.findIndex((item) => String(item.id) === String(message.id));
  if (index >= 0) next[index] = message;
  else next.push(message);
  return next;
}

function buildSteps(type, text, operationSet) {
  if (type === 'done') {
    return [
      { id: 'understand', label: '理解创作意图', status: 'done', detail: '已完成意图判断和上下文整理。' },
      {
        id: 'preview_patch_files',
        label: operationSet ? '生成修改预览' : '生成回答',
        status: 'done',
        detail: operationSet ? '已生成文件修改预览，等待确认。' : '已完成回答。',
        tool: operationSet ? 'preview_patch_files' : null,
        result: operationSet ? '生成 ' + (Array.isArray(operationSet.operations) ? operationSet.operations.length : 0) + ' 项修改' : '',
      },
    ];
  }
  if (type === 'batch') {
    return [
      { id: 'understand', label: '理解创作意图', status: 'done', detail: '已完成意图判断。' },
      { id: 'preview_patch_files', label: '生成修改预览', status: 'running', detail: text || '正在生成修改预览。', tool: 'preview_patch_files' },
    ];
  }
  return [{ id: 'understand', label: '理解创作意图', status: 'running', detail: text || '正在分析当前文档和你的指令。' }];
}

export default function CanvasPage() {
  const router = useRouter();
  const toast = useToast();
  const { activeFile, createFile, refreshFiles, getCachedContent, setCachedContent } = useApp();
  const { status: appStatus, loading: appStatusLoading } = useAppStatus();
  const { configs: llmConfigs, activeConfigId, loading: llmConfigsLoading, setActiveConfig } = useLlmConfigs();
  const [selectedLlmConfigId, setSelectedLlmConfigId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [streamText, setStreamText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeSteps, setActiveSteps] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [article, setArticle] = useState(null);
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

  useEffect(() => {
    let cancelled = false;
    async function loadActiveFile() {
      if (!activeFile?.id) {
        setArticle(null);
        return;
      }
      try {
        let content = getCachedContent(activeFile.id);
        if (content === undefined) {
          const response = await fetch('/api/files/' + activeFile.id);
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || '读取当前文档失败');
          content = payload.content || '';
          setCachedContent(activeFile.id, content);
        }
        if (!cancelled) {
          setArticle({
            title: titleFromFile(activeFile),
            file_id: activeFile.id,
            fileId: activeFile.id,
            blocks: blocksFromMarkdown(content),
          });
        }
      } catch {
        if (!cancelled) setArticle(null);
      }
    }
    loadActiveFile();
    return () => {
      cancelled = true;
    };
  }, [activeFile, getCachedContent, setCachedContent]);

  const handleLlmConfigChange = useCallback(async (nextConfigId) => {
    setSelectedLlmConfigId(nextConfigId);
    try {
      await setActiveConfig(nextConfigId);
    } catch {}
  }, [setActiveConfig]);

  const ensureArticle = useCallback(async (seed = '') => {
    if (article?.file_id) return article;
    const name = 'AI 创作草稿-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '.md';
    const created = await createFile({ name, content: seed ? '# AI 创作草稿\n\n' + seed : '# AI 创作草稿\n' });
    const file = created.selectedFile || created;
    const nextArticle = {
      title: titleFromFile(file),
      file_id: file.id,
      fileId: file.id,
      blocks: blocksFromMarkdown(seed || '# AI 创作草稿'),
    };
    setArticle(nextArticle);
    return nextArticle;
  }, [article, createFile]);

  const handleSend = useCallback(async (userInput, options = {}) => {
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
    setActiveSteps(buildSteps('thinking', '正在准备创作上下文。'));
    setMessages((prev) => [...prev, {
      id: 'u-' + Date.now(),
      role: 'user',
      content: userInput,
      attachments: options.attachments || [],
    }]);

    try {
      const currentArticle = await ensureArticle(userInput);
      let assistantText = '';
      let assistantMeta = null;
      let operationSet = null;
      let resolvedConversationId = activeConversationId;
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          conversation_id: activeConversationId || undefined,
          user_input: userInput,
          article: currentArticle,
          llm_config_id: llmConfigId,
          modelConfigId: llmConfigId,
          active_file_id: currentArticle.file_id,
          reference_mode: 'auto',
          style_mode: 'auto',
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
        if (event.type === 'thinking') {
          assistantText = event.text || '正在处理…';
          setStreamText(assistantText);
          setActiveSteps(buildSteps('thinking', assistantText));
        } else if (event.type === 'token') {
          assistantText += event.text || '';
          setStreamText(assistantText);
        } else if (event.type === 'batch_start' || event.type === 'batch_progress' || event.type === 'batch_done') {
          const text = event.text || '正在生成修改预览…';
          setStreamText(text);
          setActiveSteps(buildSteps('batch', text));
        } else if (event.type === 'assistant_meta') {
          assistantMeta = event.assistant_meta || null;
          if (event.operation_set) operationSet = event.operation_set;
        } else if (event.type === 'done') {
          assistantMeta = event.assistant_meta || assistantMeta;
          if (event.operation_set) operationSet = event.operation_set;
          setMessages((prev) => upsertMessage(prev, {
            id: event.message_id || 'a-' + Date.now(),
            role: 'assistant',
            content: event.assistant_message || assistantText || '处理完成。',
            citations: event.citations || [],
            meta: assistantMeta,
            operationSet,
            toolSteps: buildSteps('done', '', operationSet),
          }));
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
  }, [activeConversationId, ensureArticle, selectedLlmConfigId]);

  const handleApplyOperationSet = useCallback(async (operationSet) => {
    if (!operationSet?.id || !article?.file_id) return;
    try {
      const response = await fetch('/api/agent/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article, operation_set_id: operationSet.id, operations: operationSet.operations || [] }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || '应用修改失败');
      const nextArticle = payload.article || article;
      const nextMarkdown = markdownFromBlocks(nextArticle.blocks);
      const saveResponse = await fetch('/api/files/' + article.file_id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: nextMarkdown }),
      });
      const savePayload = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) throw new Error(savePayload.error || '保存文件失败');
      setArticle(nextArticle);
      setCachedContent(article.file_id, nextMarkdown);
      await refreshFiles();
      toast('修改已应用到当前文档', 'success');
    } catch (err) {
      toast(err.message || '应用修改失败', 'error');
    }
  }, [article, refreshFiles, setCachedContent, toast]);

  const handleCancelOperationSet = useCallback(async (operationSet) => {
    if (!operationSet?.id) return;
    try {
      const response = await fetch('/api/agent/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation_set_id: operationSet.id, action: 'cancel' }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || '撤销预览失败');
      toast('修改预览已撤销', 'success');
    } catch (err) {
      toast(err.message || '撤销预览失败', 'error');
    }
  }, [toast]);

  const aiUiState = useStableAiReadiness(deriveAiReadiness({ appStatus, llmConfigs, llmConfigsLoading, appStatusLoading }));

  return (
    <Shell active="canvas" fileName={article?.title || titleFromFile(activeFile)} tocDisabled navigateOnFileSelect={false}>
      <AgentWorkspace
        pageTitle="Notus Agent Workspace"
        modeLabel="AI 创作"
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
        onApplyOperationSet={handleApplyOperationSet}
        onCancelOperationSet={handleCancelOperationSet}
        disabled={aiUiState.showLockedState}
        placeholder="例如：把这篇文章改得更简洁，或为当前草稿加一个例子…"
      />
      {aiUiState.showLockedState ? (
        <AiLockedState
          variant="modal"
          title="创作功能尚未解锁"
          description={aiUiState.description || '请先完成模型配置。'}
          onAction={() => navigateWithFallback(router, '/settings/model')}
        />
      ) : null}
    </Shell>
  );
}
