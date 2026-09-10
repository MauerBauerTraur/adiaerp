import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { ROLE_OPTIONS } from '@/lib/labels';
import type { Role, User } from '@/lib/types';

interface EmployeeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If provided: edit mode (pre-fill from user, PATCH). If null: create mode (POST). */
  user?: User | null;
  onSaved: () => void;
}

interface FormState {
  name: string;
  username: string;
  password: string;
  role: Role;
  telegramId: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  username: '',
  password: '',
  role: 'production_manager',
  telegramId: '',
};

const USERNAME_PATTERN = /^[a-z0-9._-]{2,32}$/;

export function EmployeeFormDialog({
  open,
  onOpenChange,
  user,
  onSaved,
}: EmployeeFormDialogProps) {
  const isEdit = user != null;
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (user != null) {
        setForm({
          name: user.name,
          username: user.username,
          password: '',
          role: user.role,
          telegramId: user.telegram_id != null ? String(user.telegram_id) : '',
        });
      } else {
        setForm({ ...EMPTY_FORM });
      }
      setError(null);
    }
  }, [open, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const name = form.name.trim();
    const username = form.username.trim().toLowerCase();

    if (name === '') {
      setError("Ism-familiya bo'sh bo'lmasligi kerak.");
      return;
    }
    if (username === '') {
      setError('Foydalanuvchi nomi kiritilishi shart.');
      return;
    }
    if (!USERNAME_PATTERN.test(username)) {
      setError("Foydalanuvchi nomi 2-32 belgi, faqat kichik harf/raqam/. _ - bo'lishi mumkin.");
      return;
    }
    if (!isEdit && form.password.length < 8) {
      setError("Parol kamida 8 belgidan iborat bo'lishi kerak.");
      return;
    }
    if (isEdit && form.password !== '' && form.password.length < 8) {
      setError("Yangi parol kamida 8 belgidan iborat bo'lishi kerak.");
      return;
    }

    let telegramIdValue: number | null | undefined;
    if (form.telegramId.trim() !== '') {
      const parsed = Number(form.telegramId.trim());
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        setError("Telegram ID butun son bo'lishi kerak.");
        return;
      }
      telegramIdValue = parsed;
    } else if (isEdit) {
      // Explicit null clears existing telegram_id
      telegramIdValue = null;
    }

    setIsSubmitting(true);
    try {
      if (isEdit && user != null) {
        // PATCH profile fields
        const patchBody: Record<string, unknown> = { name, username, role: form.role };
        // Always send telegram_id (null = clear)
        patchBody['telegram_id'] = telegramIdValue ?? null;
        await apiRequest(`/api/users/${user.id}`, { method: 'PATCH', body: patchBody });

        // Optional password change
        if (form.password.trim() !== '') {
          await apiRequest(`/api/users/${user.id}/password`, {
            method: 'PUT',
            body: { password: form.password },
          });
        }
        notify('success', "Foydalanuvchi yangilandi.");
      } else {
        // POST create
        const body: Record<string, unknown> = {
          name,
          username,
          password: form.password,
          role: form.role,
        };
        if (telegramIdValue != null) {
          body['telegram_id'] = telegramIdValue;
        }
        await apiRequest('/api/users', { method: 'POST', body });
        notify('success', "Foydalanuvchi qo'shildi.");
      }
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Foydalanuvchini tahrirlash" : "Yangi foydalanuvchi"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Foydalanuvchi ma'lumotlarini yangilang. Parolni o'zgartirmasangiz, bo'sh qoldiring."
              : "Foydalanuvchi ma'lumotlarini kiriting. Bo'g'in rolga qarab avtomatik biriktiriladi; ko'rinadigan bo'limlar \"Bo'limlar\" oynasida sozlanadi."}
          </DialogDescription>
        </DialogHeader>

        <form
          id="employee-form"
          className="max-h-[65vh] space-y-4 overflow-y-auto pr-1"
          onSubmit={handleSubmit}
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="employee-name">Ism-familiya</Label>
            <Input
              id="employee-name"
              name="name"
              autoComplete="name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="employee-username">Foydalanuvchi nomi</Label>
            <Input
              id="employee-username"
              name="username"
              type="text"
              autoComplete="username"
              required
              pattern="[a-z0-9._\-]{2,32}"
              minLength={2}
              maxLength={32}
              placeholder="masalan: pm yoki anvar.k"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Tizimga kirish uchun. 2-32 belgi, faqat kichik harf, raqam, <code>. _ -</code>.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="employee-password">
              {isEdit ? "Yangi parol (ixtiyoriy)" : "Parol"}
            </Label>
            <Input
              id="employee-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required={!isEdit}
              minLength={isEdit ? 0 : 8}
              placeholder={isEdit ? "Bo'sh qoldirilsa o'zgarmaydi" : ''}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            {!isEdit && <p className="text-xs text-muted-foreground">Kamida 8 belgi.</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="employee-role">Rol</Label>
            <Select
              id="employee-role"
              name="role"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="employee-telegram">Telegram ID (ixtiyoriy)</Label>
            <Input
              id="employee-telegram"
              name="telegram_id"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={form.telegramId}
              onChange={(e) => setForm({ ...form, telegramId: e.target.value })}
            />
          </div>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button type="submit" form="employee-form" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {isEdit ? 'Yangilash' : 'Saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
