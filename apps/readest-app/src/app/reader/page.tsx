'use client';

import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useAppUrlIngress } from '@/hooks/useAppUrlIngress';
import { useOpenWithBooks } from '@/hooks/useOpenWithBooks';
import { useOpenAnnotationLink } from '@/hooks/useOpenAnnotationLink';
import { useOpenBookLink } from '@/hooks/useOpenBookLink';
import { useReadingWidget } from '@/hooks/useReadingWidget';
import { useOpenShareLink } from '@/hooks/useOpenShareLink';
import { useClipUrlIngress } from '@/hooks/useClipUrlIngress';
import { useSettingsStore } from '@/store/settingsStore';
import { checkForAppUpdates, checkAppReleaseNotes } from '@/helpers/updater';
import { tauriHandleSetAlwaysOnTop } from '@/utils/window';
import ClipSignInAlert from '@/components/ClipSignInAlert';

// The reader renders nothing meaningful until it has the book, which lives in
// browser storage — so server-rendering it produces an empty shell while pulling
// foliate-js, pdf.js and jieba into the Worker, where none of them ever run.
const Reader = dynamic(() => import('./components/Reader'), { ssr: false });

// This is only used for the Tauri app in the app router
export default function Page() {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();

  useAppUrlIngress();
  useOpenWithBooks();
  useOpenAnnotationLink();
  useOpenBookLink();
  useReadingWidget();
  useOpenShareLink();
  useClipUrlIngress();

  useEffect(() => {
    const doCheckAppUpdates = async () => {
      if (appService?.hasUpdater && settings.autoCheckUpdates) {
        await checkForAppUpdates(_, true, settings.updateChannel);
      } else if (appService?.hasUpdater === false) {
        checkAppReleaseNotes();
      }
    };
    if (appService?.hasWindow && settings.alwaysOnTop) {
      tauriHandleSetAlwaysOnTop(settings.alwaysOnTop);
    }
    doCheckAppUpdates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService?.hasUpdater, settings.autoCheckUpdates]);

  return (
    <>
      <Reader />
      <ClipSignInAlert />
    </>
  );
}
