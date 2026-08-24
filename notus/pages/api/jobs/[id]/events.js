const { ensureRuntime } = require('../../../../lib/runtime');
const { getJob } = require('../../../../lib/skills');

export default function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  if (!ensureRuntime().ok) return res.status(500).end();
  const job = getJob(req.query.id);
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.write(`data: ${JSON.stringify({ type: 'job.progress', jobId: job.id, stage: job.stage, progress: job.progress, status: job.status, result: job.result, error: job.error_message || null })}\n\n`);
  return res.end();
}
