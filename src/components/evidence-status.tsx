'use client';

import { cn } from '@/lib/utils';
import type { EvidenceStatus } from '@/core/types';
import type { EvidenceSupport } from '@/core/citations/validate';

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
  { label: string; meaning: string; text: string; bg: string; border: string; dot: string }
> = {
  SUPPORTED: {
    label: 'Supported',
    meaning: 'The cited evidence directly answers the question. This is not an approval.',
    text: 'text-[var(--color-supported)]',
    bg: 'bg-[var(--color-supported-bg)]',
    border: 'border-[var(--color-supported-border)]',
    dot: 'bg-[var(--color-supported)]',
  },
  PARTIALLY_SUPPORTED: {
    label: 'Partially supported',
    meaning: 'Some of the question is evidenced; material elements are missing or indirect.',
    text: 'text-[var(--color-partial)]',
    bg: 'bg-[var(--color-partial-bg)]',
    border: 'border-[var(--color-partial-border)]',
    dot: 'bg-[var(--color-partial)]',
  },
  CONFLICTING_EVIDENCE: {
    label: 'Conflicting evidence',
    meaning: 'Sources disagree and none is clearly authoritative. Resolve before acting.',
    text: 'text-[var(--color-conflicting)]',
    bg: 'bg-[var(--color-conflicting-bg)]',
    border: 'border-[var(--color-conflicting-border)]',
    dot: 'bg-[var(--color-conflicting)]',
  },
  INSUFFICIENT_EVIDENCE: {
    label: 'Insufficient evidence',
    meaning: 'The corpus does not meaningfully address this question. Nothing can be concluded.',
    text: 'text-[var(--color-insufficient)]',
    bg: 'bg-[var(--color-insufficient-bg)]',
    border: 'border-[var(--color-insufficient-border)]',
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
        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold',
        meta.bg,
        meta.text,
        meta.border,
        className
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-lg font-semibold leading-none tabular-nums">{value}</span>
      <span className="mt-1 text-[11px] leading-tight opacity-70">{label}</span>
    </div>
  );
}

const SUPPORT_LABEL: Record<EvidenceSupport['label'], string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
  none: 'None',
};

export function EvidenceStatusPanel({
  status,
  claimedStatus,
  evidenceSupport,
  citationCount,
  retrievedCount,
}: {
  status: EvidenceStatus;
  claimedStatus?: EvidenceStatus;
  evidenceSupport: EvidenceSupport;
  citationCount: number;
  retrievedCount: number;
}) {
  const meta = STATUS_META[status];
  const wasAdjusted = claimedStatus && claimedStatus !== status;

  return (
    <div className={cn('rounded-xl border p-5', meta.bg, meta.text, meta.border)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <EvidenceStatusBadge status={status} className="bg-[var(--color-surface)]/60" />
          <p className="mt-2.5 max-w-xl text-[13px] leading-relaxed opacity-90">{meta.meaning}</p>
        </div>

        <div className="flex shrink-0 gap-6 pt-1">
          <Metric
            value={String(citationCount)}
            label={`verified\ncitation${citationCount === 1 ? '' : 's'}`}
          />
          <Metric value={String(retrievedCount)} label={'chunks\nretrieved'} />
          {/* Counted from what survived validation, not reported by the model.
              A model's self-assessed confidence is uncalibrated, and showing
              one invites it to be read as a measurement. */}
          <Metric
            value={SUPPORT_LABEL[evidenceSupport.label]}
            label={
              evidenceSupport.claimed > 0
                ? `evidence support\n${evidenceSupport.verified}/${evidenceSupport.claimed} verified · ${evidenceSupport.documents} source${evidenceSupport.documents === 1 ? '' : 's'}`
                : 'evidence support'
            }
          />
        </div>
      </div>

      {wasAdjusted && (
        <div className="mt-4 flex items-start gap-2.5 border-t border-current/15 pt-3.5">
          <span className="mt-px shrink-0 rounded bg-[var(--color-surface)]/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            adjusted
          </span>
          <p className="text-[12.5px] leading-relaxed opacity-90">
            The model proposed <strong>{STATUS_META[claimedStatus].label}</strong>. Every quote was
            checked against the evidence actually retrieved, and the status was capped by what
            survived.
          </p>
        </div>
      )}
    </div>
  );
}

export { STATUS_META };
