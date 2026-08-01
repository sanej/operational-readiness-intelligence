'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, FileText, TriangleAlert, CircleHelp, ShieldCheck } from 'lucide-react';
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

  return <div className="ori-prose text-sm">{blocks}</div>;
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

function Section({
  title,
  icon,
  tone = 'default',
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  tone?: 'default' | 'warning' | 'conflict' | 'action';
  children: React.ReactNode;
}) {
  const toneClass = {
    default: 'border-border bg-card',
    warning: 'border-[var(--color-partial)]/30 bg-[var(--color-partial-bg)]',
    conflict: 'border-[var(--color-conflicting)]/30 bg-[var(--color-conflicting-bg)]',
    action: 'border-primary/25 bg-accent',
  }[tone];

  return (
    <div className={cn('rounded-lg border p-4', toneClass)}>
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  const provenance = [citation.revision, citation.section, citation.pageNumber ? `p.${citation.pageNumber}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <li className="rounded-md border border-border bg-card p-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{citation.documentTitle ?? citation.documentId}</p>
          {provenance && <p className="mt-0.5 text-xs text-muted-foreground">{provenance}</p>}
          <blockquote className="mt-2 border-l-2 border-primary/40 pl-2.5 text-xs italic leading-relaxed text-muted-foreground">
            &ldquo;{citation.citedContent}&rdquo;
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
        className="flex w-full items-start gap-2 py-2 text-left hover:bg-muted/50"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs font-medium">{chunk.documentTitle ?? chunk.documentId}</span>
            {cited && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                cited
              </span>
            )}
            {chunk.documentStatus && chunk.documentStatus !== 'active' && (
              <span className="rounded bg-[var(--color-partial-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-partial)]">
                {chunk.documentStatus}
              </span>
            )}
          </span>
          {provenance && (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{provenance}</span>
          )}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {chunk.adjustedScore.toFixed(3)}
        </span>
      </button>

      {open && (
        <div className="pb-3 pl-6 pr-2">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/50 p-2.5 text-[11px] leading-relaxed">
            {chunk.content}
          </pre>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            similarity {chunk.score.toFixed(4)} · after authority ranking{' '}
            {chunk.adjustedScore.toFixed(4)}
            {chunk.effectiveDate ? ` · effective ${chunk.effectiveDate}` : ''}
          </p>
        </div>
      )}
    </li>
  );
}

function ConflictCard({ conflict }: { conflict: EvidenceConflict }) {
  return (
    <li className="text-xs leading-relaxed">
      <span className="mr-1.5 rounded bg-[var(--color-conflicting)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
        {conflict.kind === 'revision' ? 'revision' : 'content'}
      </span>
      {conflict.description}
    </li>
  );
}

export function AnswerPanel({ answer }: { answer: GroundedAnswer }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const citedChunkIds = new Set(answer.citations.map((c) => c.chunkId));

  return (
    <div className="space-y-4">
      <EvidenceStatusPanel
        status={answer.evidenceStatus}
        claimedStatus={answer.claimedStatus}
        confidence={answer.confidence}
        citationCount={answer.citations.length}
        retrievedCount={answer.retrievedChunks.length}
      />

      <div className="rounded-lg border border-border bg-card p-5">
        <AnswerProse text={answer.answer} />
      </div>

      {answer.conflicts.length > 0 && (
        <Section
          title={`Conflicting evidence (${answer.conflicts.length})`}
          icon={<TriangleAlert className="h-3.5 w-3.5" />}
          tone="conflict"
        >
          <ul className="space-y-2">
            {answer.conflicts.map((conflict, i) => (
              <ConflictCard key={i} conflict={conflict} />
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
          <ul className="space-y-1.5">
            {answer.missingEvidence.map((item, i) => (
              <li key={i} className="text-xs leading-relaxed">
                • {item}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {answer.verificationRequired.length > 0 && (
        <Section
          title="Must be verified by a qualified person"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          tone="action"
        >
          <ul className="space-y-1.5">
            {answer.verificationRequired.map((item, i) => (
              <li key={i} className="text-xs leading-relaxed">
                • {item}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {answer.citations.length > 0 && (
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <FileText className="h-3.5 w-3.5" />
            Citations ({answer.citations.length})
          </h3>
          <ul className="space-y-2">
            {answer.citations.map((citation, i) => (
              <CitationCard key={citation.id} citation={citation} index={i} />
            ))}
          </ul>
        </div>
      )}

      {answer.warnings.length > 0 && (
        <Section title="Validation notes" icon={<TriangleAlert className="h-3.5 w-3.5" />} tone="warning">
          <ul className="space-y-1.5">
            {answer.warnings.map((warning, i) => (
              <li key={i} className="text-xs leading-relaxed">
                • {warning}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {answer.retrievedChunks.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="flex w-full items-center gap-2 p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-muted/50"
            aria-expanded={showEvidence}
          >
            {showEvidence ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Retrieved evidence ({answer.retrievedChunks.length})
            <span className="ml-auto font-normal normal-case tracking-normal">
              including {answer.retrievedChunks.length - citedChunkIds.size} not cited
            </span>
          </button>

          {showEvidence && (
            <ul className="border-t border-border px-3">
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

      <p className="text-[11px] text-muted-foreground">
        {answer.timings.totalMs} ms total · retrieval {answer.timings.retrievalMs} ms · generation{' '}
        {answer.timings.generationMs} ms
        {answer.usage?.promptTokens
          ? ` · ${answer.usage.promptTokens} prompt + ${answer.usage.completionTokens ?? 0} completion tokens`
          : ''}{' '}
        · {answer.model}
      </p>
    </div>
  );
}
