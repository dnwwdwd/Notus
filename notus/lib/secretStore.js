const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getEffectiveConfig } = require('./config');
const { inferRuntimeTarget } = require('./platform/target');

function secretDir() {
  return path.join(getEffectiveConfig().dataRoot, 'secrets');
}

function masterKeyPath() {
  return path.join(secretDir(), 'mcp-master.key');
}

function getMasterKey() {
  const file = masterKeyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600 });
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new Error('MCP 密钥存储不可用');
  return key;
}

function localSecretPath(id) {
  return path.join(secretDir(), `${id}.json`);
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') };
}

function decrypt(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.body, 'base64')), decipher.final()]).toString('utf8');
}

async function bridge(action, payload = {}) {
  const url = process.env.NOTUS_SECRET_BRIDGE_URL;
  const token = process.env.NOTUS_SECRET_BRIDGE_TOKEN;
  if (!url || !token) return null;
  const response = await fetch(`${url}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notus-secret-token': token },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '桌面密钥服务不可用');
  return result;
}

async function saveSecret(value) {
  const normalized = String(value || '');
  if (!normalized) return '';
  if (inferRuntimeTarget() === 'electron') {
    const result = await bridge('set', { value: normalized });
    if (result?.id) return result.id;
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(secretDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(localSecretPath(id), JSON.stringify(encrypt(normalized)), { mode: 0o600 });
  return id;
}

async function readSecret(id) {
  if (!id) return '';
  if (inferRuntimeTarget() === 'electron') {
    const result = await bridge('get', { id });
    if (result && Object.prototype.hasOwnProperty.call(result, 'value')) return String(result.value || '');
  }
  const file = localSecretPath(id);
  if (!fs.existsSync(file)) throw new Error('SECRET_NOT_FOUND');
  return decrypt(JSON.parse(fs.readFileSync(file, 'utf8')));
}

async function removeSecret(id) {
  if (!id) return;
  if (inferRuntimeTarget() === 'electron') {
    const result = await bridge('delete', { id });
    if (result) return;
  }
  fs.rmSync(localSecretPath(id), { force: true });
}

module.exports = { saveSecret, readSecret, removeSecret };
