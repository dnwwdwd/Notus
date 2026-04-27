import { useCallback, useEffect, useMemo, useState } from 'react';

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function clearHighlights(root) {
  if (!root) return;
  root.querySelectorAll('[data-find-match="true"]').forEach((element) => {
    element.removeAttribute('data-find-match');
    element.removeAttribute('data-find-current');
  });
}

export function useDocumentFind({
  enabled = true,
  getRoot,
  selector,
  contentVersion,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [results, setResults] = useState([]);

  const refreshResults = useCallback((nextQuery) => {
    const root = getRoot?.();
    if (!root) {
      setResults([]);
      setCurrentIndex(0);
      return [];
    }

    clearHighlights(root);
    const keyword = normalizeText(nextQuery);
    if (!keyword) {
      setResults([]);
      setCurrentIndex(0);
      return [];
    }

    const matches = [...root.querySelectorAll(selector)].filter((element) => normalizeText(element.textContent).includes(keyword));
    matches.forEach((element) => {
      element.setAttribute('data-find-match', 'true');
    });
    if (matches[0]) {
      matches[0].setAttribute('data-find-current', 'true');
    }
    setResults(matches);
    setCurrentIndex(0);
    return matches;
  }, [getRoot, selector]);

  const focusMatch = useCallback((index) => {
    const root = getRoot?.();
    if (!root) return;
    if (results.length === 0) {
      clearHighlights(root);
      return;
    }

    const nextIndex = ((index % results.length) + results.length) % results.length;
    results.forEach((element, itemIndex) => {
      element.setAttribute('data-find-match', 'true');
      if (itemIndex === nextIndex) {
        element.setAttribute('data-find-current', 'true');
      } else {
        element.removeAttribute('data-find-current');
      }
    });
    const current = results[nextIndex];
    current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setCurrentIndex(nextIndex);
  }, [getRoot, results]);

  const close = useCallback(() => {
    const root = getRoot?.();
    if (root) clearHighlights(root);
    setOpen(false);
    setQuery('');
    setResults([]);
    setCurrentIndex(0);
  }, [getRoot]);

  const openFind = useCallback(() => {
    if (!enabled) return;
    setOpen(true);
  }, [enabled]);

  const next = useCallback(() => {
    if (results.length === 0) return;
    focusMatch(currentIndex + 1);
  }, [currentIndex, focusMatch, results.length]);

  const prev = useCallback(() => {
    if (results.length === 0) return;
    focusMatch(currentIndex - 1);
  }, [currentIndex, focusMatch, results.length]);

  useEffect(() => {
    if (!enabled) {
      close();
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'f') {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          close();
        } else if (open && event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) prev();
          else next();
        }
        return;
      }

      event.preventDefault();
      openFind();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [close, enabled, next, open, openFind, prev]);

  useEffect(() => {
    if (!open) return undefined;
    const frameId = window.requestAnimationFrame(() => {
      refreshResults(query);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [contentVersion, open, query, refreshResults]);

  useEffect(() => () => {
    const root = getRoot?.();
    if (root) clearHighlights(root);
  }, [getRoot]);

  const api = useMemo(() => ({
    open,
    query,
    currentIndex,
    total: results.length,
    setQuery(value) {
      setQuery(value);
      refreshResults(value);
    },
    next,
    prev,
    close,
    openFind,
  }), [close, currentIndex, next, open, openFind, prev, refreshResults, results.length, query]);

  return api;
}
