import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { NotusLogo } from './Icons';
import { consumeNavigationTransition } from '../../utils/navigation';

const HIDE_DELAY_MS = 180;
const UNMOUNT_DELAY_MS = 360;

export function PageTransitionOverlay() {
  const router = useRouter();
  const initialTransition = typeof window !== 'undefined'
    ? Boolean(consumeNavigationTransition())
    : false;
  const [mounted, setMounted] = useState(initialTransition);
  const [active, setActive] = useState(initialTransition);
  const hideTimerRef = useRef(null);
  const unmountTimerRef = useRef(null);

  const clearTimers = () => {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (unmountTimerRef.current) {
      window.clearTimeout(unmountTimerRef.current);
      unmountTimerRef.current = null;
    }
  };

  const showOverlay = () => {
    if (typeof window === 'undefined') return;
    clearTimers();
    setMounted(true);
    setActive(true);
  };

  const hideOverlay = () => {
    if (typeof window === 'undefined') return;
    clearTimers();
    hideTimerRef.current = window.setTimeout(() => {
      setActive(false);
    }, HIDE_DELAY_MS);
    unmountTimerRef.current = window.setTimeout(() => {
      setMounted(false);
    }, UNMOUNT_DELAY_MS);
  };

  useEffect(() => {
    if (initialTransition) {
      hideOverlay();
    }

    return () => {
      clearTimers();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleStart = () => {
      showOverlay();
    };
    const handleComplete = () => {
      hideOverlay();
    };

    router.events.on('routeChangeStart', handleStart);
    router.events.on('routeChangeComplete', handleComplete);
    router.events.on('routeChangeError', handleComplete);

    return () => {
      router.events.off('routeChangeStart', handleStart);
      router.events.off('routeChangeComplete', handleComplete);
      router.events.off('routeChangeError', handleComplete);
    };
  }, [router.events]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mounted) return null;

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2400,
        pointerEvents: 'none',
        opacity: active ? 1 : 0,
        transition: 'opacity 180ms ease',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(250, 249, 245, 0.78), rgba(250, 249, 245, 0.18))',
          backdropFilter: 'blur(4px)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          background: 'linear-gradient(90deg, transparent 0%, var(--accent) 18%, var(--accent-muted) 48%, var(--accent) 82%, transparent 100%)',
          transformOrigin: 'left center',
          transform: active ? 'scaleX(1)' : 'scaleX(0.35)',
          opacity: active ? 1 : 0,
          transition: 'transform 260ms ease, opacity 180ms ease',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(-50%, -50%) scale(${active ? 1 : 0.94})`,
          transition: 'transform 220ms ease, opacity 180ms ease',
          opacity: active ? 1 : 0,
        }}
      >
        <div
          style={{
            width: 58,
            height: 58,
            borderRadius: 18,
            background: 'rgba(255, 255, 255, 0.86)',
            border: '1px solid rgba(193, 95, 60, 0.14)',
            boxShadow: 'var(--shadow-lg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <NotusLogo size={28} />
        </div>
      </div>
    </div>
  );
}
