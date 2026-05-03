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
import { Tooltip } from '../ui/Tooltip';
import { navigateWithFallback } from '../../utils/navigation';
import { desktop as desktopClient } from '../../utils/platformClient';

const HEADER_BREAKPOINTS = {
  compact: 960,
  iconOnly: 720,
};

function useHeaderWidthMode() {
  const [width, setWidth] = useState(null);

  useEffect(() => {
    const updateWidth = () => setWidth(window.innerWidth);
    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  return {
    compact: width !== null && width < HEADER_BREAKPOINTS.compact,
    iconOnly: width !== null && width < HEADER_BREAKPOINTS.iconOnly,
  };
}

const HeaderIconButton = ({
  label,
  tooltip,
  active,
  disabled,
  loading,
  children,
  onClick,
  onMouseEnter,
  onFocus,
  style,
}) => {
  const baseBackground = style?.background || (active ? 'var(--accent-subtle)' : 'transparent');

  return (
    <Tooltip content={tooltip || label} placement="bottom" gap={6}>
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled || loading}
        onClick={onClick}
        onFocus={onFocus}
        style={{
          width: 32,
          height: 32,
          boxSizing: 'border-box',
          borderRadius: 'var(--radius-sm)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: active ? 'var(--accent)' : disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
          background: active ? 'var(--accent-subtle)' : 'transparent',
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          transition: 'background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast)',
          flexShrink: 0,
          touchAction: 'manipulation',
          ...style,
        }}
        onMouseEnter={(event) => {
          if (!disabled && !loading) {
            event.currentTarget.style.background = active || style?.background ? baseBackground : 'var(--bg-hover)';
          }
          onMouseEnter?.(event);
        }}
        onMouseDown={(event) => {
          event.currentTarget.style.transform = 'scale(0.96)';
        }}
        onMouseUp={(event) => {
          event.currentTarget.style.transform = 'scale(1)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.transform = 'scale(1)';
          event.currentTarget.style.background = baseBackground;
        }}
        onPointerCancel={(event) => {
          event.currentTarget.style.transform = 'scale(1)';
        }}
      >
        {loading ? <Spinner size={13} /> : children}
      </button>
    </Tooltip>
  );
};

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
  const { shortcuts, matchShortcut, displayShortcut } = useShortcuts();
  const { compact, iconOnly } = useHeaderWidthMode();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const tabs = [
    { id: 'files', label: '文件', shortLabel: '文件', href: '/files', icon: <Icons.file size={15} /> },
    { id: 'knowledge', label: '知识库', shortLabel: '知识', href: '/knowledge', icon: <Icons.brain size={15} /> },
    { id: 'canvas', label: '创作', shortLabel: '创作', href: '/canvas', icon: <Icons.sparkles size={15} /> },
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

  const saveLabel = saveState === 'saving'
    ? '保存中'
    : saveState === 'dirty'
      ? '未保存'
      : '已保存';
  const saveTooltip = saveState === 'saving'
    ? '正在保存当前文档'
    : saveState === 'dirty'
      ? `未保存，点击保存（${displayShortcut(shortcuts.docSave.combo)}）`
      : '当前文档已保存';
  const saveButtonDisabled = saveDisabled || saveState === 'saved';
  const dirtySaveOutline = 'color-mix(in srgb, var(--danger) 42%, var(--border-primary))';

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

  useEffect(() => {
    return desktopClient.onOpenGlobalSearch(() => {
      openSearch();
    });
  }, [openSearch]);

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
        padding: iconOnly ? '0 8px' : compact ? '0 10px' : '0 16px',
        gap: iconOnly ? 6 : compact ? 10 : 24,
        flexShrink: 0,
        isolation: 'isolate',
        zIndex: 120,
      }}>
        {/* Logo */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: iconOnly ? 30 : compact ? 88 : 140,
            cursor: 'pointer',
            flexShrink: 0,
          }}
          onMouseEnter={() => prefetchRoute('/files')}
          onClick={() => runAction(() => navigateWithFallback(router, '/files'))}
        >
          <NotusLogo size={22} />
          {!iconOnly && <span style={{ fontSize: 'var(--text-base)', fontWeight: 600, letterSpacing: -0.2 }}>Notus</span>}
        </div>

        {/* Nav Tabs */}
        <div style={{ display: 'flex', gap: iconOnly ? 2 : 4, flex: '1 1 auto', minWidth: 0 }}>
          {tabs.map((t) => {
            const on = t.id === active;
            const tabButton = (
              <button
                type="button"
                key={t.id}
                aria-label={t.label}
                title={t.label}
                onMouseEnter={() => prefetchRoute(t.href)}
                onFocus={() => prefetchRoute(t.href)}
                onClick={() => runAction(() => navigateWithFallback(router, t.href))}
                style={{
                  position: 'relative',
                  padding: iconOnly ? '0 8px' : compact ? '0 10px' : '0 14px',
                  height: 48,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: compact ? 6 : 0,
                  fontSize: 'var(--text-sm)',
                  fontWeight: on ? 500 : 400,
                  color: on ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'color var(--transition-fast), background var(--transition-fast)',
                  borderRadius: iconOnly ? 'var(--radius-sm)' : 0,
                  minWidth: iconOnly ? 32 : 'auto',
                  flexShrink: 0,
                }}
              >
                {compact && <span style={{ display: 'inline-flex' }}>{t.icon}</span>}
                {!iconOnly && <span>{compact ? t.shortLabel : t.label}</span>}
                {on && (
                  <div style={{
                    position: 'absolute',
                    left: iconOnly ? 8 : compact ? 10 : 14,
                    right: iconOnly ? 8 : compact ? 10 : 14,
                    bottom: 0,
                    height: 2,
                    background: 'var(--accent)',
                    borderRadius: '2px 2px 0 0',
                  }} />
                )}
              </button>
            );
            return iconOnly ? (
              <Tooltip key={t.id} content={t.label} placement="bottom" gap={6}>{tabButton}</Tooltip>
            ) : tabButton;
          })}
        </div>

        {/* Save state + action */}
        {fileName && onSave && showSaveButton && (
          compact ? (
            <HeaderIconButton
              label={saveLabel}
              tooltip={saveTooltip}
              active={saveState === 'dirty'}
              disabled={saveButtonDisabled}
              loading={saveState === 'saving'}
              onClick={() => { void onSave?.(); }}
              style={{
                background: saveState === 'dirty' ? 'color-mix(in srgb, var(--danger) 10%, var(--bg-elevated))' : saveState === 'saved' ? 'var(--accent-subtle)' : 'var(--bg-secondary)',
                color: saveState === 'dirty' ? 'var(--danger)' : saveState === 'saved' ? 'var(--success)' : 'var(--text-secondary)',
                border: saveState === 'dirty' ? `1px solid ${dirtySaveOutline}` : '1px solid transparent',
                opacity: 1,
              }}
            >
              {saveState === 'dirty' ? <Icons.download size={14} /> : <Icons.check size={14} />}
            </HeaderIconButton>
          ) : (
            <Tooltip content={saveTooltip} placement="bottom" gap={6}>
              <span style={{ display: 'inline-flex', flexShrink: 0 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { void onSave?.(); }}
                  disabled={saveButtonDisabled}
                  loading={saveState === 'saving'}
                  icon={saveState === 'dirty' ? <Icons.download size={14} /> : <Icons.check size={14} />}
                  title={saveTooltip}
                  style={{
                    opacity: 1,
                    background: saveState === 'dirty' ? 'color-mix(in srgb, var(--danger) 8%, var(--bg-elevated))' : undefined,
                    color: saveState === 'dirty' ? 'var(--danger)' : saveState === 'saved' ? 'var(--success)' : undefined,
                    borderColor: saveState === 'dirty' ? dirtySaveOutline : saveState === 'saved' ? 'color-mix(in srgb, var(--success) 30%, var(--border-primary))' : undefined,
                  }}
                >
                  {saveLabel}
                </Button>
              </span>
            </Tooltip>
          )
        )}

        {/* ⌘K search */}
        {showCmdK && (
          iconOnly ? (
            <HeaderIconButton label="搜索或跳转" tooltip={`搜索或跳转（${displayShortcut(shortcuts.globalSearch.combo)}）`} onClick={openSearch}>
              <Icons.search size={14} />
            </HeaderIconButton>
          ) : (
            <Tooltip content={`搜索或跳转（${displayShortcut(shortcuts.globalSearch.combo)}）`} placement="bottom" gap={6}>
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
                  flexShrink: 0,
                }}
              >
                <Icons.search size={13} />
                <span>{compact ? displayShortcut(shortcuts.globalSearch.combo) : '搜索或跳转…'}</span>
              </button>
            </Tooltip>
          )
        )}

        {/* Settings button */}
        <HeaderIconButton
          label="设置"
          tooltip="设置"
          onMouseEnter={() => prefetchRoute('/settings/model')}
          onFocus={() => prefetchRoute('/settings/model')}
          onClick={() => runAction(() => navigateWithFallback(router, '/settings/model'))}
        >
          <Icons.settings size={18} />
        </HeaderIconButton>

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
