import { useEffect, useState } from 'react';

/**
 * F4.8 — responsive breakpoint hook.
 *
 * Matches Tailwind's default breakpoints:
 *   `sm` →  640 ≤ w < 1024  (large phone / tablet portrait)
 *   `md` →  768 ≤ w < 1024  (folded into `sm` returned bucket — see below)
 *   `lg` → 1024 ≤ w < 1280  (laptop)
 *   `xl` → 1280+            (desktop)
 *   `<sm` (returned as `xs`) → w < 640 (phone)
 *
 * We collapse `md` into the `sm` bucket because the design system treats
 * everything below `lg` (1024) as "compact" — sidebar hidden, tables
 * shown as card lists, full-screen dialogs. Components that need the
 * fine-grained breakpoint can read `window.innerWidth` directly.
 *
 * SSR-safe: returns `xl` on the server (most cautious default — no
 * accidental hamburger on initial paint in an SSR scenario).
 */
export type Breakpoint = 'xs' | 'sm' | 'lg' | 'xl';

const BREAKPOINTS = {
  sm: 640,
  lg: 1024,
  xl: 1280,
} as const;

function read(): Breakpoint {
  if (typeof window === 'undefined') return 'xl';
  const w = window.innerWidth;
  if (w < BREAKPOINTS.sm) return 'xs';
  if (w < BREAKPOINTS.lg) return 'sm';
  if (w < BREAKPOINTS.xl) return 'lg';
  return 'xl';
}

export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(() => read());

  useEffect(() => {
    function onResize() {
      setBp(read());
    }
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return bp;
}

/**
 * Convenience flag — true when the viewport is below `lg` (1024).
 * Use for hamburger menus, table → card swaps, full-screen dialogs.
 */
export function useIsMobile(): boolean {
  const bp = useBreakpoint();
  return bp === 'xs' || bp === 'sm';
}
