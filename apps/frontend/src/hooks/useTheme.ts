import { useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'adia.theme';

function readStored(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* ignore */
  }
  return 'system';
}

function resolveSystem(): 'light' | 'dark' {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

/** Apply the resolved theme to `<html>` and `<meta name="color-scheme">`. */
function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const effective = mode === 'system' ? resolveSystem() : mode;
  const html = document.documentElement;
  if (effective === 'dark') html.classList.add('dark');
  else html.classList.remove('dark');
  const meta = document.querySelector<HTMLMetaElement>(
    'meta[name="color-scheme"]',
  );
  if (meta) meta.setAttribute('content', effective);
}

/**
 * Theme controller — `light | dark | system`.
 *
 * - Persists the user's choice in `localStorage`.
 * - When `system`, follows `prefers-color-scheme` and re-applies on change.
 * - Returns both the selected `mode` and the `resolved` effective theme so
 *   UI can show a "(auto: dark)" hint when on `system`.
 */
export function useTheme(): {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    readStored() === 'system' ? resolveSystem() : (readStored() as 'light' | 'dark'),
  );

  useEffect(() => {
    applyTheme(mode);
    setResolved(mode === 'system' ? resolveSystem() : mode);
  }, [mode]);

  // Listen for OS theme changes while we are on `system`.
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => {
      applyTheme('system');
      setResolved(resolveSystem());
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [mode]);

  function setMode(next: ThemeMode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    setModeState(next);
  }

  return { mode, resolved, setMode };
}
