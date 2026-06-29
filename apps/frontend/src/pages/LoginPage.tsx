import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { CakeSlice, Eye, EyeOff, Loader2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { LoginRequest, LoginResponse } from '@/lib/types';

interface LocationState {
  from?: string;
}

/**
 * Login page — wired to `POST /api/auth/login` (phase-1-mvp.md §4.1).
 *
 * Username-only identity (migration 0027): the `login` field carries the
 * username (2-32 chars, `[a-z0-9._-]`), matched case-insensitively against
 * `users.username` server-side. Email was removed from the model entirely.
 * The client always sends `{login, password}`.
 *
 * On success the session is stored and the user is sent to the path
 * they originally requested (or the dashboard).
 */
export function LoginPage() {
  const { login: loginToContext } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const redirectTo =
    (location.state as LocationState | null)?.from ?? '/dashboard';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const body: LoginRequest = { login: login.trim(), password };
      const result = await apiRequest<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body,
      });
      loginToContext(
        {
          accessToken: result.access_token,
          refreshToken: result.refresh_token,
        },
        result.user,
      );
      navigate(redirectTo, { replace: true });
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        // 401 / 422 → bad credentials or invalid input.
        setError(
          err.status === 401 || err.status === 422
            ? 'Login yoki parol noto‘g‘ri.'
            : err.message,
        );
      } else {
        setError('Kirishda xatolik yuz berdi. Qayta urinib ko‘ring.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CakeSlice className="size-9 text-primary" aria-hidden="true" />
          <CardTitle className="text-xl">ADIA ERP</CardTitle>
          <CardDescription>Tizimga kirish</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit} noValidate>
            <div className="space-y-2">
              <Label htmlFor="login">Foydalanuvchi nomi</Label>
              <Input
                id="login"
                name="login"
                type="text"
                autoComplete="username"
                placeholder="pm"
                required
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                disabled={isSubmitting}
                aria-invalid={error !== null}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Parol</Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isSubmitting}
                  aria-invalid={error !== null}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={isSubmitting}
                  className="absolute inset-y-0 right-0 flex items-center justify-center px-3 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  aria-label={showPassword ? 'Parolni yashirish' : 'Parolni ko‘rsatish'}
                  aria-pressed={showPassword}
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {error && (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              Kirish
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
