import { Badge } from '../ui/Badge';
import { getAgentLoopReasonLabel, getAgentToolLabel, getAgentToolResultSummary } from '../../utils/agentDisplay';

function formatFallbackTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

function statusTone(status, result) {
  if (status === 'failed' || result?.error) return 'danger';
  if (status === 'running' || status === 'waiting_confirm') return 'warning';
  if (status === 'completed' || status === 'success') return 'success';
  return 'default';
}

function groupLogsByLoop(logs = []) {
  return (Array.isArray(logs) ? logs : []).reduce((groups, log) => {
    const key = Number(log.loop_index || 0) || 0;
    if (!groups[key]) groups[key] = [];
    groups[key].push(log);
    return groups;
  }, {});
}

export function AgentLoopLogList({
  sessions = [],
  loading = false,
  emptyText = '当前还没有 Agent Loop 执行日志。',
  formatTimestamp = formatFallbackTimestamp,
}) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (loading) return <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>正在读取 Agent Loop 日志...</div>;
  if (list.length === 0) return <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>{emptyText}</div>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {list.map((session) => {
        const logs = Array.isArray(session.run_logs) ? session.run_logs : [];
        const grouped = groupLogsByLoop(logs);
        const loopIndexes = Object.keys(grouped).map(Number).sort((a, b) => a - b);
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
                <div>{session.loop_count || 0} 轮 · {session.snapshots_count || 0} 快照</div>
              </div>
            </div>
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
