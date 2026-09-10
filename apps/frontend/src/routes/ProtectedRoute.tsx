import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { firstAllowedPath, isPathAllowed } from '@/lib/navigation';

/**
 * Guards authenticated routes. Unauthenticated users are redirected to
 * /login, preserving the attempted path so login can return them there.
 * While a stored token is being verified, a spinner is shown so a valid
 * session does not flash the login screen on reload.
 *
 * It also enforces the per-user page whitelist (migration 0061) so hiding a
 * bo'lim in the sidebar cannot be defeated by typing the URL. Paths outside
 * the nav model (detail routes, utility screens) always pass — see
 * `isPathAllowed`.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isHydrating, user, allowedPaths } = useAuth();
  const location = useLocation();

  if (isHydrating) {
    return (
      <div
        className="flex min-h-screen items-center justify-center bg-background"
        role="status"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Sessiya tekshirilmoqda…</span>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (user && !isPathAllowed(location.pathname, user.role, allowedPaths)) {
    const fallback = firstAllowedPath(user.role, allowedPaths);
    // `fallback === null` means the whitelist left this account with nothing
    // to open. Redirecting would loop, so explain it instead.
    if (fallback === null) {
      return (
        <div
          className="flex min-h-screen items-center justify-center bg-background p-6"
          role="alert"
        >
          <p className="max-w-sm text-center text-sm text-muted-foreground">
            Sizga hech qanday bo‘lim biriktirilmagan. Administratorga murojaat
            qiling.
          </p>
        </div>
      );
    }
    return <Navigate to={fallback} replace />;
  }

  return <>{children}</>;
}
