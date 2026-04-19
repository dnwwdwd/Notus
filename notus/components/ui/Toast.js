// Toast notification system
import { createContext, useContext, useState, useCallback } from 'react';
import { Icons } from './Icons';

const ToastContext = createContext(null);

let toastId = 0;

export const ToastProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);

  const show = useCallback((msg, tone = 'success') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, msg, tone }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  }, []);

  const toneIcon = {
    success: <Icons.check size={14} />,
    danger: <Icons.x size={14} />,
    warning: <Icons.warn size={14} />,
    info: <Icons.info size={14} />,
  };
  const toneColor = {
    success: 'var(--success)',
    danger: 'var(--danger)',
    warning: 'var(--warning)',
    info: '#4A8CD9',
  };

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-lg)',
              boxShadow: 'var(--shadow-md)',
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 'var(--text-sm)',
              minWidth: 240,
              animation: 'slideUp var(--transition-normal)',
              pointerEvents: 'all',
            }}
          >
            <span style={{ color: toneColor[t.tone] }}>{toneIcon[t.tone]}</span>
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => useContext(ToastContext);
