const fs = require('fs');
const os = require('os');
const path = require('path');
const formidable = require('formidable');
const { ensureRuntime } = require('../../../lib/runtime');
const { getSkill, setSkillEnabled, deleteSkill, installFromGit, updateSkillFromGit, installFromZip } = require('../../../lib/skills');

export const config = { api: { bodyParser: false } };

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('请求体不是有效 JSON'), { code: 'INVALID_JSON' }); }
}

function parseForm(req) {
  const form = formidable({ multiples: false, maxFileSize: 100 * 1024 * 1024 });
  return new Promise((resolve, reject) => form.parse(req, (error, fields, files) => error ? reject(error) : resolve({ fields, files })));
}

export default async function handler(req, res) {
  if (!ensureRuntime().ok) return res.status(500).json({ error: '运行时初始化失败' });
  const parts = Array.isArray(req.query.path) ? req.query.path : [];
  try {
    if (parts[0] === 'install' && parts[1] === 'git' && req.method === 'POST') return res.status(200).json(await installFromGit(await readJsonBody(req)));
    if (parts[0] === 'install' && parts[1] === 'zip' && req.method === 'POST') {
      const { fields, files } = await parseForm(req);
      const uploaded = files.file || files.archive;
      const file = Array.isArray(uploaded) ? uploaded[0] : uploaded;
      if (!file?.filepath) return res.status(400).json({ error: '请选择 ZIP 文件' });
      try { return res.status(200).json(await installFromZip(file.filepath, { conflictPolicy: fields.conflictPolicy })); } finally { fs.rmSync(file.filepath, { force: true }); }
    }
    const id = parts[0];
    if (!id) return res.status(404).end();
    if (parts[1] === 'update' && req.method === 'POST') return res.status(200).json(await updateSkillFromGit(id));
    if (parts[1] === 'state' && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      return res.status(200).json({ skill: setSkillEnabled(id, Boolean(body.enabled)) });
    }
    if (req.method === 'GET') { const skill = getSkill(id); return skill ? res.status(200).json({ skill }) : res.status(404).json({ error: 'Skill 不存在' }); }
    if (req.method === 'DELETE') return res.status(200).json(deleteSkill(id));
    return res.status(405).end();
  } catch (error) { return res.status(error.code === 'SKILL_NOT_MANAGED' ? 403 : 400).json({ error: error.message, code: error.code || 'SKILL_API_ERROR' }); }
}
