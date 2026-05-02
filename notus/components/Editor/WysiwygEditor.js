// WysiwygEditor — Tiptap-based WYSIWYG markdown editor (Typora-like)
// Loaded with ssr:false from files/index.js
// Accepts `onEditorReady(editor)` to lift the editor instance to the parent
import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Underline from '@tiptap/extension-underline';
import { Markdown } from 'tiptap-markdown';
import { all, createLowlight } from 'lowlight';
import { useShortcuts } from '../../contexts/ShortcutsContext';
import { CitationHighlight } from './CitationHighlightExtension';

const lowlight = createLowlight(all);

export const WysiwygEditor = ({ value, onChange, onSave, onEditorReady }) => {
  const { shortcuts, matchShortcut } = useShortcuts();
  const isSyncingContentRef = useRef(false);
  const syncFrameRef = useRef(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: 'plaintext',
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      Image.configure({ inline: false }),
      Placeholder.configure({ placeholder: '开始写作，支持 Markdown 语法…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Underline,
      CitationHighlight,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: '',
    immediatelyRender: false,
    onUpdate({ editor }) {
      if (isSyncingContentRef.current) return;
      const md = editor.storage.markdown.getMarkdown();
      onChange?.(md);
    },
  });

  // Lift editor instance to parent once ready
  useEffect(() => {
    if (!editor) {
      onEditorReady?.(null);
      return undefined;
    }

    const frameId = window.requestAnimationFrame(() => {
      onEditorReady?.(editor);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      onEditorReady?.(null);
    };
  }, [editor, onEditorReady]);

  // Sync when file switches (value changes externally)
  useEffect(() => {
    if (!editor || value === undefined) return;
    const current = editor.storage.markdown.getMarkdown();
    if (current !== value) {
      isSyncingContentRef.current = true;
      if (syncFrameRef.current) window.cancelAnimationFrame(syncFrameRef.current);
      // tiptap-markdown overrides setContent to parse markdown instead of treating it as HTML.
      editor.commands.setContent(value || '', false);
      syncFrameRef.current = window.requestAnimationFrame(() => {
        isSyncingContentRef.current = false;
        syncFrameRef.current = null;
      });
    }
  }, [editor, value]);

  useEffect(() => () => {
    if (syncFrameRef.current) window.cancelAnimationFrame(syncFrameRef.current);
  }, []);

  return (
    <div
      className="wysiwyg-root"
      onKeyDownCapture={(event) => {
        if (matchShortcut(event, shortcuts.docSave.combo)) {
          event.preventDefault();
          onSave?.();
        }
      }}
    >
      <EditorContent editor={editor} className="wysiwyg-content" />
    </div>
  );
};
