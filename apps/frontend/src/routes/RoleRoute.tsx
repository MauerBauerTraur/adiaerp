import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import type { Role } from '@/lib/types';

/**
 * Route guard that restricts a screen to a set of roles (RBAC §6).
 * A user whose role is not allowed is bounced to the dashboard rather
 * than shown a forbidden page — Faza-1 keeps the flow simple.
 */
export function RoleRoute({
  allow,
  children,
}: {
  allow: readonly Role[];
  children: ReactNode;
}) {
  const { user } = useAuth();

  if (user && !allow.includes(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
