import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolCallBadge, ToolCallList } from './ToolCallBadge';
import type { AssistantToolCall } from '@/lib/types';

const stockCall: AssistantToolCall = {
  tool_name: 'get_stock',
  args: { location_id: 5 },
  result_summary: '12 qator',
};

const belowMinCall: AssistantToolCall = {
  tool_name: 'get_below_min',
  args: {},
  result_summary: '3 qizil pozitsiya',
};

describe('ToolCallBadge', () => {
  it('renders the Uzbek label for a known tool', () => {
    render(<ToolCallBadge call={stockCall} />);
    expect(screen.getByText(/Ostatka/)).toBeInTheDocument();
    expect(screen.getByText(/12 qator/)).toBeInTheDocument();
  });

  it('falls back to the raw tool name when unknown', () => {
    render(
      <ToolCallBadge
        call={{
          tool_name: 'create_transfer',
          args: {},
          result_summary: '',
        }}
      />,
    );
    expect(screen.getByText(/create_transfer/)).toBeInTheDocument();
  });
});

describe('ToolCallList', () => {
  it('renders one chip per call in order', () => {
    render(<ToolCallList calls={[stockCall, belowMinCall]} />);
    const wrap = screen.getByTestId('tool-call-list');
    expect(wrap.children).toHaveLength(2);
    expect(wrap.children[0]).toHaveTextContent('Ostatka');
    expect(wrap.children[1]).toHaveTextContent('Min’dan past');
  });

  it('renders nothing when calls are empty', () => {
    const { container } = render(<ToolCallList calls={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
