import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from './auth-context';

/** Access the current auth session. Must be used inside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth() <AuthProvider> ichida ishlatilishi kerak.');
  }
  return ctx;
}
