'use client';

import { useEffect } from 'react';

/** Toast / alert text clears itself after `ms` so it does not stay on screen. */
export function useAutoDismiss(value: string, clear: (next: '') => void, ms = 3600) {
  useEffect(() => {
    if (!value) return;
    const timer = window.setTimeout(() => clear(''), ms);
    return () => window.clearTimeout(timer);
  }, [value, clear, ms]);
}
