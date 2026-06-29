import { Fragment, type ReactNode } from 'react';

/**
 * Tiny safe markdown renderer for assistant responses.
 *
 * We intentionally avoid pulling in `react-markdown` + `remark` (~80kB) for
 * Faza-2 — the model output we display is short (1-2 paragraphs, occasional
 * bullet list or `**bold**`) and a controlled subset keeps the bundle lean.
 *
 * Supported:
 *  - paragraphs (blank-line separated)
 *  - unordered lists (`- item` lines)
 *  - inline `**bold**` and `` `code` ``
 *  - fenced ```code blocks``` (rendered as <pre>)
 *
 * Crucially, ALL content is passed through React text nodes — no
 * `dangerouslySetInnerHTML` — so injected `<script>` or `<img onerror>` in
 * a model response (prompt-leak scenario) is rendered as plain text, not
 * executed.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-foreground">
      {blocks.map((block, idx) => (
        <Fragment key={idx}>{renderBlock(block)}</Fragment>
      ))}
    </div>
  );
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'code'; text: string };

function parseBlocks(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      // Fenced code block
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      // Skip closing fence
      if (i < lines.length) i++;
      blocks.push({ type: 'code', text: buf.join('\n') });
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*-\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Gather a paragraph
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^\s*-\s+/.test(lines[i] ?? '') &&
      !(lines[i] ?? '').startsWith('```')
    ) {
      buf.push(lines[i] ?? '');
      i++;
    }
    blocks.push({ type: 'p', text: buf.join(' ') });
  }
  return blocks;
}

function renderBlock(block: Block): ReactNode {
  if (block.type === 'code') {
    return (
      <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 p-3 text-xs">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.type === 'ul') {
    return (
      <ul className="list-disc space-y-1 pl-5">
        {block.items.map((item, idx) => (
          <li key={idx}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  return <p>{renderInline(block.text)}</p>;
}

/**
 * Inline pass: `**bold**` and `` `code` ``. We tokenise rather than regex-
 * replace into HTML so React handles escaping for us.
 */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/;
  while (rest.length > 0) {
    const match = tokenRe.exec(rest);
    if (!match) {
      out.push(rest);
      break;
    }
    const idx = match.index;
    if (idx > 0) out.push(rest.slice(0, idx));
    const token = match[0];
    if (token.startsWith('**')) {
      out.push(
        <strong key={key++} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(
        <code
          key={key++}
          className="rounded-sm bg-muted px-1 py-0.5 text-xs font-mono"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    rest = rest.slice(idx + token.length);
  }
  return out;
}
