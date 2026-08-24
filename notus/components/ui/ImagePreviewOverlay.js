import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './Icons';

export function ImagePreviewOverlay({ preview, onClose, onMove }) {
  const currentImage = preview?.images?.[preview.currentIndex];
  const total = preview?.images?.length || 0;
  const hasPrevious = preview?.currentIndex > 0;
  const hasNext = preview?.currentIndex < total - 1;

  useEffect(() => {
    if (!currentImage) return undefined;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose?.();
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onMove?.(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onMove?.(1);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [currentImage, onClose, onMove]);

  useEffect(() => {
    if (!currentImage) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [currentImage]);

  if (!currentImage || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="notus-image-preview"
      role="dialog"
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
        <div className="notus-image-preview-counter">{preview.currentIndex + 1} / {total}</div>
        <div className="notus-image-preview-hint">左右方向键切换，Esc 关闭</div>
      </div>

      <button
        type="button"
        className="notus-image-preview-nav is-left"
        onClick={(event) => {
          event.stopPropagation();
          onMove?.(-1);
        }}
        disabled={!hasPrevious}
        aria-label="查看上一张图片"
      >
        <Icons.chevronLeft size={20} />
      </button>

      <div className="notus-image-preview-figure" onClick={(event) => event.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentImage.src}
          alt={currentImage.alt || `图片 ${preview.currentIndex + 1}`}
          className="notus-image-preview-image"
        />
        {preview.hideTitle ? null : <div className="notus-image-preview-meta">
          <div className="notus-image-preview-title">{currentImage.alt || `图片 ${preview.currentIndex + 1}`}</div>
        </div>}
      </div>

      <button
        type="button"
        className="notus-image-preview-nav is-right"
        onClick={(event) => {
          event.stopPropagation();
          onMove?.(1);
        }}
        disabled={!hasNext}
        aria-label="查看下一张图片"
      >
        <Icons.chevronRight size={20} />
      </button>
    </div>,
    document.body
  );
}
