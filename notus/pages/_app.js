// _app.js — global styles + theme + providers
import 'katex/dist/katex.min.css';
import '../styles/globals.css';
import Head from 'next/head';
import { AppStatusGate } from '../components/AppStatusGate';
import { ToastProvider } from '../components/ui/Toast';
import { AppProvider } from '../contexts/AppContext';
import { AppStatusProvider } from '../contexts/AppStatusContext';
import { ShortcutsProvider } from '../contexts/ShortcutsContext';

export default function App({ Component, pageProps }) {
  return (
    <>
      <Head>
        <title>Notus</title>
        <meta name="application-name" content="Notus" />
        <meta name="description" content="私有化个人知识库与 AI 写作协作工具" />
        <meta name="theme-color" content="#C15F3C" />
        <link rel="icon" href="/notus-logo.svg" type="image/svg+xml" />
      </Head>
      <ShortcutsProvider>
        <AppStatusProvider>
          <AppProvider>
            <ToastProvider>
              <AppStatusGate>
                <Component {...pageProps} />
              </AppStatusGate>
            </ToastProvider>
          </AppProvider>
        </AppStatusProvider>
      </ShortcutsProvider>
    </>
  );
}
