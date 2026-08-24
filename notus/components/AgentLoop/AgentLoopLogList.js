import { useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { getAgentLoopReasonLabel, getAgentToolLabel, getAgentToolResultSummary } from '../../utils/agentDisplay';
import { formatFullTimestamp, parseMessageTimestamp } from '../../utils/messageTimestamps';

function formatFallbackTimestamp(value) {
  return formatFullTimestamp(value);
}

function statusTone(status, result) {
  if (status === 'failed' || result?.error) return 'danger';
  if (status === 'running' || status === 'waiting_confirm') return 'warning';
  if (status === 'completed' || status === 'success') return 'success';
  return 'default';
}

function groupLogsByLoop(logs = []) {
  return (Array.isArray(logs) ? logs : [])
    .filter((log) => log?.tool_name && log.tool_name !== '__run_metadata__')
    .reduce((groups, log) => {
    const key = Number(log.loop_index || 0) || 0;
    if (!groups[key]) groups[key] = [];
    groups[key].push(log);
    return groups;
    }, {});
}

function formatElapsed(startedAt, finishedAt, now) {
  const started = parseMessageTimestamp(startedAt)?.getTime() || 0;
  const finished = parseMessageTimestamp(finishedAt)?.getTime() || now;
  const milliseconds = Math.max(0, finished - started);
  if (!started) return '';
  if (milliseconds < 1000) return '不到 1 秒';
  const seconds = Math.max(1, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}

function describeCurrentStage(session = {}) {
  const task = session.task || {};
  const segments = Array.isArray(session.execution_segments) ? session.execution_segments : [];
  const segment = [...segments].reverse().find((item) => !item?.completed_at) || segments.at(-1);
  const windows = Array.isArray(segment?.request_windows) ? segment.request_windows : [];
  const requestWindow = windows.at(-1);
  const sequence = Number(segment?.sequence_no || 0);
  const prefix = sequence ? `第 ${sequence} 个执行段` : '当前执行段';
  if (session.status === 'running') {
    if (requestWindow?.status === 'retrying') return `${prefix}：模型请求重试 ${requestWindow.retry_attempts || 0}/${requestWindow.retry_limit || 5}`;
    if (segment?.status === 'dispatching_tools') {
      const tools = Array.isArray(segment?.tool_names) ? segment.tool_names.filter(Boolean) : [];
      return tools.length ? `${prefix}：正在执行 ${tools.map(getAgentToolLabel).join('、')}` : `${prefix}：正在执行工具`;
    }
    if (requestWindow?.status === 'requesting' || segment?.status === 'requesting') return `${prefix}：正在等待模型响应`;
    return '正在准备模型请求';
  }
  if (session.status === 'queued') return '正在等待队列执行';
  if (session.status === 'waiting_operation_confirmation') return `${prefix}：等待确认文件修改`;
  if (session.status === 'waiting_interaction') return `${prefix}：等待回答提问卡片`;
  if (session.status === 'waiting_retry' || session.status === 'waiting_model_recovery') return `${prefix}：等待继续模型请求`;
  if (task.status === 'running') return '后台任务仍在运行，正在同步状态';
  return '';
}

export function AgentLoopLogList({
  sessions = [],
  loading = false,
  emptyText = '当前还没有 Agent Loop 执行日志。',
  formatTimestamp = formatFallbackTimestamp,
}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const [now, setNow] = useState(() => Date.now());
  const hasRunningSession = list.some((session) => ['created', 'queued', 'running'].includes(session?.status));

  useEffect(() => {
    if (!hasRunningSession) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningSession]);

  if (loading) return <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>正在读取 Agent Loop 日志...</div>;
  if (list.length === 0) return <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>{emptyText}</div>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {list.map((session) => {
        const logs = Array.isArray(session.run_logs) ? session.run_logs : [];
        const grouped = groupLogsByLoop(logs);
        const loopIndexes = Object.keys(grouped).map(Number).sort((a, b) => a - b);
        const task = session.task || {};
        const elapsed = formatElapsed(task.started_at || session.created_at, task.finished_at || (session.status === 'running' ? '' : session.updated_at), now);
        const currentStage = describeCurrentStage(session);
        return (
          <div key={session.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-elevated)', padding: 16, display: 'grid', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <Badge tone={statusTone(session.status)}>{session.status || 'unknown'}</Badge>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700 }}>Agent Loop #{session.id}</div>
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-xs)', lineHeight: 1.7, wordBreak: 'break-word' }}>
                  {session.goal || '未记录目标'}
                </div>
              </div>
              <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap', textAlign: 'right', lineHeight: 1.7 }}>
                <div>{formatTimestamp(session.updated_at || session.created_at)}</div>
                <div>{session.loop_count || 0} 轮 · {session.snapshots_count || 0} 快照{elapsed ? ` · 已运行 ${elapsed}` : ''}</div>
              </div>
            </div>
            {currentStage ? <div role={session.status === 'running' ? 'status' : undefined} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{currentStage}</div> : null}
            {session.reason ? (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                结束原因：{getAgentLoopReasonLabel(session.reason)}
              </div>
            ) : null}
            {loopIndexes.length === 0 ? (
              <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>该 session 暂无工具调用记录。</div>
            ) : loopIndexes.map((loopIndex) => (
              <div key={loopIndex} style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-secondary)' }}>第 {loopIndex} 轮</div>
                {grouped[loopIndex].map((log) => {
                  const failed = log.status === 'failed' || Boolean(log.tool_result?.error);
                  return (
                    <div
                      key={log.id}
                      style={{
                        border: `1px solid ${failed ? 'color-mix(in srgb, var(--danger) 30%, var(--border-subtle))' : 'var(--border-subtle)'}`,
                        borderRadius: 'var(--radius-md)',
                        background: failed ? 'color-mix(in srgb, var(--danger) 7%, var(--bg-primary))' : 'var(--bg-primary)',
                        padding: 12,
                        display: 'grid',
                        gap: 7,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <Badge tone={statusTone(log.status, log.tool_result)}>{failed ? '失败' : '成功'}</Badge>
                          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {getAgentToolLabel(log.tool_name)}
                          </div>
                        </div>
                        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>
                          {Number(log.duration_ms || 0)} ms
                        </div>
                      </div>
                      <div style={{ color: failed ? 'var(--danger)' : 'var(--text-secondary)', fontSize: 'var(--text-xs)', lineHeight: 1.7 }}>
                        {getAgentToolResultSummary(log.tool_result)}
                      </div>
                      {log.thinking ? (
                        <details style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
                          <summary style={{ cursor: 'pointer' }}>查看本轮思考文本</summary>
                          <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{log.thinking}</div>
                        </details>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
