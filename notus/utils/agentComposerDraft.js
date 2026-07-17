const DATABASE_NAME = 'notus-browser-state';
const DATABASE_VERSION = 1;
const STORE_NAME = 'agent-composer-drafts';
const DRAFT_ID = 'default';

let writeQueue = Promise.resolve();

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function enqueueWrite(task) {
  writeQueue = writeQueue.catch(() => {}).then(task);
  return writeQueue;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!isBrowser()) {
      reject(new Error('IndexedDB 只在浏览器端可用'));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开浏览器草稿存储失败'));
  });
}

function readRecord(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(DRAFT_ID);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('读取浏览器草稿失败'));
  });
}

function writeRecord(database, record) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('保存浏览器草稿失败'));
    transaction.objectStore(STORE_NAME).put(record);
  });
}

function deleteRecord(database) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('清除浏览器草稿失败'));
    transaction.objectStore(STORE_NAME).delete(DRAFT_ID);
  });
}

function serializableFile(item = {}) {
  const fileObject = item.fileObject;
  if (!fileObject || typeof fileObject !== 'object') return null;
  return {
    id: String(item.id || ''),
    name: String(item.name || '未命名附件'),
    size: Number(item.size || fileObject.size || 0),
    type: String(item.type || fileObject.type || ''),
    source_kind: String(item.source_kind || 'file'),
    media_kind: item.media_kind === 'image' ? 'image' : 'attachment',
    upload_order: Number.isFinite(Number(item.upload_order)) ? Number(item.upload_order) : 0,
    last_modified: Number(fileObject.lastModified || 0),
    blob: typeof fileObject.slice === 'function'
      ? fileObject.slice(0, fileObject.size, fileObject.type)
      : fileObject,
  };
}

function normalizeDraft(draft = {}) {
  return {
    content: String(draft.content || ''),
    mentions: Array.isArray(draft.mentions) ? draft.mentions : [],
    segments: Array.isArray(draft.segments) ? draft.segments : [],
    files: Array.isArray(draft.files) ? draft.files : [],
  };
}

export async function readAgentComposerDraft() {
  if (!isBrowser()) return null;
  let database;
  try {
    database = await openDatabase();
    const record = await readRecord(database);
    if (!record) return null;
    return normalizeDraft(record);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export function saveAgentComposerDraft(draft = {}) {
  if (!isBrowser()) return Promise.resolve();
  const normalized = normalizeDraft(draft);
  const files = normalized.files.map(serializableFile).filter(Boolean);
  if (!normalized.content && normalized.mentions.length === 0 && normalized.segments.length === 0 && files.length === 0) {
    return clearAgentComposerDraft();
  }
  return enqueueWrite(async () => {
    let database;
    try {
      database = await openDatabase();
      await writeRecord(database, {
        id: DRAFT_ID,
        content: normalized.content,
        mentions: normalized.mentions,
        segments: normalized.segments,
        files,
        saved_at: Date.now(),
      });
    } finally {
      database?.close();
    }
  });
}

export function clearAgentComposerDraft() {
  if (!isBrowser()) return Promise.resolve();
  return enqueueWrite(async () => {
    let database;
    try {
      database = await openDatabase();
      await deleteRecord(database);
    } finally {
      database?.close();
    }
  });
}

export function restoreAgentComposerFiles(files = []) {
  return (Array.isArray(files) ? files : []).map((item) => {
    if (!item?.blob) return null;
    const name = String(item.name || '未命名附件');
    const type = String(item.type || item.blob.type || 'application/octet-stream');
    const fileObject = typeof File === 'function'
      ? new File([item.blob], name, { type, lastModified: Number(item.last_modified || Date.now()) })
      : item.blob;
    const previewUrl = item.media_kind === 'image' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(fileObject)
      : '';
    return {
      id: String(item.id || `file-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name,
      size: Number(item.size || fileObject.size || 0),
      sizeLabel: '',
      type,
      source_kind: String(item.source_kind || (item.media_kind === 'image' ? 'image' : 'file')),
      media_kind: item.media_kind === 'image' ? 'image' : 'attachment',
      upload_order: Number.isFinite(Number(item.upload_order)) ? Number(item.upload_order) : 0,
      previewUrl,
      fileObject,
    };
  }).filter(Boolean);
}

export const AGENT_COMPOSER_DRAFT_STORAGE = {
  database: DATABASE_NAME,
  store: STORE_NAME,
  id: DRAFT_ID,
};
