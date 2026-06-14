import { useCallback, useEffect, useMemo, useState } from 'react';
import { getEditorRoot, getEditorScrollContainer, normalizeText } from '../utils/documentNavigation';

const TOC_HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';

function collectHeadingItems(editor) {
  if (!editor?.state?.doc) return [];

  const headings = [];
  editor.state.doc.descendants((node) => {
    if (node.type?.name !== 'heading') return true;
    headings.push({
      level: Math.max((Number(node.attrs?.level) || 1) - 1, 0),
      text: normalizeText(node.textContent),
    });
    return true;
  });

  return headings.filter((item) => item.text);
}

function getVisibleEditorContext(editor) {
  const editorRoot = getEditorRoot(editor);
  if (
    editorRoot?.isConnected
    && editorRoot.getClientRects().length > 0
  ) {
    return {
      root: editorRoot,
      container: editorRoot.closest('.wysiwyg-root'),
    };
  }

  if (typeof document !== 'undefined') {
    const root = [...document.querySelectorAll('.wysiwyg-root .tiptap.ProseMirror')]
      .find((candidate) => candidate.getClientRects().length > 0);
    if (root) {
      return {
        root,
        container: root.closest('.wysiwyg-root'),
      };
    }
  }

  return {
    root: editorRoot,
    container: getEditorScrollContainer(editor),
  };
}

export function useEditorToc({ editor, contentVersion }) {
  const [headings, setHeadings] = useState([]);
  const [activeHeadingIndex, setActiveHeadingIndex] = useState(-1);

  const syncHeadings = useCallback(() => {
    if (!editor) {
      setHeadings([]);
      setActiveHeadingIndex(-1);
      return;
    }
    setHeadings(collectHeadingItems(editor));
  }, [editor]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncHeadings);
    return () => window.cancelAnimationFrame(frameId);
  }, [contentVersion, syncHeadings]);

  useEffect(() => {
    if (!editor) return undefined;
    const { container, root } = getVisibleEditorContext(editor);
    if (!container || !root) return undefined;

    const syncActiveHeading = () => {
      const { root: nextRoot } = getVisibleEditorContext(editor);
      const nodes = nextRoot ? [...nextRoot.querySelectorAll(TOC_HEADING_SELECTOR)] : [];
      if (nodes.length === 0) {
        setActiveHeadingIndex(-1);
        return;
      }

      const threshold = container.scrollTop + 96;
      let nextIndex = 0;
      nodes.forEach((heading, index) => {
        if (heading.offsetTop <= threshold) nextIndex = index;
      });
      setActiveHeadingIndex(nextIndex);
    };

    syncActiveHeading();
    container.addEventListener('scroll', syncActiveHeading, { passive: true });
    window.addEventListener('resize', syncActiveHeading);
    return () => {
      container.removeEventListener('scroll', syncActiveHeading);
      window.removeEventListener('resize', syncActiveHeading);
    };
  }, [editor, headings]);

  const jumpToHeading = useCallback((index) => {
    if (!editor) return;
    const { container, root } = getVisibleEditorContext(editor);
    const nodes = root ? [...root.querySelectorAll(TOC_HEADING_SELECTOR)] : [];
    const target = nodes[index];
    if (!container || !target) return;
    setActiveHeadingIndex(index);
    container.scrollTop = Math.max(target.offsetTop - 48, 0);
  }, [editor]);

  return useMemo(
    () => headings.map((item, index) => ({
      ...item,
      active: index === activeHeadingIndex,
      onJump: () => jumpToHeading(index),
    })),
    [activeHeadingIndex, headings, jumpToHeading]
  );
}
