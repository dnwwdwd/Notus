import { useEffect, useRef } from 'react';

export function useStableAiReadiness(aiState) {
  const lastReadyRef = useRef(Boolean(aiState?.ready));

  useEffect(() => {
    if (aiState?.ready) {
      lastReadyRef.current = true;
    }
  }, [aiState?.ready]);

  const ready = Boolean(aiState?.ready) || (Boolean(aiState?.loading) && lastReadyRef.current);
  const showLockedState = !ready && !aiState?.loading;
  const showLoadingState = !ready && Boolean(aiState?.loading);

  return {
    ...aiState,
    ready,
    showLockedState,
    showLoadingState,
  };
}
