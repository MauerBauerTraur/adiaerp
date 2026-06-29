import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemeMode } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  /** Compact mode: render only icons (sidebar rail). */
  compact?: boolean;
}

const OPTIONS: { id: ThemeMode; label: string; Icon: typeof Sun }[] = [
  { id: 'light', label: 'Yorug‘', Icon: Sun },
  { id: 'dark', label: 'Qorong‘i', Icon: Moon },
  { id: 'system', label: 'Tizim', Icon: Monitor },
];

export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const { mode, setMode } = useTheme();

  if (compact) {
    // Rotating single icon — clicking cycles light → dark → system.
    const idx = OPTIONS.findIndex((o) => o.id === mode);
    const current = OPTIONS[idx] ?? OPTIONS[2]!;
    const next = OPTIONS[(idx + 1) % OPTIONS.length]!;
    return (
      <button
        type="button"
        onClick={() => setMode(next.id)}
        aria-label={`Mavzu: ${current.label}. Bosing — ${next.label} ga o‘tish.`}
        title={`Mavzu: ${current.label}`}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <current.Icon className="size-4" aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Mavzu rejimi"
      className="inline-flex w-full items-center rounded-md border border-border bg-card/40 p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => setMode(opt.id)}
            className={cn(
              'inline-flex flex-1 items-center justify-center rounded-sm py-1.5 transition-colors',
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <opt.Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
