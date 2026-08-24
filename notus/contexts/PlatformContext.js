import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getProfile, profileFromSettings } from '../utils/platformClient';

const PlatformContext = createContext(null);

const DEFAULT_PROFILE = {
  runtimeTarget: 'web',
  storageMode: 'external',
  dataRoot: '',
  notesDir: '',
  assetsDir: '',
  dbPath: '',
  logDir: '',
  sessionDir: '',
  canAutoPurgeOnUninstall: false,
  capabilities: {},
};

export function PlatformProvider({ children }) {
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshPlatform = useCallback(async (seedSettings = null) => {
    setLoading(true);
    try {
      const nextProfile = seedSettings ? profileFromSettings(seedSettings) : await getProfile();
      setProfile((prev) => ({ ...prev, ...nextProfile }));
      setError(null);
      return nextProfile;
    } catch (refreshError) {
      setError(refreshError);
      throw refreshError;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshPlatform().catch(() => {});
  }, [refreshPlatform]);

  const value = useMemo(() => ({
    profile,
    capabilities: profile.capabilities || {},
    loading,
    error,
    refreshPlatform,
  }), [error, loading, profile, refreshPlatform]);

  return (
    <PlatformContext.Provider value={value}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatform() {
  const context = useContext(PlatformContext);
  if (!context) throw new Error('usePlatform must be used within PlatformProvider');
  return context;
}
