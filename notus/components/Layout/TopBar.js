// TopBar — fixed 48px header with tabs + settings
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { getVisibleDocumentLabel } from '../../lib/documentLabels';
import { useSettingsDialog } from '../../contexts/SettingsDialogContext';

const HEADER_BREAKPOINTS = {
  compact: 960,
  iconOnly: 720,
};
const HEADER_ICON_SIZE = 32;

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
  selectedIcon = false,
  disabled,
  loading,
  children,
  onClick,
  onMouseEnter,
  onFocus,
  style,
}) => {
  const baseBackground = selectedIcon ? 'transparent' : (style?.background || (active ? 'var(--accent-subtle)' : 'transparent'));

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
          width: HEADER_ICON_SIZE,
          height: HEADER_ICON_SIZE,
          boxSizing: 'border-box',
          borderRadius: 'var(--radius-sm)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: active ? 'var(--accent)' : disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
          background: selectedIcon ? 'transparent' : active ? 'var(--accent-subtle)' : 'transparent',
          border: selectedIcon ? 'none' : undefined,
          boxShadow: selectedIcon ? 'none' : undefined,
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          transition: 'background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast)',
          flexShrink: 0,
          touchAction: 'manipulation',
          ...style,
        }}
        onMouseEnter={(event) => {
          if (!disabled && !loading) {
            event.currentTarget.style.background = selectedIcon || active || style?.background ? baseBackground : 'var(--bg-hover)';
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
  fileName,
  saveState,
  onSave,
  saveDisabled,
  showSaveButton = true,
  showIndex,
  showCmdK = true,
  showSettingsButton = true,
  onCmdK,
  requestAction,
  editorOpen,
  agentOpen,
  onToggleEditor,
  onToggleAgent,
}) => {
  const router = useRouter();
  const { openSettings } = useSettingsDialog();
  const { allFiles, selectFile } = useApp();
  const { shortcuts, matchShortcut, displayShortcut } = useShortcuts();
  const { compact, iconOnly } = useHeaderWidthMode();
  const searchInputRef = useRef(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];
    return allFiles
      .filter((file) => (
        file.path.toLowerCase().includes(keyword) ||
        String(file.title || '').toLowerCase().includes(keyword) ||
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

  useEffect(() => {
    if (!searchOpen) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [searchOpen]);

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

  const handlePickFile = useCallback((file) => {
    closeSearch();
    const action = () => {
      selectFile(file);
      const href = `/files?fileId=${encodeURIComponent(file.id)}`;
      if (router.pathname !== '/files') {
        navigateWithFallback(router, href);
        return;
      }
      if (router.asPath !== href) {
        navigateWithFallback(router, href, { mode: 'router' });
      }
    };
    if (requestAction && requestAction.length >= 2) {
      requestAction(file, action);
      return;
    }
    runAction(action);
  }, [closeSearch, requestAction, router, runAction, selectFile]);

  useEffect(() => {
    const handleKeydown = (event) => {
      if (matchShortcut(event, shortcuts.globalSearch.combo)) {
        event.preventDefault();
        openSearch();
        return;
      }

      if (typeof onToggleEditor === 'function' && matchShortcut(event, shortcuts.editorToggle.combo)) {
        event.preventDefault();
        onToggleEditor();
        return;
      }

      if (typeof onToggleAgent === 'function' && matchShortcut(event, shortcuts.agentToggle.combo)) {
        event.preventDefault();
        onToggleAgent();
      }
    };

    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [
    matchShortcut,
    onToggleAgent,
    onToggleEditor,
    openSearch,
    shortcuts.agentToggle.combo,
    shortcuts.editorToggle.combo,
    shortcuts.globalSearch.combo,
  ]);

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
            ref={searchInputRef}
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
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text-primary)' }}>{getVisibleDocumentLabel(file, '未命名文档')}</span>
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

        <div style={{ flex: '1 1 auto', minWidth: 0 }} />

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
          <HeaderIconButton
            label="搜索文件"
            tooltip="搜索文件"
            onClick={openSearch}
          >
            <Icons.search size={16} />
          </HeaderIconButton>
        )}

        {typeof onToggleEditor === 'function' && (
          <HeaderIconButton
            label={editorOpen ? '收起富文本编辑器' : '展开富文本编辑器'}
            tooltip={`${editorOpen ? '收起富文本编辑器' : '展开富文本编辑器'}（${displayShortcut(shortcuts.editorToggle.combo)}）`}
            active={Boolean(editorOpen)}
            selectedIcon
            onClick={onToggleEditor}
          >
            <EditorPanelIcon active={Boolean(editorOpen)} />
          </HeaderIconButton>
        )}

        {typeof onToggleAgent === 'function' && (
          <HeaderIconButton
            label={agentOpen ? '收起 AI 聊天面板' : '展开 AI 聊天面板'}
            tooltip={`${agentOpen ? '收起 AI 聊天面板' : '展开 AI 聊天面板'}（${displayShortcut(shortcuts.agentToggle.combo)}）`}
            active={Boolean(agentOpen)}
            selectedIcon
            onClick={onToggleAgent}
          >
            <AgentPanelIcon active={Boolean(agentOpen)} />
          </HeaderIconButton>
        )}

        {/* Settings button */}
        {showSettingsButton ? (
          <HeaderIconButton
            label="设置"
            tooltip="设置"
            onClick={() => runAction(() => openSettings('model'))}
          >
            <Icons.settings size={18} />
          </HeaderIconButton>
        ) : null}

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

const EditorPanelIcon = ({ active }) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.12 : 0} />
    <path d="M12 4v16" />
    <path d="M7 8h2M7 12h2M7 16h2M15 8h3M15 12h3M15 16h3" strokeWidth={active ? 2 : 1.5} />
  </svg>
);

const AgentPanelIcon = ({ active }) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 5.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.8 3v-3H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" fill={active ? 'currentColor' : 'none'} fillOpacity={active ? 0.12 : 0} />
    <path d="M8 10h.01M12 10h.01M16 10h.01" strokeWidth={active ? 2.6 : 2.2} />
    <path d="M8 14h8" strokeWidth={active ? 2 : 1.5} />
  </svg>
);
