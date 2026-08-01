'use client';

import { cn } from '@/lib/utils';
import type { EvidenceStatus } from '@/core/types';

/**
 * Presentation for the four evidence statuses.
 *
 * The `meaning` line matters as much as the colour: "SUPPORTED" alone invites
 * being read as "approved", which is exactly the inference ORI must not
 * license. Every badge carries a plain-language statement of what the status
 * does and does not claim.
 */
const STATUS_META: Record<
  EvidenceStatus,
  { label: string; meaning: string; className: string; dot: string }
> = {
  SUPPORTED: {
    label: 'Supported',
    meaning: 'The cited evidence directly answers the question. It does not constitute approval.',
    className: 'bg-[var(--color-supported-bg)] text-[var(--color-supported)] border-[var(--color-supported)]/25',
    dot: 'bg-[var(--color-supported)]',
  },
  PARTIALLY_SUPPORTED: {
    label: 'Partially supported',
    meaning: 'Some of the question is evidenced; material elements are missing or indirect.',
    className: 'bg-[var(--color-partial-bg)] text-[var(--color-partial)] border-[var(--color-partial)]/25',
    dot: 'bg-[var(--color-partial)]',
  },
  CONFLICTING_EVIDENCE: {
    label: 'Conflicting evidence',
    meaning: 'Sources disagree and none is clearly authoritative. Resolve before acting.',
    className: 'bg-[var(--color-conflicting-bg)] text-[var(--color-conflicting)] border-[var(--color-conflicting)]/25',
    dot: 'bg-[var(--color-conflicting)]',
  },
  INSUFFICIENT_EVIDENCE: {
    label: 'Insufficient evidence',
    meaning: 'The corpus does not meaningfully address this question. Nothing can be concluded.',
    className: 'bg-[var(--color-insufficient-bg)] text-[var(--color-insufficient)] border-[var(--color-insufficient)]/25',
    dot: 'bg-[var(--color-insufficient)]',
  },
};

export function EvidenceStatusBadge({
  status,
  className,
}: {
  status: EvidenceStatus;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
        meta.className,
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

export function EvidenceStatusPanel({
  status,
  claimedStatus,
  confidence,
  citationCount,
  retrievedCount,
}: {
  status: EvidenceStatus;
  claimedStatus?: EvidenceStatus;
  confidence: number;
  citationCount: number;
  retrievedCount: number;
}) {
  const meta = STATUS_META[status];
  const wasAdjusted = claimedStatus && claimedStatus !== status;

  return (
    <div className={cn('rounded-lg border p-4', meta.className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <EvidenceStatusBadge status={status} />
        <span className="text-xs opacity-80">
          {citationCount} verified citation{citationCount === 1 ? '' : 's'} · {retrievedCount}{' '}
          chunk{retrievedCount === 1 ? '' : 's'} retrieved · confidence {confidence.toFixed(2)}
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed opacity-90">{meta.meaning}</p>

      {wasAdjusted && (
        <p className="mt-2 border-t border-current/15 pt-2 text-xs opacity-80">
          The model proposed <strong>{STATUS_META[claimedStatus].label}</strong>. Citation
          validation adjusted it — every quote is checked against the evidence actually
          retrieved, and the status is capped by what survived.
        </p>
      )}
    </div>
  );
}

export { STATUS_META };
