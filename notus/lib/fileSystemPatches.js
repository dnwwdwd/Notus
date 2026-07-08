const fs = require('fs');
const path = require('path');
const { getEffectiveConfig } = require('./config');
const {
  buildRenamedFolderPath,
  createFolder,
  deleteFolder,
  ensureMarkdownPath,
  folderExists,
  getBaseName,
  getParentPath,
  listMarkdownFilesUnderFolder,
  moveFolder,
  normalizeFolderPath,
  renameFile,
  renameFolder,
  restoreFolderSnapshot,
  snapshotFolder,
} = require('./files');
const { removeFile: removeFileFromIndex, triggerIncrementalIndex } = require('./indexer');

const FILE_SYSTEM_PATCH_TYPES = new Set([
  'create_folder',
  'rename_folder',
  'move_folder',
  'move_file',
  'delete_folder',
]);

function normalizeChangeType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return FILE_SYSTEM_PATCH_TYPES.has(normalized) ? normalized : '';
}

function isFileSystemPatch(patch = {}) {
  return Boolean(normalizeChangeType(patch.change_type || patch.type || patch.op));
}

function normalizeDirectoryDestination(value = '') {
  const raw = String(value || '').replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  return raw ? normalizeFolderPath(raw) : '';
}

function normalizeFileSystemPatch(patch = {}, options = {}) {
  const changeType = normalizeChangeType(patch.change_type || patch.type || patch.op);
  if (!changeType) throw new Error('unsupported file system patch type');

  if (changeType === 'create_folder') {
    const folderPath = normalizeFolderPath(patch.folder_path || patch.path || patch.new_path);
    return {
      ...patch,
      change_type: changeType,
      file_path: folderPath,
      folder_path: folderPath,
      old: '',
      new: folderPath,
    };
  }

  if (changeType === 'delete_folder') {
    const folderPath = normalizeFolderPath(patch.folder_path || patch.path || patch.old_path || patch.file_path);
    const snapshot = patch.snapshot || (options.captureDeleteSnapshot ? snapshotFolder(folderPath) : null);
    return {
      ...patch,
      change_type: changeType,
      file_path: folderPath,
      folder_path: folderPath,
      old_path: folderPath,
      old: snapshot
        ? (snapshot.files || []).map((file) => file.path).join('\n')
        : String(patch.old || folderPath),
      new: '',
      snapshot,
    };
  }

  if (changeType === 'move_file') {
    const oldPath = ensureMarkdownPath(patch.old_path || patch.from_path || patch.file_path || patch.path);
    let newPath = patch.new_path || patch.to_path;
    if (!newPath && Object.prototype.hasOwnProperty.call(patch, 'dest')) {
      const dest = normalizeDirectoryDestination(patch.dest);
      newPath = dest ? `${dest}/${getBaseName(oldPath)}` : getBaseName(oldPath);
    }
    newPath = ensureMarkdownPath(newPath);
    return {
      ...patch,
      change_type: changeType,
      file_path: oldPath,
      old_path: oldPath,
      new_path: newPath,
      old: oldPath,
      new: newPath,
    };
  }

  const oldPath = normalizeFolderPath(patch.old_path || patch.from_path || patch.folder_path || patch.path || patch.file_path);
  let newPath = patch.new_path || patch.to_path;
  if (!newPath && changeType === 'move_folder' && Object.prototype.hasOwnProperty.call(patch, 'dest')) {
    const dest = normalizeDirectoryDestination(patch.dest);
    newPath = dest ? `${dest}/${getBaseName(oldPath)}` : getBaseName(oldPath);
  }
  if (!newPath && changeType === 'rename_folder' && patch.name) {
    newPath = buildRenamedFolderPath(oldPath, patch.name);
  }
  newPath = normalizeFolderPath(newPath);
  return {
    ...patch,
    change_type: changeType,
    file_path: oldPath,
    folder_path: oldPath,
    old_path: oldPath,
    new_path: newPath,
    old: oldPath,
    new: newPath,
  };
}

function patchConflict(reason, patch) {
  return {
    success: false,
    conflict: true,
    conflicting_files: [{
      path: patch?.new_path || patch?.file_path || patch?.folder_path || '',
      reason,
    }],
  };
}

function scheduleIndex(relativePath) {
  if (!/\.md$/i.test(String(relativePath || ''))) return;
  triggerIncrementalIndex(relativePath).catch(() => {});
}

function removeFolderFromIndex(folderPath, snapshot = null) {
  const files = snapshot?.files?.length
    ? snapshot.files.map((file) => file.path)
    : listMarkdownFilesUnderFolder(folderPath);
  files.forEach((filePath) => {
    try { removeFileFromIndex(filePath); } catch {}
  });
}

function removeEmptyFolder(folderPath, force = false) {
  const config = getEffectiveConfig();
  const targetPath = normalizeFolderPath(folderPath);
  const root = path.resolve(config.notesDir);
  const absolute = path.resolve(root, targetPath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) throw new Error('invalid folder path');
  if (!fs.existsSync(absolute)) return { removed: false };
  if (!fs.statSync(absolute).isDirectory()) throw new Error('folder not found');
  const entries = fs.readdirSync(absolute);
  if (entries.length > 0 && !force) {
    return { conflict: true, reason: 'FOLDER_NOT_EMPTY' };
  }
  fs.rmSync(absolute, { recursive: true, force: true });
  return { removed: true };
}

async function applyFileSystemPatch(rawPatch = {}, options = {}) {
  let patch;
  try {
    patch = normalizeFileSystemPatch(rawPatch, { captureDeleteSnapshot: true });
  } catch (error) {
    return { success: false, error: error.message };
  }

  try {
    if (patch.change_type === 'create_folder') {
      if (folderExists(patch.folder_path)) return patchConflict('FOLDER_ALREADY_EXISTS', patch);
      createFolder(patch.folder_path);
      return { success: true, changed_files: [], patch };
    }

    if (patch.change_type === 'delete_folder') {
      const snapshot = patch.snapshot || snapshotFolder(patch.folder_path);
      removeFolderFromIndex(patch.folder_path, snapshot);
      deleteFolder(patch.folder_path);
      return { success: true, changed_files: (snapshot.files || []).map((file) => file.path), patch: { ...patch, snapshot } };
    }

    if (patch.change_type === 'move_file') {
      const moved = renameFile(patch.old_path, patch.new_path);
      scheduleIndex(moved.path);
      return { success: true, changed_files: [moved.path], patch };
    }

    if (patch.change_type === 'move_folder' || patch.change_type === 'rename_folder') {
      const before = listMarkdownFilesUnderFolder(patch.old_path);
      const moved = patch.change_type === 'move_folder'
        ? moveFolder(patch.old_path, getParentPath(patch.new_path))
        : renameFolder(patch.old_path, patch.new_path);
      const after = before.map((filePath) => `${moved.new_path}/${filePath.slice(`${moved.old_path}/`.length)}`);
      after.forEach(scheduleIndex);
      return { success: true, changed_files: after, patch };
    }

    return { success: false, error: 'UNSUPPORTED_FILE_SYSTEM_PATCH' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function rollbackFileSystemPatch(rawPatch = {}, options = {}) {
  let patch;
  try {
    patch = normalizeFileSystemPatch(rawPatch);
  } catch (error) {
    return { success: false, error: error.message };
  }

  try {
    if (patch.change_type === 'create_folder') {
      const removed = removeEmptyFolder(patch.folder_path, Boolean(options.force));
      if (removed.conflict) return patchConflict(removed.reason, patch);
      return { success: true, changed_files: [], patch };
    }

    if (patch.change_type === 'delete_folder') {
      const restored = restoreFolderSnapshot(patch.snapshot || { path: patch.folder_path, files: [] });
      restored.restored_files.forEach(scheduleIndex);
      return { success: true, changed_files: restored.restored_files, patch };
    }

    if (patch.change_type === 'move_file') {
      const moved = renameFile(patch.new_path, patch.old_path);
      scheduleIndex(moved.path);
      return { success: true, changed_files: [moved.path], patch };
    }

    if (patch.change_type === 'move_folder' || patch.change_type === 'rename_folder') {
      const before = listMarkdownFilesUnderFolder(patch.new_path);
      const moved = renameFolder(patch.new_path, patch.old_path);
      const after = before.map((filePath) => `${moved.new_path}/${filePath.slice(`${moved.old_path}/`.length)}`);
      after.forEach(scheduleIndex);
      return { success: true, changed_files: after, patch };
    }

    return { success: false, error: 'UNSUPPORTED_FILE_SYSTEM_PATCH' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  FILE_SYSTEM_PATCH_TYPES,
  applyFileSystemPatch,
  isFileSystemPatch,
  normalizeFileSystemPatch,
  rollbackFileSystemPatch,
};
