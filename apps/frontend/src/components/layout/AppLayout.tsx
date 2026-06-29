import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { CakeSlice, Menu } from 'lucide-react';
import { AppSidebar } from './AppSidebar';
import { AssistantButton } from './AssistantButton';
import { LocationSwitcher } from './LocationSwitcher';
import { PageTabs } from './PageTabs';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { findGroupForPath } from '@/lib/navigation';
import {
  HeaderSlotProvider,
  useHeaderSlotContent,
} from './HeaderSlot';

/**
 * Authenticated layout shell — hybrid navigation (F4.13).
 *
 * Desktop (`lg+`):
 *   - 64px icon rail on the left, four group icons (Boshqaruv paneli,
 *     Bashorat, Modullar, Ma'lumotnoma) — see `AppSidebar`.
 *   - When the current route belongs to a tabbed group (Modullar or
 *     Ma'lumotnoma), Jira-style pill tabs render at the top of the
 *     page automatically via `findGroupForPath`.
 *
 * Below `lg`:
 *   - Sidebar lives in a Sheet drawer. A hamburger button in the
 *     header opens it; nav clicks and route changes auto-close it.
 */
export function AppLayout() {
  return (
    <HeaderSlotProvider>
      <AppLayoutShell />
    </HeaderSlotProvider>
  );
}

const SIDEBAR_EXPANDED_KEY = 'adia.sidebar.expanded';

function readStoredExpanded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_EXPANDED_KEY) === 'true';
  } catch {
    return false;
  }
}

function AppLayoutShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(
    readStoredExpanded,
  );
  const location = useLocation();
  const headerSlot = useHeaderSlotContent();

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const toggleSidebar = () => {
    setSidebarExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(SIDEBAR_EXPANDED_KEY, String(next));
      } catch {
        // best-effort — private mode / quota
      }
      return next;
    });
  };

  const activeGroup = findGroupForPath(location.pathname);
  const showTabs = activeGroup?.hasTabs === true;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar expanded={sidebarExpanded} onToggle={toggleSidebar} />
      <div
        className={cn(
          'flex flex-1 flex-col overflow-hidden transition-[padding] duration-200',
          sidebarExpanded ? 'lg:pl-56' : 'lg:pl-16',
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-background/80 backdrop-blur-sm px-3 sm:px-6 lg:px-8">
          <button
            type="button"
            aria-label="Menyu"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="inline-flex size-9 items-center justify-center rounded-lg border border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors lg:hidden"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <div className="flex min-w-0 items-center gap-2 lg:hidden">
            <div className="flex size-6 items-center justify-center rounded-md bg-primary/10">
              <CakeSlice className="size-4 text-primary" aria-hidden="true" />
            </div>
            <span className="truncate text-sm font-bold tracking-tight">
              ADIA ERP
            </span>
          </div>
          <div className="flex min-w-0 flex-1 items-center">{headerSlot}</div>
          <div className="flex shrink-0 items-center justify-end">
            <LocationSwitcher />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          {showTabs && activeGroup && <PageTabs group={activeGroup.key} />}
          <Outlet />
        </main>
      </div>

      {/* Mobile / tablet drawer — `lg+` users use the rail sidebar
          instead, the hamburger button is hidden. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <AppSidebar inDrawer onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      <AssistantButton />
    </div>
  );
}
