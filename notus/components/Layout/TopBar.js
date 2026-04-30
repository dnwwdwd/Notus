// TopBar — fixed 48px header with tabs + settings
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useApp } from '../../contexts/AppContext';
import { useShortcuts } from '../../contexts/ShortcutsContext';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { SearchInput } from '../ui/Input';
import { NotusLogo, Icons } from '../ui/Icons';
import { Spinner } from '../ui/Spinner';
import { navigateWithFallback } from '../../utils/navigation';

export const TopBar = ({
  active,
  fileName,
  saveState,
  onSave,
  saveDisabled,
  showSaveButton = true,
  showIndex,
  showCmdK = true,
  onCmdK,
  requestAction,
}) => {
  const router = useRouter();
  const { activePage, allFiles, selectFile } = useApp();
  const { shortcuts, matchShortcut } = useShortcuts();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const tabs = [
    { id: 'files', label: '文件', href: '/files' },
    { id: 'knowledge', label: '知识库', href: '/knowledge' },
    { id: 'canvas', label: '创作', href: '/canvas' },
  ];
  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    return allFiles
      .filter((file) => (
        file.path.toLowerCase().includes(keyword) ||
        file.name.toLowerCase().includes(keyword)
      ))
      .slice(0, 12);
  }, [allFiles, query]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    onCmdK?.();
  }, [onCmdK]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
  }, []);

  const prefetchRoute = useCallback((href) => {
    if (!href || typeof router.prefetch !== 'function') return;
    router.prefetch(href).catch(() => {});
  }, [router]);

  const runAction = useCallback((action) => {
    if (typeof action !== 'function') return;
    if (requestAction) {
      requestAction(action);
      return;
    }
    action();
  }, [requestAction]);

  const resolveTargetPage = useCallback(() => {
    if (['files', 'knowledge', 'canvas'].includes(active)) return active;
    if (['files', 'knowledge', 'canvas'].includes(activePage)) return activePage;
    return 'files';
  }, [active, activePage]);

  const handlePickFile = useCallback((file) => {
    runAction(() => {
      closeSearch();
      const targetPage = resolveTargetPage();
      selectFile(file);
      const href = `/${targetPage}?fileId=${encodeURIComponent(file.id)}`;
      if (router.pathname !== `/${targetPage}`) {
        navigateWithFallback(router, href);
        return;
      }
      if (router.asPath !== href && targetPage === 'files') {
        navigateWithFallback(router, href, { mode: 'router' });
      }
    });
  }, [closeSearch, resolveTargetPage, router, runAction, selectFile]);

  useEffect(() => {
    const handleKeydown = (event) => {
      if (matchShortcut(event, shortcuts.globalSearch.combo)) {
        event.preventDefault();
        openSearch();
      }
    };

    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [matchShortcut, openSearch, shortcuts.globalSearch.combo]);

  return (
    <>
      <Dialog open={searchOpen} onClose={closeSearch} title="搜索文章" maxWidth={640}>
        <div style={{ display: 'grid', gap: 14 }}>
          <SearchInput
            value={query}
            placeholder="输入标题或路径"
            onChange={(event) => setQuery(event.target.value)}
            style={{ height: 40 }}
          />
          <div style={{ maxHeight: 360, overflow: 'auto', display: 'grid', gap: 6 }}>
            {!query.trim() ? (
              <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                输入标题或路径后再开始搜索
              </div>
            ) : results.length === 0 ? (
              <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                没有找到匹配的文章
              </div>
            ) : (
              results.map((file) => (
                <button
                  key={file.id}
                  onClick={() => handlePickFile(file)}
                  style={{
                    padding: '10px 12px',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-elevated)',
                    textAlign: 'left',
                    display: 'grid',
                    gap: 4,
                  }}
                >
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{file.name}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>{file.path}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </Dialog>

      <div style={{
        position: 'sticky',
        top: 0,
        height: 48,
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 24,
        flexShrink: 0,
        isolation: 'isolate',
        zIndex: 120,
      }}>
        {/* Logo */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 140, cursor: 'pointer' }}
          onMouseEnter={() => prefetchRoute('/files')}
          onClick={() => runAction(() => navigateWithFallback(router, '/files'))}
        >
          <NotusLogo size={22} />
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 600, letterSpacing: -0.2 }}>Notus</span>
        </div>

        {/* Nav Tabs */}
        <div style={{ display: 'flex', gap: 4, flex: 1 }}>
          {tabs.map((t) => {
            const on = t.id === active;
            return (
              <button
                type="button"
                key={t.id}
                onMouseEnter={() => prefetchRoute(t.href)}
                onFocus={() => prefetchRoute(t.href)}
                onClick={() => runAction(() => navigateWithFallback(router, t.href))}
                style={{
                  position: 'relative',
                  padding: '0 14px',
                  height: 48,
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 'var(--text-sm)',
                  fontWeight: on ? 500 : 400,
                  color: on ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'color var(--transition-fast)',
                }}
              >
                {t.label}
                {on && (
                  <div style={{
                    position: 'absolute',
                    left: 14,
                    right: 14,
                    bottom: 0,
                    height: 2,
                    background: 'var(--accent)',
                    borderRadius: '2px 2px 0 0',
                  }} />
                )}
              </button>
            );
          })}
        </div>

        {/* File name + save state */}
        {fileName && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
            <span>{fileName}</span>
            {saveState === 'dirty' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--warning)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)' }} />
                未保存
              </span>
            )}
            {saveState === 'saving' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)' }}>
                <Spinner size={10} />
                保存中
              </span>
            )}
            {saveState === 'saved' && <span style={{ color: 'var(--success)' }}>✓ 已保存</span>}
          </div>
        )}

        {fileName && onSave && showSaveButton && (
          <Button
            variant={saveState === 'dirty' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => { void onSave?.(); }}
            disabled={saveDisabled}
            loading={saveState === 'saving'}
            icon={<Icons.check size={14} />}
            title={`保存当前文档（${shortcuts.docSave.combo}）`}
          >
            保存
          </Button>
        )}

        {/* ⌘K search */}
        {showCmdK && (
          <button
            type="button"
            onClick={openSearch}
            style={{
              height: 28,
              padding: '0 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-tertiary)',
              fontSize: 12,
            }}
          >
            <Icons.search size={13} />
            <span>搜索或跳转…</span>
          </button>
        )}

        {/* Settings button */}
        <button
          type="button"
          onMouseEnter={() => prefetchRoute('/settings/model')}
          onFocus={() => prefetchRoute('/settings/model')}
          onClick={() => runAction(() => navigateWithFallback(router, '/settings/model'))}
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            transition: 'color var(--transition-fast)',
          }}
        >
          <Icons.settings size={18} />
        </button>

        {/* Indexing progress indicator */}
        {showIndex && (
          <div style={{
            position: 'absolute',
            left: 0,
            bottom: -1,
            height: 2,
            width: '42%',
            background: 'var(--accent)',
            transition: 'width var(--transition-normal)',
          }} />
        )}
      </div>
    </>
  );
};
