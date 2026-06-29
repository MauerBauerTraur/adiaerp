import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import { NAV_SECTIONS, type NavGroupKey } from '@/lib/navigation';

interface PageTabsProps {
  /** Which group to render tabs for. */
  group: NavGroupKey;
}

/**
 * Jira-style sub-tab strip rendered at the top of every page inside a
 * tabbed nav group (Modullar, Ma'lumotnoma). Each tab is a NavLink
 * that drives an `aria-selected` state from React Router so screen
 * readers and keyboard users see the active section.
 *
 * Items are RBAC-filtered against the active user's role — exactly
 * the same filter the sidebar uses, so the two stay in sync.
 */
export function PageTabs({ group }: PageTabsProps) {
  const { user } = useAuth();
  const location = useLocation();
  const section = NAV_SECTIONS.find((s) => s.key === group);
  if (!section || !user) return null;

  const items = section.items.filter((item) => item.roles.includes(user.role));
  if (items.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label={section.label}
      data-testid="page-tabs"
      className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-border px-4 pb-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      {items.map((item) => {
        const hasChildTab = items.some(
          (other) => other !== item && other.path.startsWith(`${item.path}/`),
        );
        const isActive =
          location.pathname === item.path ||
          (!hasChildTab && location.pathname.startsWith(`${item.path}/`));
        const tabKey = item.path.replace(/^\//, '');
        const Icon = item.icon;
        return (
          <NavLink
            key={item.path}
            to={item.path}
            role="tab"
            aria-selected={isActive}
            data-testid={`page-tab-${tabKey}`}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            {item.label}
          </NavLink>
        );
      })}
    </div>
  );
}
