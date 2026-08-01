'use client';

import { FileText, CircleAlert, Loader2, ScanLine } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DocumentSummary {
  id: string;
  fileName: string;
  title: string;
  documentType: string | null;
  revision: string | null;
  effectiveDate: string | null;
  docStatus: string | null;
  extractionMethod: string;
  pageCount: number | null;
  chunkCount: number;
  status: string;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
}

const STATUS_STYLE: Record<string, string> = {
  indexed: 'bg-[var(--color-supported-bg)] text-[var(--color-supported)]',
  processing: 'bg-[var(--color-partial-bg)] text-[var(--color-partial)]',
  pending: 'bg-muted text-muted-foreground',
  failed: 'bg-destructive-subtle text-destructive',
};

function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        className
      )}
    >
      {children}
    </span>
  );
}

export function DocumentList({
  documents,
  loading,
  error,
}: {
  documents: DocumentSummary[];
  loading: boolean;
  error?: string;
}) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading documents">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="animate-ori-pulse rounded-lg border border-border bg-surface p-3"
          >
            <div className="h-3 w-2/3 rounded bg-muted" />
            <div className="mt-2 h-2.5 w-2/5 rounded bg-muted" />
            <div className="mt-2.5 h-4 w-16 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/25 bg-destructive-subtle p-4">
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-destructive">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </p>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong px-4 py-8 text-center">
        <FileText className="mx-auto h-6 w-6 text-muted-foreground/40" />
        <p className="mt-3 text-[13px] font-medium">No documents yet</p>
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          Upload files above, or run
        </p>
        <code className="mt-2 inline-block rounded bg-muted px-2 py-1 text-[11px]">
          npm run ingest -- ./sample-documents/industrial
        </code>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {documents.map((doc) => {
        const meta = [doc.documentType?.replace(/_/g, ' '), doc.revision, doc.effectiveDate]
          .filter(Boolean)
          .join(' · ');

        return (
          <li
            key={doc.id}
            className="rounded-lg border border-border bg-surface p-3 transition-colors hover:border-border-strong"
          >
            <div className="flex items-start gap-2.5">
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium leading-snug" title={doc.title}>
                  {doc.title}
                </p>
                {meta && (
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Pill className={STATUS_STYLE[doc.status] ?? STATUS_STYLE.pending}>
                    {doc.status === 'processing' && (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    )}
                    {doc.status}
                  </Pill>
                  <span className="text-[10.5px] tabular-nums text-muted-foreground">
                    {doc.chunkCount} chunk{doc.chunkCount === 1 ? '' : 's'}
                  </span>
                  {doc.extractionMethod === 'ocr' && (
                    <Pill className="bg-primary/12 text-primary">
                      <ScanLine className="h-2.5 w-2.5" />
                      OCR
                    </Pill>
                  )}
                  {doc.docStatus && doc.docStatus !== 'active' && (
                    <Pill className="bg-[var(--color-partial-bg)] text-[var(--color-partial)]">
                      {doc.docStatus}
                    </Pill>
                  )}
                </div>
                {doc.errorMessage && (
                  <p className="mt-2 text-[11px] leading-relaxed text-destructive">
                    {doc.errorMessage}
                  </p>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
