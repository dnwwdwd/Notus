import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'notus-shortcuts';

export const DEFAULT_SHORTCUTS = {
  globalSearch: {
    id: 'globalSearch',
    label: '全局搜索',
    scope: '全局',
    description: '打开文章搜索弹窗',
    combo: 'Mod+K',
  },
  sidebarToggle: {
    id: 'sidebarToggle',
    label: '收起侧栏',
    scope: '全局',
    description: '收起或展开左侧文件树',
    combo: 'Mod+\\',
  },
  chatSend: {
    id: 'chatSend',
    label: '发送消息',
    scope: '输入框',
    description: '发送知识库提问或创作指令',
    combo: 'Mod+Enter',
  },
  docSave: {
    id: 'docSave',
    label: '保存文章',
    scope: '文章编辑器',
    description: '立即保存当前 Markdown 文档',
    combo: 'Mod+S',
  },
  blockSave: {
    id: 'blockSave',
    label: '保存块编辑',
    scope: '创作块编辑',
    description: '保存当前块内容',
    combo: 'Mod+Enter',
  },
  blockCancel: {
    id: 'blockCancel',
    label: '取消块编辑',
    scope: '创作块编辑',
    description: '退出当前块编辑',
    combo: 'Escape',
  },
};

const ShortcutsContext = createContext(null);

const MODIFIER_LABELS = {
  mod: 'Mod',
  shift: 'Shift',
  alt: 'Alt',
};

const SPECIAL_KEYS = {
  escape: 'Escape',
  esc: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  ' ': 'Space',
  tab: 'Tab',
};

function normalizeKeyName(rawKey) {
  const key = String(rawKey || '').trim().toLowerCase();
  if (!key) return '';
  if (SPECIAL_KEYS[key]) return SPECIAL_KEYS[key];
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function normalizeShortcut(shortcut) {
  const parts = String(shortcut || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return '';

  const modifierSet = new Set();
  let key = '';

  parts.forEach((part) => {
    const token = part.toLowerCase();
    if (['mod', 'cmd', 'command', 'meta', 'ctrl', 'control'].includes(token)) {
      modifierSet.add('mod');
      return;
    }
    if (token === 'shift') {
      modifierSet.add('shift');
      return;
    }
    if (['alt', 'option'].includes(token)) {
      modifierSet.add('alt');
      return;
    }
    key = normalizeKeyName(part);
  });

  if (!key) return '';

  return [
    modifierSet.has('mod') ? MODIFIER_LABELS.mod : null,
    modifierSet.has('shift') ? MODIFIER_LABELS.shift : null,
    modifierSet.has('alt') ? MODIFIER_LABELS.alt : null,
    key,
  ].filter(Boolean).join('+');
}

function getEventKey(event) {
  if (!event?.key) return '';
  return normalizeKeyName(event.key);
}

export function matchShortcut(event, shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return false;

  const parts = normalized.split('+');
  const key = parts[parts.length - 1];
  const needsMod = parts.includes('Mod');
  const needsShift = parts.includes('Shift');
  const needsAlt = parts.includes('Alt');

  const eventKey = getEventKey(event);
  const hasMod = Boolean(event.metaKey || event.ctrlKey);

  if (eventKey !== key) return false;
  if (hasMod !== needsMod) return false;
  if (Boolean(event.shiftKey) !== needsShift) return false;
  if (Boolean(event.altKey) !== needsAlt) return false;

  return true;
}

export function toTiptapShortcut(shortcut) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return '';
  return normalized
    .split('+')
    .map((part, index, arr) => {
      if (index === arr.length - 1 && part.length === 1) return part.toLowerCase();
      return part;
    })
    .join('-');
}

function mergeShortcuts(saved = {}) {
  return Object.fromEntries(
    Object.entries(DEFAULT_SHORTCUTS).map(([id, item]) => [
      id,
      {
        ...item,
        combo: normalizeShortcut(saved[id]?.combo || item.combo),
      },
    ])
  );
}

export function ShortcutsProvider({ children }) {
  const [shortcuts, setShortcuts] = useState(DEFAULT_SHORTCUTS);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      setShortcuts(mergeShortcuts(JSON.parse(raw)));
    } catch (error) {
      setShortcuts(DEFAULT_SHORTCUTS);
    }
  }, []);

  const persist = useCallback((nextShortcuts) => {
    setShortcuts(nextShortcuts);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextShortcuts));
    }
  }, []);

  const updateShortcut = useCallback((id, combo) => {
    const normalized = normalizeShortcut(combo) || DEFAULT_SHORTCUTS[id]?.combo || '';
    persist({
      ...shortcuts,
      [id]: {
        ...shortcuts[id],
        combo: normalized,
      },
    });
  }, [persist, shortcuts]);

  const resetShortcuts = useCallback(() => {
    persist(DEFAULT_SHORTCUTS);
  }, [persist]);

  const shortcutList = useMemo(
    () => Object.values(shortcuts),
    [shortcuts]
  );

  const value = useMemo(() => ({
    shortcuts,
    shortcutList,
    updateShortcut,
    resetShortcuts,
    normalizeShortcut,
    matchShortcut,
    toTiptapShortcut,
  }), [resetShortcuts, shortcutList, shortcuts, updateShortcut]);

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
    </ShortcutsContext.Provider>
  );
}

export function useShortcuts() {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) throw new Error('useShortcuts must be used within ShortcutsProvider');
  return ctx;
}
