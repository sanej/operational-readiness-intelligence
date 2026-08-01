'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  FileText,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { EvidenceStatusPanel } from './evidence-status';
import type { Citation, EvidenceConflict, GroundedAnswer, RetrievedChunk } from '@/core/types';

/**
 * Render the model's lightly-marked-up answer.
 *
 * A full Markdown renderer would be a dependency and an XSS surface for what
 * amounts to headings, bullets, and bold. This handles exactly the subset the
 * prompt asks for, and escapes everything else by going through React text
 * nodes rather than dangerouslySetInnerHTML.
 */
function AnswerProse({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');

  let listBuffer: string[] = [];
  let paragraphBuffer: string[] = [];

  const flushList = (key: string) => {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={key}>
        {listBuffer.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>
    );
    listBuffer = [];
  };

  const flushParagraph = (key: string) => {
    if (paragraphBuffer.length === 0) return;
    blocks.push(<p key={key}>{inline(paragraphBuffer.join(' '))}</p>);
    paragraphBuffer = [];
  };

  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    const key = `b${index}`;

    if (!line.trim()) {
      flushList(`${key}-l`);
      flushParagraph(`${key}-p`);
      return;
    }

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushList(`${key}-l`);
      flushParagraph(`${key}-p`);
      const level = heading[1].length;
      const content = inline(heading[2]);
      blocks.push(level <= 2 ? <h2 key={key}>{content}</h2> : <h3 key={key}>{content}</h3>);
      return;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line) ?? /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph(`${key}-p`);
      listBuffer.push(bullet[1]);
      return;
    }

    flushList(`${key}-l`);
    paragraphBuffer.push(line.trim());
  });

  flushList('final-l');
  flushParagraph('final-p');

  return <div className="ori-prose text-[14px]">{blocks}</div>;
}

/** Bold spans only; everything else stays literal text. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

type Tone = 'default' | 'warning' | 'conflict' | 'action';

const TONES: Record<Tone, { wrap: string; icon: string; head: string }> = {
  default: {
    wrap: 'border-border bg-surface',
    icon: 'bg-muted text-muted-foreground',
    head: 'text-foreground',
  },
  warning: {
    wrap: 'border-[var(--color-partial-border)] bg-[var(--color-partial-bg)]',
    icon: 'bg-[var(--color-partial)]/15 text-[var(--color-partial)]',
    head: 'text-[var(--color-partial)]',
  },
  conflict: {
    wrap: 'border-[var(--color-conflicting-border)] bg-[var(--color-conflicting-bg)]',
    icon: 'bg-[var(--color-conflicting)]/15 text-[var(--color-conflicting)]',
    head: 'text-[var(--color-conflicting)]',
  },
  action: {
    wrap: 'border-primary-border bg-primary-subtle',
    icon: 'bg-primary/15 text-primary',
    head: 'text-primary',
  },
};

function Section({
  title,
  icon,
  tone = 'default',
  children,
}: {
  title: string;
  icon: React.ReactNode;
  tone?: Tone;
  children: React.ReactNode;
}) {
  const t = TONES[tone];
  return (
    <section className={cn('rounded-xl border p-5', t.wrap)}>
      <h3 className={cn('mb-3 flex items-center gap-2.5 text-[13px] font-semibold', t.head)}>
        <span className={cn('flex h-6 w-6 items-center justify-center rounded-md', t.icon)}>
          {icon}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed">
          <span className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-current opacity-45" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Strip source Markdown from a quoted passage.
 *
 * Quotes are verbatim by design — that is what makes them checkable against
 * the retrieved chunk — so when the source is Markdown the quote carries its
 * `##` headings and `**` emphasis along with it. Correct data, poor reading.
 * Only presentation markers are removed; every word is left intact, so the
 * displayed quote still corresponds to the text that was verified.
 */
function tidyQuote(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  const provenance = [
    citation.revision,
    citation.section,
    citation.pageNumber ? `p.${citation.pageNumber}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold leading-snug">
            {citation.documentTitle ?? citation.documentId}
          </p>
          {provenance && (
            <p className="mt-1 text-[11.5px] text-muted-foreground">{provenance}</p>
          )}
          <blockquote className="mt-2.5 border-l-2 border-primary/45 pl-3 text-[12.5px] italic leading-relaxed text-muted-foreground">
            &ldquo;{tidyQuote(citation.citedContent)}&rdquo;
          </blockquote>
        </div>
      </div>
    </li>
  );
}

function RetrievedChunkRow({ chunk, cited }: { chunk: RetrievedChunk; cited: boolean }) {
  const [open, setOpen] = useState(false);

  const provenance = [chunk.revision, chunk.provenance.headingPath ?? chunk.provenance.section]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-muted"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12.5px] font-medium">
              {chunk.documentTitle ?? chunk.documentId}
            </span>
            {cited && (
              <span className="rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                cited
              </span>
            )}
            {chunk.documentStatus && chunk.documentStatus !== 'active' && (
              <span className="rounded bg-[var(--color-partial)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-partial)]">
                {chunk.documentStatus}
              </span>
            )}
          </span>
          {provenance && (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              {provenance}
            </span>
          )}
        </span>
        <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
          {chunk.adjustedScore.toFixed(3)}
        </span>
      </button>

      {open && (
        <div className="animate-ori-rise px-4 pb-4 pl-10">
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-sunken p-3.5 text-[11.5px] leading-relaxed">
            {chunk.content}
          </pre>
          <p className="mt-2 text-[10.5px] text-muted-foreground">
            similarity {chunk.score.toFixed(4)} · after authority ranking{' '}
            {chunk.adjustedScore.toFixed(4)}
            {chunk.effectiveDate ? ` · effective ${chunk.effectiveDate}` : ''}
          </p>
        </div>
      )}
    </li>
  );
}

function ConflictItem({ conflict }: { conflict: EvidenceConflict }) {
  return (
    <li className="flex gap-2.5 text-[13px] leading-relaxed">
      <span className="mt-px shrink-0 rounded bg-current/12 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
        {conflict.kind === 'revision' ? 'revision' : 'content'}
      </span>
      <span>{conflict.description}</span>
    </li>
  );
}

export function AnswerPanel({ answer }: { answer: GroundedAnswer }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const citedChunkIds = new Set(answer.citations.map((c) => c.chunkId));
  const uncited = answer.retrievedChunks.length - citedChunkIds.size;

  return (
    <div className="animate-ori-rise space-y-4">
      <EvidenceStatusPanel
        status={answer.evidenceStatus}
        claimedStatus={answer.claimedStatus}
        confidence={answer.confidence}
        citationCount={answer.citations.length}
        retrievedCount={answer.retrievedChunks.length}
      />

      <div className="rounded-xl border border-border bg-surface p-6">
        <AnswerProse text={answer.answer} />
      </div>

      {answer.conflicts.length > 0 && (
        <Section
          title={`Conflicting evidence (${answer.conflicts.length})`}
          icon={<TriangleAlert className="h-3.5 w-3.5" />}
          tone="conflict"
        >
          <ul className="space-y-2.5">
            {answer.conflicts.map((conflict, i) => (
              <ConflictItem key={i} conflict={conflict} />
            ))}
          </ul>
        </Section>
      )}

      {answer.missingEvidence.length > 0 && (
        <Section
          title="Missing evidence"
          icon={<CircleHelp className="h-3.5 w-3.5" />}
          tone="warning"
        >
          <BulletList items={answer.missingEvidence} />
        </Section>
      )}

      {answer.verificationRequired.length > 0 && (
        <Section
          title="Must be verified by a qualified person"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          tone="action"
        >
          <BulletList items={answer.verificationRequired} />
        </Section>
      )}

      {answer.citations.length > 0 && (
        <div>
          <h3 className="mb-3 flex items-center gap-2.5 text-[13px] font-semibold">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/12 text-primary">
              <FileText className="h-3.5 w-3.5" />
            </span>
            Citations
            <span className="text-muted-foreground">({answer.citations.length} verified)</span>
          </h3>
          <ul className="space-y-2.5">
            {answer.citations.map((citation, i) => (
              <CitationCard key={citation.id} citation={citation} index={i} />
            ))}
          </ul>
        </div>
      )}

      {answer.warnings.length > 0 && (
        <Section
          title="Validation notes"
          icon={<TriangleAlert className="h-3.5 w-3.5" />}
          tone="warning"
        >
          <BulletList items={answer.warnings} />
        </Section>
      )}

      {answer.retrievedChunks.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition-colors hover:bg-muted"
            aria-expanded={showEvidence}
          >
            {showEvidence ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="text-[13px] font-semibold">Retrieved evidence</span>
            <span className="text-[12px] text-muted-foreground">
              {answer.retrievedChunks.length} chunks
              {uncited > 0 ? ` · ${uncited} not cited` : ''}
            </span>
          </button>

          {showEvidence && (
            <ul className="border-t border-border">
              {answer.retrievedChunks.map((chunk) => (
                <RetrievedChunkRow
                  key={chunk.chunkId}
                  chunk={chunk}
                  cited={citedChunkIds.has(chunk.chunkId)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" />
        <span className="tabular-nums">{(answer.timings.totalMs / 1000).toFixed(1)}s total</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">retrieval {answer.timings.retrievalMs} ms</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">generation {answer.timings.generationMs} ms</span>
        {answer.usage?.promptTokens && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {answer.usage.promptTokens} + {answer.usage.completionTokens ?? 0} tokens
            </span>
          </>
        )}
        <span aria-hidden>·</span>
        <span>{answer.model}</span>
      </p>
    </div>
  );
}
