import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Icons } from '../ui/Icons';
import { Button } from '../ui/Button';
import { DropdownSelect } from '../ui/DropdownSelect';
import { Dialog } from '../ui/Dialog';
import { SearchInput, TextInput } from '../ui/Input';
import { useToast } from '../ui/Toast';
import { useApp } from '../../contexts/AppContext';

function flatTree(nodes, openFolders, searchMode = false, depth = 0) {
  const out = [];
  nodes.forEach((node) => {
    const isOpen = node.type === 'folder' && (searchMode || openFolders.has(node.path));
    out.push({ ...node, open: isOpen, depth });
    if (isOpen && node.children) {
      out.push(...flatTree(node.children, openFolders, searchMode, depth + 1));
    }
  });
  return out;
}

function filterTree(nodes, query) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return nodes;

  return nodes.reduce((accumulator, node) => {
    const matchesSelf = node.name.toLowerCase().includes(keyword) || node.path.toLowerCase().includes(keyword);

    if (node.type === 'folder') {
      const children = filterTree(node.children || [], query);
      if (matchesSelf || children.length > 0) {
        accumulator.push({ ...node, children });
      }
      return accumulator;
    }

    if (matchesSelf) {
      accumulator.push(node);
    }
    return accumulator;
  }, []);
}

function extractParentPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

async function parseErrorResponse(response, fallbackMessage) {
  try {
    const payload = await response.json();
    return payload?.error || fallbackMessage;
  } catch {
    try {
      const text = await response.text();
      return text || fallbackMessage;
    } catch {
      return fallbackMessage;
    }
  }
}

async function consumeSseResponse(response, onPayload) {
  if (!response.ok) {
    throw new Error(await parseErrorResponse(response, '请求失败'));
  }
  if (!response.body) {
    throw new Error('当前浏览器不支持流式响应');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleChunk = (chunk) => {
    const line = chunk.split('\n').find((item) => item.startsWith('data:'));
    if (!line) return;
    const payload = JSON.parse(line.slice(5).trim());
    onPayload(payload);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    parts.forEach(handleChunk);
  }

  const tail = buffer.trim();
  if (tail) handleChunk(tail);
}

function parseDownloadFilename(contentDisposition) {
  const header = String(contentDisposition || '');
  const match = header.match(/filename="(.+?)"/i);
  return match ? match[1] : `notus-export-${Date.now()}.zip`;
}

function formatImportSummary(summary) {
  if (!summary) return '';
  return `新增 ${summary.imported || 0}，覆盖 ${summary.overwritten || 0}，跳过 ${summary.skipped || 0}，失败 ${summary.failed || 0}`;
}

function getImportDisplayName(file) {
  return file?.webkitRelativePath || file?.name || '';
}

function getImportStatusLabel(status) {
  return {
    imported: '已导入',
    overwritten: '已覆盖',
    skipped: '已跳过',
    failed: '导入失败',
  }[status] || '处理中';
}

const FileRow = ({ item, isActive, onSelect, onToggle }) => {
  const pad = 8 + item.depth * 16;
  const isFolder = item.type === 'folder';

  return (
    <div
      onClick={() => isFolder ? onToggle(item.path) : onSelect(item)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: `0 8px 0 ${pad}px`,
        borderRadius: 'var(--radius-sm)',
        margin: '0 6px',
        background: isActive ? 'var(--accent-subtle)' : 'transparent',
        color: isActive ? 'var(--accent)' : 'var(--text-primary)',
        fontSize: 'var(--text-sm)',
        fontWeight: isActive ? 500 : 400,
        cursor: 'pointer',
        transition: 'background var(--transition-fast)',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
    >
      {isFolder ? (
        <>
          {item.open
            ? <Icons.chevronDown size={12} />
            : <Icons.chevronRight size={12} />}
          {item.open ? <Icons.folderOpen size={14} /> : <Icons.folder size={14} />}
        </>
      ) : (
        <>
          <span style={{ width: 12 }} />
          <Icons.file size={14} />
        </>
      )}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.name}
      </span>
      {item.status === 'indexing' && (
        <span style={{ color: 'var(--warning)', fontSize: 10 }}>⏳</span>
      )}
      {item.status === 'error' && (
        <span style={{ color: 'var(--danger)', fontSize: 10 }}>⚠</span>
      )}
    </div>
  );
};

export const Sidebar = ({ tocDisabled = true, tocItems, width = 240, beforeFileSelect, navigateOnFileSelect = true }) => {
  const router = useRouter();
  const toast = useToast();
  const importFileInputRef = useRef(null);
  const importDirectoryInputRef = useRef(null);
  const {
    files,
    allFiles,
    folderOptions,
    loadingFiles,
    hasLoadedFilesOnce,
    openFolders,
    toggleFolder,
    activeFileId,
    activeFile,
    selectFile,
    createFile,
    createFolder,
    refreshFiles,
  } = useApp();

  const [activeTab, setActiveTab] = useState('tree');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [createMode, setCreateMode] = useState(null);
  const [newName, setNewName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [importResultOpen, setImportResultOpen] = useState(false);
  const [importParentPath, setImportParentPath] = useState('');
  const [conflictPolicy, setConflictPolicy] = useState('skip');
  const [selectedImportFiles, setSelectedImportFiles] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0, currentFile: '', stage: 'idle' });
  const [importResults, setImportResults] = useState([]);
  const [importSummary, setImportSummary] = useState(null);
  const [importRunError, setImportRunError] = useState('');

  const [exportOpen, setExportOpen] = useState(false);
  const [exportQuery, setExportQuery] = useState('');
  const [selectedExportIds, setSelectedExportIds] = useState(new Set());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (tocDisabled) setActiveTab('tree');
  }, [tocDisabled]);

  const filteredTree = useMemo(() => filterTree(files, searchQuery), [files, searchQuery]);
  const flat = useMemo(
    () => flatTree(filteredTree, openFolders, Boolean(searchQuery.trim())),
    [filteredTree, openFolders, searchQuery]
  );

  const exportCandidates = useMemo(() => {
    const keyword = exportQuery.trim().toLowerCase();
    if (!keyword) return allFiles;
    return allFiles.filter((file) => {
      const target = `${file.title || ''} ${file.name || ''} ${file.path || ''}`.toLowerCase();
      return target.includes(keyword);
    });
  }, [allFiles, exportQuery]);

  const importSucceededResults = useMemo(
    () => importResults.filter((item) => ['imported', 'overwritten'].includes(item.status)),
    [importResults]
  );

  const importSkippedResults = useMemo(
    () => importResults.filter((item) => item.status === 'skipped'),
    [importResults]
  );

  const importFailedResults = useMemo(
    () => importResults.filter((item) => item.status === 'failed'),
    [importResults]
  );

  const retryableImportFiles = useMemo(() => {
    if (importFailedResults.length === 0 || selectedImportFiles.length === 0) return [];
    const failedNames = new Set(importFailedResults.map((item) => item.name || item.path));
    return selectedImportFiles.filter((file) => failedNames.has(getImportDisplayName(file)));
  }, [importFailedResults, selectedImportFiles]);

  const handleSelectFile = (file) => {
    if (beforeFileSelect && beforeFileSelect(file) === false) return;
    selectFile(file);
    if (navigateOnFileSelect && router.pathname !== '/files') {
      router.push('/files');
    }
  };

  const resetCreateDialog = () => {
    setCreateMode(null);
    setNewName('');
    setParentPath('');
    setSubmitting(false);
  };

  const clearImportInputs = () => {
    if (importFileInputRef.current) importFileInputRef.current.value = '';
    if (importDirectoryInputRef.current) importDirectoryInputRef.current.value = '';
  };

  const clearImportRunState = () => {
    setImportProgress({ current: 0, total: 0, currentFile: '', stage: 'idle' });
    setImportResults([]);
    setImportSummary(null);
    setImportRunError('');
  };

  const resetImportDialog = () => {
    if (importing) return;
    setImportOpen(false);
    setImportResultOpen(false);
    setImportParentPath('');
    setConflictPolicy('skip');
    setSelectedImportFiles([]);
    clearImportRunState();
    clearImportInputs();
  };

  const handleOpenImportDialog = () => {
    setActiveTab('tree');
    setImportOpen(true);
    setImportResultOpen(false);
    setImportParentPath(extractParentPath(activeFile?.path));
    setConflictPolicy('skip');
    setSelectedImportFiles([]);
    clearImportRunState();
    clearImportInputs();
  };

  const handleOpenExportDialog = () => {
    setActiveTab('tree');
    setExportOpen(true);
    setExportQuery('');
    setSelectedExportIds(new Set(activeFileId ? [activeFileId] : []));
  };

  const handleCreate = async () => {
    if (!newName.trim()) {
      toast(createMode === 'folder' ? '请输入目录名称' : '请输入文件名称', 'warning');
      return;
    }

    setSubmitting(true);
    try {
      if (createMode === 'folder') {
        await createFolder({ parentPath, name: newName.trim() });
        toast('目录已创建', 'success');
      } else {
        const created = await createFile({ parentPath, name: newName.trim() });
        toast(created.index_state === 'queued' ? '文件已创建，后台索引已入队' : '文件已创建', 'success');
        if (navigateOnFileSelect && router.pathname !== '/files') {
          router.push('/files');
        }
      }
      resetCreateDialog();
    } catch (error) {
      toast(error.message || '创建失败', 'warning');
      setSubmitting(false);
    }
  };

  const handleImportSelection = (fileList) => {
    const nextFiles = Array.from(fileList || []).filter((file) => /\.md$/i.test(file.name));
    if (nextFiles.length === 0) {
      toast('请选择 .md 文件', 'warning');
      return;
    }

    const deduped = [];
    const seen = new Set();
    nextFiles.forEach((file) => {
      const key = getImportDisplayName(file);
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(file);
    });

    setSelectedImportFiles(deduped);
    clearImportRunState();
    setImportProgress({ current: 0, total: deduped.length, currentFile: '', stage: 'idle' });
  };

  const runImport = async (filesToImport = selectedImportFiles) => {
    if (filesToImport.length === 0) {
      toast('请先选择要导入的 Markdown 文件', 'warning');
      return;
    }

    setSelectedImportFiles(filesToImport);
    setImportOpen(false);
    setImportResultOpen(true);
    setImporting(true);
    clearImportRunState();
    setImportProgress({ current: 0, total: filesToImport.length, currentFile: '', stage: 'idle' });

    try {
      const payloadFiles = await Promise.all(
        filesToImport.map(async (file) => ({
          name: getImportDisplayName(file),
          content: await file.text(),
        }))
      );

      const response = await fetch('/api/files/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPath: importParentPath,
          conflict_policy: conflictPolicy,
          files: payloadFiles,
        }),
      });

      let summary = null;
      await consumeSseResponse(response, (event) => {
        if (event.type === 'progress') {
          setImportProgress({
            current: event.current || 0,
            total: event.total || payloadFiles.length,
            currentFile: event.currentFile || '',
            stage: event.stage || 'idle',
          });
          return;
        }

        if (event.type === 'file') {
          setImportResults((prev) => [...prev, event]);
          return;
        }

        if (event.type === 'done') {
          summary = event;
          setImportSummary(event);
          setImportProgress({
            current: event.total || payloadFiles.length,
            total: event.total || payloadFiles.length,
            currentFile: '',
            stage: 'done',
          });
        }
      });

      await refreshFiles();
      toast(
        summary ? `导入完成：${formatImportSummary(summary)}` : '导入完成',
        summary && summary.failed > 0 ? 'warning' : 'success'
      );
    } catch (error) {
      const message = error.message || '导入失败';
      setImportRunError(message);
      setImportProgress((prev) => ({
        ...prev,
        stage: 'error',
      }));
      toast(message, 'warning');
    } finally {
      setImporting(false);
    }
  };

  const handleImport = async () => {
    await runImport(selectedImportFiles);
  };

  const handleRetryFailedImports = async () => {
    if (retryableImportFiles.length === 0) return;
    await runImport(retryableImportFiles);
  };

  const toggleExportSelection = (fileId) => {
    setSelectedExportIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const handleExport = async () => {
    const ids = [...selectedExportIds];
    if (ids.length === 0) {
      toast('请至少选择一个文件', 'warning');
      return;
    }

    setExporting(true);
    try {
      const response = await fetch(`/api/files/export?ids=${ids.join(',')}`);
      if (!response.ok) {
        throw new Error(await parseErrorResponse(response, '导出失败'));
      }

      const blob = await response.blob();
      const filename = parseDownloadFilename(response.headers.get('content-disposition'));
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      toast(`已导出 ${ids.length} 个文件`, 'success');
      setExportOpen(false);
    } catch (error) {
      toast(error.message || '导出失败', 'warning');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      width,
      background: 'var(--bg-sidebar)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      height: '100%',
      overflow: 'hidden',
    }}>
      <input
        ref={importFileInputRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        style={{ display: 'none' }}
        onChange={(event) => handleImportSelection(event.target.files)}
      />
      <input
        ref={importDirectoryInputRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        webkitdirectory=""
        directory=""
        style={{ display: 'none' }}
        onChange={(event) => handleImportSelection(event.target.files)}
      />

      <Dialog
        open={Boolean(createMode)}
        onClose={resetCreateDialog}
        title={createMode === 'folder' ? '新建目录' : '新建文件'}
        footer={
          <>
            <Button variant="ghost" onClick={resetCreateDialog}>取消</Button>
            <Button variant="primary" loading={submitting} onClick={handleCreate}>
              {createMode === 'folder' ? '创建目录' : '创建文件'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6 }}>位置</div>
            <DropdownSelect
              value={parentPath}
              options={folderOptions}
              onChange={(nextValue) => setParentPath(nextValue)}
              searchable
              searchPlaceholder="搜索目录"
            />
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6 }}>
              {createMode === 'folder' ? '目录名' : '文件名'}
            </div>
            <TextInput
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={createMode === 'folder' ? '例如：新的专题' : '例如：新的草稿'}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleCreate();
              }}
            />
            {createMode !== 'folder' && (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                无需输入 `.md` 后缀，系统会自动补齐。
              </div>
            )}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={importOpen}
        onClose={resetImportDialog}
        title="导入 Markdown"
        maxWidth={640}
        footer={
          <>
            <Button variant="ghost" onClick={resetImportDialog} disabled={importing}>关闭</Button>
            <Button variant="secondary" onClick={() => importFileInputRef.current?.click()} disabled={importing}>
              选择文件
            </Button>
            <Button variant="secondary" onClick={() => importDirectoryInputRef.current?.click()} disabled={importing}>
              选择目录
            </Button>
            <Button variant="primary" loading={importing} onClick={handleImport}>
              开始导入
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6 }}>导入到</div>
            <DropdownSelect
              value={importParentPath}
              options={folderOptions}
              onChange={(nextValue) => setImportParentPath(nextValue)}
              searchable
              searchPlaceholder="搜索目录"
            />
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 6 }}>重名处理</div>
            <DropdownSelect
              value={conflictPolicy}
              options={[
                { value: 'skip', label: '跳过已有文件' },
                { value: 'overwrite', label: '覆盖已有文件' },
              ]}
              onChange={(nextValue) => setConflictPolicy(nextValue)}
            />
          </div>
          <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>待导入文件</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{selectedImportFiles.length} 个</div>
            </div>
            {selectedImportFiles.length === 0 ? (
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                支持直接选择多个 `.md` 文件，也支持选择本地目录后保留子目录结构。
              </div>
            ) : (
              <div style={{ maxHeight: 180, overflow: 'auto', display: 'grid', gap: 6 }}>
                {selectedImportFiles.map((file) => {
                  const label = file.webkitRelativePath || file.name;
                  return (
                    <div
                      key={label}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--bg-primary)',
                        border: '1px solid var(--border-subtle)',
                        fontSize: 'var(--text-sm)',
                        color: 'var(--text-primary)',
                        fontFamily: 'var(--font-mono)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={label}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </Dialog>

      <Dialog
        open={importResultOpen}
        onClose={resetImportDialog}
        title={importing ? '正在导入 Markdown' : '导入结果'}
        maxWidth={720}
        footer={
          importing ? (
            <Button variant="ghost" disabled>处理中…</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={handleOpenImportDialog}>重新选择</Button>
              <Button
                variant="secondary"
                onClick={handleRetryFailedImports}
                disabled={retryableImportFiles.length === 0}
              >
                重试失败项
              </Button>
              <Button variant="primary" onClick={resetImportDialog}>关闭</Button>
            </>
          )
        }
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>
                {importing ? '导入进度' : '处理概览'}
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                {importProgress.total ? `${Math.min(importProgress.current, importProgress.total)} / ${importProgress.total}` : '等待开始'}
              </div>
            </div>
            {importProgress.total > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ height: 8, borderRadius: 999, background: 'var(--bg-active)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.round((Math.min(importProgress.current, importProgress.total) / importProgress.total) * 100)}%`,
                      height: '100%',
                      background: importProgress.stage === 'error' ? 'var(--danger)' : 'var(--accent)',
                    }}
                  />
                </div>
              </div>
            )}
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              {importing
                ? (importProgress.currentFile
                  ? `当前${importProgress.stage === 'indexing' ? '索引' : '保存'}：${importProgress.currentFile}`
                  : '正在准备导入…')
                : (importSummary ? formatImportSummary(importSummary) : '本轮导入已结束')}
            </div>
            {(importSummary?.warnings || 0) > 0 && (
              <div style={{ marginTop: 8, fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
                另有 {importSummary.warnings} 个文件已写入，但索引后台告警已记录到日志，不影响本次导入结果。
              </div>
            )}
          </div>

          {importRunError && (
            <div style={{
              padding: '12px 14px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--danger-subtle)',
              border: '1px solid color-mix(in srgb, var(--danger) 24%, transparent)',
              color: 'var(--danger)',
              fontSize: 'var(--text-sm)',
              lineHeight: 1.7,
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
            }}>
              {importRunError}
            </div>
          )}

          {importSucceededResults.length > 0 && (
            <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 8 }}>
                导入成功 · {importSucceededResults.length}
              </div>
              <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 8 }}>
                {importSucceededResults.map((item, index) => (
                  <div
                    key={`${item.path || item.name}-${index}`}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-subtle)',
                      display: 'grid',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ color: item.status === 'overwritten' ? 'var(--accent)' : 'var(--success)', fontWeight: 600, flexShrink: 0 }}>
                        {getImportStatusLabel(item.status)}
                      </span>
                      <span style={{ color: 'var(--text-primary)', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        {item.path || item.name}
                      </span>
                    </div>
                    {item.index_state === 'queued' && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
                        文件已导入，后台索引已排队处理。
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {importSkippedResults.length > 0 && (
            <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 8 }}>
                已跳过 · {importSkippedResults.length}
              </div>
              <div style={{ maxHeight: 160, overflow: 'auto', display: 'grid', gap: 8 }}>
                {importSkippedResults.map((item, index) => (
                  <div
                    key={`${item.path || item.name}-${index}`}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-subtle)',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--text-secondary)',
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {item.path || item.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          {importFailedResults.length > 0 && (
            <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-lg)', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 8 }}>
                导入失败 · {importFailedResults.length}
              </div>
              <div style={{ maxHeight: 220, overflow: 'auto', display: 'grid', gap: 8 }}>
                {importFailedResults.map((item, index) => (
                  <div
                    key={`${item.path || item.name}-${index}`}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border-subtle)',
                      display: 'grid',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ color: 'var(--danger)', fontWeight: 600, flexShrink: 0 }}>
                        {getImportStatusLabel(item.status)}
                      </span>
                      <span style={{ color: 'var(--text-primary)', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        {item.path || item.name}
                      </span>
                    </div>
                    {item.error && (
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.6, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                        {item.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={exportOpen}
        onClose={() => !exporting && setExportOpen(false)}
        title="导出 Markdown"
        maxWidth={640}
        footer={
          <>
            <Button variant="ghost" onClick={() => setExportOpen(false)} disabled={exporting}>取消</Button>
            <Button variant="primary" loading={exporting} onClick={handleExport}>
              导出选中文件
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <SearchInput
              value={exportQuery}
              placeholder="搜索文件名或路径"
              onChange={(event) => setExportQuery(event.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, fontSize: 'var(--text-sm)' }}>
            <span>已选 {selectedExportIds.size} 个文件</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedExportIds(new Set(exportCandidates.map((file) => file.id)))}
              >
                全选当前结果
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedExportIds(new Set())}
              >
                清空
              </Button>
            </div>
          </div>
          <div style={{ maxHeight: 320, overflow: 'auto', display: 'grid', gap: 8 }}>
            {exportCandidates.length === 0 ? (
              <div style={{ padding: '18px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                没有匹配的文件
              </div>
            ) : exportCandidates.map((file) => {
              const checked = selectedExportIds.has(file.id);
              return (
                <button
                  key={file.id}
                  type="button"
                  onClick={() => toggleExportSelection(file.id)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-lg)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: checked ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-primary)'}`,
                      background: checked ? 'var(--accent)' : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      flexShrink: 0,
                    }}
                  >
                    {checked && <Icons.check size={11} />}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {file.title || file.name}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {file.path}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </Dialog>

      <div style={{
        height: 40,
        display: 'flex',
        alignItems: 'center',
        padding: '0 6px',
        borderBottom: '1px solid var(--border-subtle)',
        gap: 2,
      }}>
        <button
          onClick={() => setActiveTab('tree')}
          title="文件树"
          style={{
            width: 32,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: activeTab === 'tree' ? 'var(--text-primary)' : 'var(--text-tertiary)',
            position: 'relative',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <Icons.folder size={16} />
          {activeTab === 'tree' && (
            <div style={{ position: 'absolute', left: 6, right: 6, bottom: -2, height: 2, background: 'var(--accent)' }} />
          )}
        </button>

        <button
          onClick={() => !tocDisabled && setActiveTab('toc')}
          title={tocDisabled ? '选择文件后可查看大纲' : '文档大纲'}
          style={{
            width: 32,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tocDisabled ? 'var(--text-tertiary)' : (activeTab === 'toc' ? 'var(--text-primary)' : 'var(--text-secondary)'),
            opacity: tocDisabled ? 0.4 : 1,
            position: 'relative',
            borderRadius: 'var(--radius-sm)',
            cursor: tocDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          <Icons.list size={16} />
          {activeTab === 'toc' && !tocDisabled && (
            <div style={{ position: 'absolute', left: 6, right: 6, bottom: -2, height: 2, background: 'var(--accent)' }} />
          )}
        </button>

        <div style={{ flex: 1 }} />

        <button
          title="搜索文件"
          onClick={() => {
            setActiveTab('tree');
            setSearchOpen((prev) => !prev);
            if (searchOpen) setSearchQuery('');
          }}
          style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <Icons.search size={14} />
        </button>
        <button
          title="导入 Markdown"
          onClick={handleOpenImportDialog}
          style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <Icons.upload size={14} />
        </button>
        <button
          title="导出 Markdown"
          onClick={handleOpenExportDialog}
          style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <Icons.download size={14} />
        </button>
        <button
          title="新建文件"
          onClick={() => {
            setCreateMode('file');
            setParentPath(extractParentPath(activeFile?.path));
            setActiveTab('tree');
          }}
          style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <Icons.filePlus size={14} />
        </button>
        <button
          title="新建文件夹"
          onClick={() => {
            setCreateMode('folder');
            setParentPath(extractParentPath(activeFile?.path));
            setActiveTab('tree');
          }}
          style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', borderRadius: 'var(--radius-sm)' }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
        >
          <Icons.folderPlus size={14} />
        </button>
      </div>

      {activeTab === 'tree' && searchOpen && (
        <div style={{ padding: '8px 10px 6px', borderBottom: '1px solid var(--border-subtle)' }}>
          <SearchInput
            value={searchQuery}
            placeholder="搜索标题或路径"
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', paddingTop: 6 }}>
        {activeTab === 'toc' ? (
          <div style={{ padding: '4px 0' }}>
            {!tocItems || tocItems.length === 0 ? (
              <div style={{ padding: '8px 20px', textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                当前文档没有标题
              </div>
            ) : tocItems.map((t, i) => {
              const pad = 12 + t.level * 14;
              return (
                <div
                  key={i}
                  onClick={() => t.onJump?.()}
                  style={{
                    height: 28,
                    display: 'flex',
                    alignItems: 'center',
                    padding: `0 10px 0 ${pad}px`,
                    fontSize: 'var(--text-sm)',
                    color: t.active ? 'var(--accent)' : 'var(--text-secondary)',
                    fontWeight: t.active ? 500 : 400,
                    position: 'relative',
                    cursor: 'pointer',
                    transition: 'color var(--transition-fast)',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.color = 'var(--text-primary)'}
                  onMouseLeave={(e) => e.currentTarget.style.color = t.active ? 'var(--accent)' : 'var(--text-secondary)'}
                >
                  {t.active && (
                    <div style={{ position: 'absolute', left: 6, top: 6, bottom: 6, width: 2, background: 'var(--accent)', borderRadius: 1 }} />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.text}
                  </span>
                </div>
              );
            })}
          </div>
        ) : loadingFiles && !hasLoadedFilesOnce && files.length === 0 ? (
          <div style={{ padding: '20px 16px', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
            正在读取文件树…
          </div>
        ) : flat.length === 0 ? (
          <div style={{ padding: '48px 20px 0', textAlign: 'center' }}>
            {searchQuery.trim() ? (
              <>
                <div style={{ color: 'var(--text-tertiary)', opacity: 0.4, display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                  <Icons.search size={40} />
                </div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 4 }}>没有找到匹配的文章</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                  试试换个关键词，或者新建一篇文章
                </div>
              </>
            ) : (
              <>
                <div style={{ color: 'var(--text-tertiary)', opacity: 0.4, display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                  <Icons.folder size={40} />
                </div>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 4 }}>还没有笔记</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 14 }}>
                  导入 Markdown 文件开始使用
                </div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
                  <Button variant="secondary" size="sm" onClick={handleOpenImportDialog}>导入文件</Button>
                  <Button variant="ghost" size="sm" onClick={() => setCreateMode('file')}>新建文件</Button>
                </div>
              </>
            )}
          </div>
        ) : (
          flat.map((n) => (
            <FileRow
              key={n.path}
              item={n}
              isActive={n.type === 'file' && n.id === activeFileId}
              onSelect={handleSelectFile}
              onToggle={toggleFolder}
            />
          ))
        )}
      </div>
    </div>
  );
};
