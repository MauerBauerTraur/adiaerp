import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Minimal sidebar primitives for the Faza-1 layout shell.
 * A full collapsible sidebar can replace these in a later sprint.
 */

const Sidebar = React.forwardRef<
  HTMLElement,
  React.HTMLAttributes<HTMLElement>
>(({ className, ...props }, ref) => (
  <aside
    ref={ref}
    className={cn(
      'fixed inset-y-0 left-0 z-30 hidden h-screen w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex',
      className,
    )}
    {...props}
  />
));
Sidebar.displayName = 'Sidebar';

const SidebarHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'flex h-16 items-center gap-2 border-b border-sidebar-border px-5',
      className,
    )}
    {...props}
  />
));
SidebarHeader.displayName = 'SidebarHeader';

const SidebarContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <nav
    ref={ref}
    aria-label="Asosiy navigatsiya"
    className={cn('flex flex-1 flex-col gap-1 overflow-y-auto p-3', className)}
    {...props}
  />
));
SidebarContent.displayName = 'SidebarContent';

const SidebarFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('border-t border-sidebar-border p-3', className)}
    {...props}
  />
));
SidebarFooter.displayName = 'SidebarFooter';

const SidebarSectionLabel = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground',
      className,
    )}
    {...props}
  />
));
SidebarSectionLabel.displayName = 'SidebarSectionLabel';

export {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarSectionLabel,
};
