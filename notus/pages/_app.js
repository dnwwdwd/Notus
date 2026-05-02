// _app.js — global styles + theme + providers
import { useEffect } from 'react';
import '../styles/globals.css';
import 'katex/dist/katex.min.css';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { ToastProvider } from '../components/ui/Toast';
import { PageTransitionOverlay } from '../components/ui/PageTransitionOverlay';
import { AppProvider } from '../contexts/AppContext';
import { AppStatusProvider } from '../contexts/AppStatusContext';
import { PlatformProvider } from '../contexts/PlatformContext';
import { ShortcutsProvider } from '../contexts/ShortcutsContext';

const CORE_ROUTES = ['/files', '/knowledge', '/canvas', '/settings/model'];

function CoreRoutePrefetcher() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === 'undefined' || typeof router.prefetch !== 'function') return undefined;

    let cancelled = false;
    let timeoutId = null;
    let idleId = null;

    const prefetchAll = () => {
      if (cancelled) return;
      CORE_ROUTES.forEach((target) => {
        router.prefetch(target).catch(() => {});
      });
    };

    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(prefetchAll, { timeout: 1500 });
    } else {
      timeoutId = window.setTimeout(prefetchAll, 300);
    }

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      if (idleId && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [router]);

  return null;
}

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>Notus</title>
        <meta name="application-name" content="Notus" />
        <meta name="description" content="私有化个人知识库与 AI 写作协作工具" />
        <meta name="theme-color" content="#C15F3C" />
        <link rel="icon" href="/logo.png" type="image/png" />
        <link rel="apple-touch-icon" href="/logo.png" />
      </Head>
      <ShortcutsProvider>
        <PlatformProvider>
          <AppStatusProvider>
            <AppProvider>
              <ToastProvider>
                <CoreRoutePrefetcher />
                <PageTransitionOverlay />
                <Component {...pageProps} />
              </ToastProvider>
            </AppProvider>
          </AppStatusProvider>
        </PlatformProvider>
      </ShortcutsProvider>
    </>
  );
}
