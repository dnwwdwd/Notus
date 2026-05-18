// WysiwygEditor — Tiptap-based WYSIWYG markdown editor (Typora-like)
// Loaded with ssr:false from files/index.js
// Accepts `onEditorReady(editor)` to lift the editor instance to the parent
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { DOMParser, Slice } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Mathematics } from '@tiptap/extension-mathematics';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import Underline from '@tiptap/extension-underline';
import { Markdown } from 'tiptap-markdown';
import { all, createLowlight } from 'lowlight';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Icons } from '../ui/Icons';
import { TextArea } from '../ui/Input';
import { useShortcuts } from '../../contexts/ShortcutsContext';
import { CitationHighlight } from './CitationHighlightExtension';
import { TextAlignCenter, CenterParagraph, CenterHeading } from './TextAlignCenterExtension';
import { findMarkdownTableBlock } from '../../lib/editorMarkdownTable';
import { extractMarkdownTaskList } from '../../lib/editorMarkdownTaskList';

const lowlight = createLowlight(all);
const MATH_MARKDOWN_PASTE_PATTERN = /(?:\$\$[\s\S]+?\$\$|\$(?!\s)(?:\\.|[^$\n\\])+\$)/;

function shouldPreferMarkdownMathPaste(event) {
  if (!event?.clipboardData || event.shiftKey) return false;
  const html = event.clipboardData.getData('text/html');
  const plainText = event.clipboardData.getData('text/plain');
  return Boolean(html && plainText && MATH_MARKDOWN_PASTE_PATTERN.test(plainText));
}

function shouldPreferMarkdownTaskListPaste(event) {
  if (!event?.clipboardData || event.shiftKey) return false;
  const html = event.clipboardData.getData('text/html');
  const plainText = event.clipboardData.getData('text/plain');
  if (!html || !plainText) return false;
  return Boolean(extractMarkdownTaskList(plainText));
}

function pasteMarkdownAsSlice(editorInstance, view, markdownText) {
  const parsedHtml = editorInstance.storage.markdown.parser.parse(markdownText);
  const container = document.createElement('div');
  container.innerHTML = parsedHtml;
  return DOMParser.fromSchema(editorInstance.schema).parseSlice(container, {
    preserveWhitespace: true,
    context: view.state.selection.$from,
  });
}

function getClipboardImageFile(event) {
  const items = Array.from(event?.clipboardData?.items || []);
  const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
  return imageItem?.getAsFile?.() || null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function convertMarkdownTableAroundSelection(editorInstance) {
  if (!editorInstance?.state || !editorInstance?.storage?.markdown?.parser) return false;

  const textSelection = editorInstance.state.selection;
  const $from = textSelection?.$from;
  if (!$from || $from.depth !== 1 || $from.parent?.type?.name !== 'paragraph') return false;

  const blocks = [];
  editorInstance.state.doc.forEach((node, offset, index) => {
    blocks.push({
      node,
      from: offset,
      to: offset + node.nodeSize,
      index,
      text: String(node.textContent || '').trim(),
      type: node.type.name,
    });
  });

  const currentBlockFrom = $from.before(1);
  const currentIndex = blocks.findIndex((block) => block.from === currentBlockFrom);
  if (currentIndex < 0) return false;

  const candidateLines = blocks.map((block) => (block.type === 'paragraph' ? block.text : ''));
  const activeIndex = candidateLines[currentIndex] ? currentIndex : currentIndex - 1;
  const tableBlock = findMarkdownTableBlock(candidateLines, activeIndex);
  if (!tableBlock) return false;
  const markdownText = tableBlock.lines.join('\n');
  const from = blocks[tableBlock.start]?.from;
  const to = blocks[tableBlock.end]?.to;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return false;

  try {
    const parsedHtml = editorInstance.storage.markdown.parser.parse(markdownText);
    const container = document.createElement('div');
    container.innerHTML = parsedHtml;
    const parsedDocument = DOMParser.fromSchema(editorInstance.schema).parse(container, {
      preserveWhitespace: true,
    });
    if (parsedDocument.content.childCount === 0) return false;

    const transaction = editorInstance.state.tr
      .replaceRange(from, to, new Slice(parsedDocument.content, 0, 0))
      .scrollIntoView();
    editorInstance.view.dispatch(transaction);
    return true;
  } catch (error) {
    console.warn('Markdown table conversion failed.', error);
    return false;
  }
}

function MathDialog({ value = '', mode = 'inline', onChange, onClose, onConfirm }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'block' ? '编辑块级公式' : '编辑行内公式'}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onConfirm}>保存公式</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {mode === 'block'
            ? '输入 LaTeX 内容，保存后会以块级公式显示，并写回 Markdown 的 $$...$$ 语法。'
            : '输入 LaTeX 内容，保存后会以内联公式显示，并写回 Markdown 的 $...$ 语法。'}
        </div>
        <TextArea
          value={value}
          minRows={mode === 'block' ? 5 : 3}
          placeholder={mode === 'block' ? '\\sum_{i=1}^{n} x_i = X' : 'E = mc^2'}
          onChange={onChange}
          autoFocus
          spellCheck={false}
          style={{ fontFamily: 'var(--font-mono)' }}
        />
      </div>
    </Dialog>
  );
}

function ImagePreviewOverlay({ preview, onClose, onMove }) {
  const currentImage = preview?.images?.[preview.currentIndex];
  const total = preview?.images?.length || 0;
  const hasPrevious = preview?.currentIndex > 0;
  const hasNext = preview?.currentIndex < total - 1;

  if (!currentImage) return null;

  return (
    <div
      className="notus-image-preview"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      onClick={onClose}
    >
      <button
        type="button"
        className="notus-image-preview-close"
        onClick={onClose}
        aria-label="关闭图片预览"
      >
        <Icons.x size={18} />
      </button>

      <div className="notus-image-preview-chrome">
        <div className="notus-image-preview-counter">
          {preview.currentIndex + 1} / {total}
        </div>
        <div className="notus-image-preview-hint">左右方向键切换，Esc 关闭</div>
      </div>

      <button
        type="button"
        className="notus-image-preview-nav is-left"
        onClick={(event) => {
          event.stopPropagation();
          onMove(-1);
        }}
        disabled={!hasPrevious}
        aria-label="查看上一张图片"
      >
        <Icons.chevronLeft size={20} />
      </button>

      <div
        className="notus-image-preview-figure"
        onClick={(event) => event.stopPropagation()}
      >
        {/* 这里保留原生 img，方便直接预览编辑器里的 data URL 与任意外链图片。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentImage.src}
          alt={currentImage.alt || `文档图片 ${preview.currentIndex + 1}`}
          className="notus-image-preview-image"
        />
        <div className="notus-image-preview-meta">
          <div className="notus-image-preview-title">
            {currentImage.alt || `文档图片 ${preview.currentIndex + 1}`}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="notus-image-preview-nav is-right"
        onClick={(event) => {
          event.stopPropagation();
          onMove(1);
        }}
        disabled={!hasNext}
        aria-label="查看下一张图片"
      >
        <Icons.chevronRight size={20} />
      </button>
    </div>
  );
}

export const WysiwygEditor = ({ value, onChange, onSave, onEditorReady }) => {
  const { shortcuts, matchShortcut } = useShortcuts();
  const editorRef = useRef(null);
  const editorRootRef = useRef(null);
  const isSyncingContentRef = useRef(false);
  const syncFrameRef = useRef(null);
  const [mathDialog, setMathDialog] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const openMathDialog = useCallback((mode, node, pos) => {
    setMathDialog({
      mode,
      pos,
      value: node?.attrs?.latex || '',
    });
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        paragraph: false,
        heading: false,
      }),
      TextAlignCenter,
      CenterParagraph,
      CenterHeading,
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: 'plaintext',
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
      }),
      Placeholder.configure({ placeholder: '开始写作，支持 Markdown 语法…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({
        resizable: false,
      }),
      TableRow,
      TableHeader,
      TableCell,
      Mathematics.configure({
        inlineOptions: {
          onClick: (node, pos) => openMathDialog('inline', node, pos),
        },
        blockOptions: {
          onClick: (node, pos) => openMathDialog('block', node, pos),
        },
        katexOptions: {
          throwOnError: false,
          strict: 'ignore',
          output: 'htmlAndMathml',
        },
      }),
      Underline,
      CitationHighlight,
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    editorProps: {
      handlePaste: (view, event) => {
        const currentEditor = editorRef.current;
        if (!currentEditor) return false;

        const imageFile = getClipboardImageFile(event);
        if (imageFile) {
          event.preventDefault();
          readFileAsDataUrl(imageFile)
            .then((src) => {
              if (!src || !editorRef.current) return;
              const chain = editorRef.current.chain().focus();
              chain.setImage({
                src,
                alt: imageFile.name || '',
                title: imageFile.name || '',
              }).run();
            })
            .catch((error) => {
              console.warn('Clipboard image paste failed.', error);
            });
          return true;
        }

        if (shouldPreferMarkdownTaskListPaste(event)) {
          const plainText = event.clipboardData.getData('text/plain');
          const markdownTaskList = extractMarkdownTaskList(plainText);
          if (markdownTaskList) {
            try {
              const slice = pasteMarkdownAsSlice(currentEditor, view, markdownTaskList);
              event.preventDefault();
              view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
              return true;
            } catch (error) {
              console.warn('Markdown task list paste failed, fallback to default paste handling.', error);
            }
          }
        }

        if (!shouldPreferMarkdownMathPaste(event)) return false;

        const plainText = event.clipboardData.getData('text/plain');
        try {
          // Claude 等富文本来源通常会同时带 HTML 和 Markdown 纯文本；公式必须优先走 Markdown 解析。
          const slice = pasteMarkdownAsSlice(currentEditor, view, plainText);
          event.preventDefault();
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
          return true;
        } catch (error) {
          console.warn('Markdown math paste failed, fallback to default paste handling.', error);
          return false;
        }
      },
    },
    content: '',
    immediatelyRender: false,
    onUpdate({ editor: currentEditor }) {
      if (isSyncingContentRef.current) return;
      const md = currentEditor.storage.markdown.getMarkdown();
      onChange?.(md);

      window.requestAnimationFrame(() => {
        if (!editorRef.current || editorRef.current !== currentEditor) return;
        convertMarkdownTableAroundSelection(currentEditor);
      });
    },
  });

  // Lift editor instance to parent once ready
  useEffect(() => {
    if (!editor) {
      editorRef.current = null;
      onEditorReady?.(null);
      return undefined;
    }

    editorRef.current = editor;

    const frameId = window.requestAnimationFrame(() => {
      onEditorReady?.(editor);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      editorRef.current = null;
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
      editor.commands.setContent(value || '', { emitUpdate: false });
      syncFrameRef.current = window.requestAnimationFrame(() => {
        isSyncingContentRef.current = false;
        syncFrameRef.current = null;
      });
    }
  }, [editor, value]);

  useEffect(() => () => {
    if (syncFrameRef.current) window.cancelAnimationFrame(syncFrameRef.current);
  }, []);

  const handleConfirmMath = useCallback(() => {
    if (!editor || !mathDialog) return;
    const latex = String(mathDialog.value || '').trim();
    if (!latex) {
      setMathDialog(null);
      return;
    }

    if (mathDialog.mode === 'block') {
      editor.chain().focus().updateBlockMath({
        pos: mathDialog.pos,
        latex,
      }).run();
    } else {
      editor.chain().focus().updateInlineMath({
        pos: mathDialog.pos,
        latex,
      }).run();
    }

    setMathDialog(null);
  }, [editor, mathDialog]);

  const collectEditorImages = useCallback(() => {
    const proseMirrorRoot = editorRootRef.current?.querySelector('.ProseMirror');
    if (!proseMirrorRoot) return [];

    return Array.from(proseMirrorRoot.querySelectorAll('img')).reduce((images, imageNode, sourceIndex) => {
      const src = imageNode.getAttribute('src');
      if (!src) return images;

      images.push({
        src,
        alt: imageNode.getAttribute('alt') || '',
        sourceIndex,
      });
      return images;
    }, []);
  }, []);

  const closeImagePreview = useCallback(() => {
    setImagePreview(null);
  }, []);

  const moveImagePreview = useCallback((direction) => {
    setImagePreview((prev) => {
      if (!prev) return prev;
      const nextIndex = Math.min(
        Math.max(prev.currentIndex + direction, 0),
        prev.images.length - 1
      );
      if (nextIndex === prev.currentIndex) return prev;
      return { ...prev, currentIndex: nextIndex };
    });
  }, []);

  useEffect(() => {
    if (!imagePreview) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeImagePreview();
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        moveImagePreview(-1);
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        moveImagePreview(1);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeImagePreview, imagePreview, moveImagePreview]);

  useEffect(() => {
    if (!imagePreview) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [imagePreview]);

  useEffect(() => {
    if (!imagePreview) return;

    const nextImages = collectEditorImages();
    if (!nextImages.length) {
      setImagePreview(null);
      return;
    }

    setImagePreview((prev) => {
      if (!prev) return prev;

      const currentImage = prev.images[prev.currentIndex];
      const matchedIndex = nextImages.findIndex((image) => (
        image.sourceIndex === currentImage?.sourceIndex && image.src === currentImage?.src
      ));
      const nextIndex = matchedIndex >= 0
        ? matchedIndex
        : Math.min(prev.currentIndex, nextImages.length - 1);

      if (
        prev.images.length === nextImages.length
        && prev.currentIndex === nextIndex
        && prev.images.every((image, index) => (
          image.src === nextImages[index]?.src
          && image.alt === nextImages[index]?.alt
          && image.sourceIndex === nextImages[index]?.sourceIndex
        ))
      ) {
        return prev;
      }

      return {
        images: nextImages,
        currentIndex: nextIndex,
      };
    });
  }, [collectEditorImages, imagePreview, value]);

  return (
    <>
      {mathDialog && (
        <MathDialog
          mode={mathDialog.mode}
          value={mathDialog.value}
          onChange={(event) => setMathDialog((prev) => (
            prev ? { ...prev, value: event.target.value } : prev
          ))}
          onClose={() => setMathDialog(null)}
          onConfirm={handleConfirmMath}
        />
      )}
      {imagePreview && (
        <ImagePreviewOverlay
          preview={imagePreview}
          onClose={closeImagePreview}
          onMove={moveImagePreview}
        />
      )}
      <div
        ref={editorRootRef}
        className="wysiwyg-root"
        onKeyDownCapture={(event) => {
          if (matchShortcut(event, shortcuts.docSave.combo)) {
            event.preventDefault();
            onSave?.();
          }
        }}
        onClickCapture={(event) => {
          if (!(event.target instanceof Element)) return;

          const clickedImage = event.target.closest('.ProseMirror img');
          if (!clickedImage) return;

          const nextImages = collectEditorImages();
          const clickedSourceIndex = Array.from(
            editorRootRef.current?.querySelectorAll('.ProseMirror img') || []
          ).indexOf(clickedImage);
          const currentIndex = nextImages.findIndex((image) => image.sourceIndex === clickedSourceIndex);

          if (!nextImages.length) return;

          event.preventDefault();
          setImagePreview({
            images: nextImages,
            currentIndex: currentIndex >= 0 ? currentIndex : 0,
          });
        }}
      >
        <EditorContent editor={editor} className="wysiwyg-content" />
      </div>
    </>
  );
};
