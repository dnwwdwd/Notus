// CodeMirror 6 editor — Typora-style markdown editor
// Exposes formatting methods via forwardRef so EditorToolbar can call them directly
import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';

const notusTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--text-lg)',
    fontFamily: 'var(--font-editor)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
  },
  '.cm-content': {
    padding: '48px 60px 80px',
    maxWidth: 780,
    margin: '0 auto',
    lineHeight: 1.8,
    caretColor: 'var(--accent)',
  },
  '.cm-focused': { outline: 'none' },
  '.cm-editor.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-editor)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground': { background: 'var(--accent-subtle) !important' },
  '&.cm-focused .cm-selectionBackground': { background: 'var(--accent-subtle) !important' },
  '.cm-activeLine': { background: 'transparent' },
  '.cm-gutters': { display: 'none' },
}, { dark: false });

export const CodeMirrorEditor = forwardRef(function CodeMirrorEditor({ value, onChange, onSave }, ref) {
  const containerRef = useRef(null);
  const viewRef = useRef(null);

  const handleSave = useCallback(() => { onSave?.(); }, [onSave]);

  // Expose formatting API to parent via ref
  useImperativeHandle(ref, () => ({
    wrapSelection(before, after) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      view.dispatch({
        changes: { from, to, insert: before + selected + after },
        selection: { anchor: from + before.length, head: from + before.length + selected.length },
      });
      view.focus();
    },
    insertAtLineStart(prefix) {
      const view = viewRef.current;
      if (!view) return;
      const { from } = view.state.selection.main;
      const line = view.state.doc.lineAt(from);
      const lineText = view.state.sliceDoc(line.from, line.to);
      // Toggle: remove if already present
      if (lineText.startsWith(prefix)) {
        view.dispatch({ changes: { from: line.from, to: line.from + prefix.length, insert: '' } });
      } else {
        view.dispatch({ changes: { from: line.from, to: line.from, insert: prefix } });
      }
      view.focus();
    },
    insertText(text) {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
    undo() {
      const view = viewRef.current;
      if (!view) return;
      undo(view);
      view.focus();
    },
    redo() {
      const view = viewRef.current;
      if (!view) return;
      redo(view);
      view.focus();
    },
    focus() {
      viewRef.current?.focus();
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current) return;

    const saveKeymap = keymap.of([{
      key: 'Mod-s',
      run: () => { handleSave(); return true; },
    }]);

    const state = EditorState.create({
      doc: value || '',
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        indentOnInput(),
        bracketMatching(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        saveKeymap,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        notusTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChange?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // eslint-disable-line

  // Sync external value changes (e.g. file switch)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value && value !== undefined) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value || '' },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}
    />
  );
});
