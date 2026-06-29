import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

/**
 * Guards authenticated routes. Unauthenticated users are redirected to
 * /login, preserving the attempted path so login can return them there.
 * While a stored token is being verified, a spinner is shown so a valid
 * session does not flash the login screen on reload.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isHydrating } = useAuth();
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

  return <>{children}</>;
}
