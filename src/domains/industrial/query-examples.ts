import type { QueryExample } from '../../core/types';

export const industrialQueryExamples: QueryExample[] = [
  {
    id: 'ind-readiness',
    question: 'Is Compressor C-101 ready for planned maintenance?',
    category: 'Readiness',
  },
  {
    id: 'ind-unresolved',
    question: 'Which inspection findings remain unresolved?',
    category: 'Outstanding Items',
  },
  {
    id: 'ind-isolation',
    question: 'What isolation requirements apply before work begins on C-101?',
    category: 'Safety',
  },
  {
    id: 'ind-missing',
    question: 'What evidence is missing before the C-101 overhaul can proceed?',
    category: 'Gaps',
  },
  {
    id: 'ind-conflict',
    question: 'Are there conflicting procedure revisions for compressor isolation?',
    category: 'Conflicts',
  },
  {
    id: 'ind-environmental',
    question: 'What environmental or regulatory requirements apply to venting during the overhaul?',
    category: 'Regulatory',
  },
];
