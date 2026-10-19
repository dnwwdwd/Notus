export function ModelFailureDetails({ diagnostics, requestWindowId }) {
  if (!diagnostics) return null;
  const request = diagnostics.request;
  const duration = request && Number.isFinite(request.duration_ms) ? `${request.duration_ms} ms` : '耗时未记录';
  return (
    <div aria-label="模型请求诊断" style={{ fontSize: 'var(--text-xs)', lineHeight: 1.7, display: 'grid', gap: 6, minWidth: 0, marginTop: 8 }}>
      <div style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
        {diagnostics.http_status ? `HTTP ${diagnostics.http_status}` : '未取得 HTTP 错误状态'} · {diagnostics.model || '未知模型'} · {diagnostics.protocol || '未知协议'} · {duration}
        {requestWindowId ? ` · 请求窗口 #${requestWindowId}` : ''}
      </div>
      <div style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {diagnostics.provider_message || '模型服务未返回错误说明。'}
      </div>
      {diagnostics.provider_request_id ? <div style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>上游请求编号：{diagnostics.provider_request_id}</div> : null}
      {request ? <div style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
        估算输入 {request.estimated_input ?? '—'} / 上下文 {request.context_window ?? '—'} token · 最大输出 {request.max_output ?? '—'} token
        {request.attempt ? ` · 第 ${request.attempt} 次请求` : ''}{request.compaction_retry ? ` · 压缩重试 ${request.compaction_retry} 次` : ''}
      </div> : null}
      <details style={{ color: 'var(--text-secondary)', minWidth: 0 }}>
        <summary style={{ cursor: 'pointer' }}>模型请求诊断详情</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '6px 0 0', fontSize: 'inherit', maxHeight: 280, overflow: 'auto' }}>{JSON.stringify(diagnostics, null, 2)}</pre>
      </details>
    </div>
  );
}
