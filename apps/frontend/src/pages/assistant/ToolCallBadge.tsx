import { Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssistantToolCall } from '@/lib/types';

/**
 * Human-readable Uzbek label for each Faza-2 read-only AI tool.
 * Keep the map exhaustive against ADR-0006 §2 (the 6 tool names) so the
 * UI doesn't fall back to a raw `get_stock` identifier in production.
 * Unknown tool names (e.g. a Faza-3 write tool added later) gracefully
 * render as the bare name — visible but not branded.
 */
const TOOL_LABELS: Record<string, string> = {
  get_stock: 'Ostatka',
  get_below_min: 'Min’dan past',
  get_open_requests: 'Ochiq so‘rovlar',
  get_production_plan: 'Ishlab chiqarish rejasi',
  get_recent_movements: 'Oxirgi harakatlar',
  get_sales_summary: 'Sotuv',
};

/**
 * A small teal/info-tone chip rendered under an assistant message for every
 * tool the model invoked. Surfacing tool calls makes the AI’s reasoning
 * traceable — the user sees that "Markaziy skladda nima qizil holatda?"
 * actually called `get_below_min(location_id=…)` (transparency, ADR-0006 §5).
 */
export function ToolCallBadge({
  call,
  className,
}: {
  call: AssistantToolCall;
  className?: string;
}) {
  const label = TOOL_LABELS[call.tool_name] ?? call.tool_name;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info/10 px-2.5 py-1 text-xs font-medium text-info',
        className,
      )}
      title={`${call.tool_name} · ${call.result_summary}`}
    >
      <Wrench className="size-3" aria-hidden="true" />
      <span>Asbob: {label}</span>
      {call.result_summary && (
        <span className="text-info/70">· {call.result_summary}</span>
      )}
    </span>
  );
}

/** Stack of ToolCallBadge chips. Hidden when `calls` is empty. */
export function ToolCallList({
  calls,
  className,
}: {
  calls: AssistantToolCall[];
  className?: string;
}) {
  if (calls.length === 0) return null;
  return (
    <div
      className={cn('flex flex-wrap gap-1.5', className)}
      data-testid="tool-call-list"
    >
      {calls.map((call, idx) => (
        <ToolCallBadge key={`${call.tool_name}-${idx}`} call={call} />
      ))}
    </div>
  );
}
