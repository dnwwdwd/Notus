const { ensureRuntime } = require('../../../../../lib/runtime');

// 旧版路由会在 HTTP 请求内直接运行 Agent Loop。当前 Worker 已负责按
// resume_job_id 绑定并恢复队列任务，保留两条执行路径会绕开状态机，导致
// 同一个 interaction 有机会被重复续跑。前端已全部使用 /api/agent/loop/start
// 和 session SSE；这里明确拒绝旧协议，避免旧客户端悄悄回退到不安全路径。
export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }
  const runtime = ensureRuntime();
  if (!runtime.ok) {
    return res.status(500).json({
      error: 'Agent 服务初始化失败',
      code: 'RUNTIME_ERROR',
    });
  }
  return res.status(410).json({
    error: '旧版提问卡片续跑接口已停用，请刷新页面后继续任务。',
    code: 'RESUME_INTERACTION_ROUTE_RETIRED',
  });
}
