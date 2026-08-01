import type { QueryExample } from '../../core/types';

export const pharmaQueryExamples: QueryExample[] = [
  {
    id: 'pha-readiness',
    question: 'Is manufacturing Line 2 ready for the next batch of Product PX-200?',
    category: 'Readiness',
  },
  {
    id: 'pha-unresolved',
    question: 'Which deviations or CAPAs remain unresolved?',
    category: 'Outstanding Items',
  },
  {
    id: 'pha-cleaning',
    question: 'What cleaning and validation evidence is required before changeover?',
    category: 'Validation',
  },
  {
    id: 'pha-conflict',
    question: 'Are there conflicting SOP revisions for equipment cleaning?',
    category: 'Conflicts',
  },
  {
    id: 'pha-verify',
    question: 'What information must quality personnel verify before release?',
    category: 'Gaps',
  },
  {
    id: 'pha-change-control',
    question: 'Are there open change controls affecting Line 2 equipment qualification?',
    category: 'Change Control',
  },
];
