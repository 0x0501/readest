'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/hooks/useTheme';
import { useThemeStore } from '@/store/themeStore';
import { useQuotaStats } from '@/hooks/useQuotaStats';
import { useTranslation } from '@/hooks/useTranslation';
import { useUserActions } from '@/hooks/useUserActions';
import { navigateToLibrary } from '@/utils/nav';
import { getPlanDetails } from './utils/plan';
import { Toast } from '@/components/Toast';
import Spinner from '@/components/Spinner';
import ProfileHeader from './components/Header';
import UserInfo from './components/UserInfo';
import UsageStats from './components/UsageStats';
import AccountActions from './components/AccountActions';
import StorageManager from './components/StorageManager';
import { isWebAppPlatform } from '@/services/environment';
import { PasskeySection } from './components/PasskeySection';
import SharedLinksSection from './components/SharedLinksSection';
import { SyncPassphraseSection } from './components/SyncPassphraseSection';
import { SyncCategoriesSection } from './components/SyncCategoriesSection';

const ProfilePage = () => {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const { token, user, refresh } = useAuth();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();

  const [loading] = useState(false);
  const [showStorageManager, setShowStorageManager] = useState(false);
  const [showSharedLinksManager, setShowSharedLinksManager] = useState(false);
  const searchParams = useSearchParams();
  const [showSyncManager, setShowSyncManager] = useState(
    () => searchParams?.get('section') === 'sync',
  );
  const [showPasskeyManager, setShowPasskeyManager] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;

    const isAuthenticated = user && token && appService;
    if (isAuthenticated) return;

    const timer = setTimeout(() => {
      router.push('/auth?redirect=/library');
    }, 1000);

    return () => clearTimeout(timer);
  }, [mounted, user, token, appService, router]);

  useTheme({ systemUIVisible: false });

  const { quotas, userProfilePlan = 'free' } = useQuotaStats();
  const { handleLogout, handleResetPassword, handleConfirmDelete } = useUserActions();

  const handleGoBack = () => {
    if (showStorageManager) {
      setShowStorageManager(false);
      refresh();
    } else if (showSharedLinksManager) {
      setShowSharedLinksManager(false);
    } else if (showSyncManager) {
      setShowSyncManager(false);
    } else if (showPasskeyManager) {
      setShowPasskeyManager(false);
    } else {
      navigateToLibrary(router);
    }
  };

  const handleDeleteWithMessage = () => {
    handleConfirmDelete(_('Failed to delete user. Please try again later.'));
  };

  const handleManageStorage = () => {
    setShowStorageManager(true);
  };

  const handleManageSharedLinks = () => {
    setShowSharedLinksManager(true);
  };
  const handleManageSync = () => {
    setShowSyncManager(true);
  };
  const handleManagePasskeys = () => {
    setShowPasskeyManager(true);
  };

  if (!mounted) {
    return null;
  }

  if (!user || !token || !appService) {
    return (
      <div className='mx-auto max-w-4xl px-4 py-8'>
        <div className='overflow-hidden rounded-lg shadow-md'>
          <div className='flex min-h-[300px] items-center justify-center p-6'>
            <div className='text-base-content animate-pulse'>{_('Loading profile...')}</div>
          </div>
        </div>
      </div>
    );
  }

  const avatarUrl = user?.image ?? undefined;
  const userFullName = user?.name || '-';
  const userEmail = user?.email || '';
  const userPlanDetails = getPlanDetails(userProfilePlan) || getPlanDetails('free');

  return (
    <div
      className={clsx(
        'bg-base-100 full-height inset-0 select-none overflow-hidden',
        appService?.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <div
        className={clsx('flex h-full w-full flex-col items-center overflow-y-auto')}
        style={{
          paddingTop: `${safeAreaInsets?.top || 0}px`,
        }}
      >
        <ProfileHeader onGoBack={handleGoBack} />
        <div className='w-full min-w-60 max-w-4xl py-10'>
          {loading && (
            <div className='fixed inset-0 z-50 flex items-center justify-center'>
              <Spinner loading className='text-gray-900' />
            </div>
          )}
          {
            <div className='sm:bg-base-200 overflow-hidden rounded-lg sm:p-6 sm:shadow-md'>
              <div className='flex flex-col gap-y-8'>
                <div className='flex flex-col gap-y-8 px-6'>
                  <UserInfo
                    avatarUrl={avatarUrl}
                    userFullName={userFullName}
                    userEmail={userEmail}
                    planDetails={userPlanDetails}
                  />

                  {!showStorageManager &&
                    !showSharedLinksManager &&
                    !showSyncManager &&
                    !showPasskeyManager && <UsageStats quotas={quotas} />}
                </div>

                {showStorageManager ? (
                  <div className='flex flex-col gap-y-8 px-6'>
                    <StorageManager />
                  </div>
                ) : showSharedLinksManager ? (
                  <div className='flex flex-col gap-y-8 px-6'>
                    <SharedLinksSection />
                  </div>
                ) : showSyncManager ? (
                  <div className='flex flex-col gap-y-8 px-6'>
                    <SyncCategoriesSection />
                    <SyncPassphraseSection />
                  </div>
                ) : showPasskeyManager ? (
                  <div className='flex flex-col gap-y-8 px-6'>
                    <PasskeySection />
                  </div>
                ) : (
                  <>
                    <div className='flex flex-col gap-y-8 px-6'>
                      <AccountActions
                        onLogout={handleLogout}
                        onResetPassword={handleResetPassword}
                        onConfirmDelete={handleDeleteWithMessage}
                        onManageStorage={handleManageStorage}
                        onManageSharedLinks={handleManageSharedLinks}
                        onManageSync={handleManageSync}
                        // Web only: Tauri webviews serve from a custom scheme,
                        // which WebAuthn's origin check rejects.
                        onManagePasskeys={isWebAppPlatform() ? handleManagePasskeys : undefined}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          }
        </div>
        <Toast />
      </div>
    </div>
  );
};

export default ProfilePage;
