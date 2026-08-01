// Pharmaceutical manufacturing domain pack.
//
// Adding this domain required no change to src/core. It is five files
// satisfying the DomainPack contract — which is the composability claim the
// architecture is making, made checkable.

import type { DomainPack } from '../../core/types';
import { pharmaMetadataSchema } from './metadata-schema';
import { pharmaSystemPrompt } from './system-prompt';
import { pharmaQueryExamples } from './query-examples';

export const pharmaPack: DomainPack = {
  id: 'pharma',
  displayName: 'Pharmaceutical Manufacturing',
  description:
    'SOPs, batch records, cleaning procedures, deviations, CAPAs, validation protocols, ' +
    'and change controls for GMP manufacturing.',

  documentTypes: [
    { id: 'sop', label: 'Standard Operating Procedure', description: 'Controlled procedure governing an operation' },
    { id: 'batch_manufacturing_record', label: 'Batch Manufacturing Record', description: 'Executed record for a specific batch' },
    { id: 'cleaning_procedure', label: 'Cleaning Procedure', description: 'Equipment cleaning and changeover instructions' },
    { id: 'deviation', label: 'Deviation', description: 'A departure from an approved procedure or specification' },
    { id: 'capa', label: 'CAPA Record', description: 'Corrective and preventive action arising from an issue' },
    { id: 'validation_protocol', label: 'Validation Protocol', description: 'Cleaning, process, or equipment qualification' },
    { id: 'change_control', label: 'Change Control', description: 'Governed change to equipment, process, or documentation' },
    { id: 'inspection_finding', label: 'Inspection Finding', description: 'Observation from an internal or regulatory inspection' },
    { id: 'quality_requirement', label: 'Quality Requirement', description: 'Manufacturing quality standards and specifications' },
    { id: 'analytical_method', label: 'Analytical Method', description: 'Test method used to assess product or cleaning' },
  ],

  metadataSchema: pharmaMetadataSchema,

  filterableFields: [
    { field: 'site', label: 'Site' },
    { field: 'product', label: 'Product' },
    { field: 'equipmentId', label: 'Equipment ID' },
    { field: 'documentType', label: 'Document Type' },
    { field: 'actionStatus', label: 'Action Status' },
    { field: 'validationStatus', label: 'Validation Status' },
  ],

  terminology: {
    SOP: 'Standard Operating Procedure — a controlled document governing how an operation is performed.',
    BMR: 'Batch Manufacturing Record — the executed record of how a specific batch was made.',
    Deviation: 'A departure from an approved procedure, specification, or standard.',
    CAPA: 'Corrective and Preventive Action — the recorded response to a deviation or finding.',
    'Cleaning Validation': 'Documented evidence that a cleaning procedure reproducibly removes residues to acceptance criteria.',
    'Change Control': 'The governed process for making changes to equipment, process, or documentation.',
    Qualification: 'IQ/OQ/PQ — documented verification that equipment is installed and performs as intended.',
    'Qualified Person': 'The individual legally responsible for certifying a batch before release.',
    GMP: 'Good Manufacturing Practice — the regulatory framework governing pharmaceutical manufacturing.',
  },

  systemPrompt: pharmaSystemPrompt,

  answerStructure: {
    GENERAL_QA: ['Answer', 'Supporting evidence'],

    SYNTHESIS: ['Summary', 'Findings by record', 'Gaps in the record'],

    CONFLICT_CHECK: [
      'Whether the sources agree',
      'What each source states',
      'Which revision is effective',
      'What must be resolved',
    ],

    READINESS_ASSESSMENT: [
      'Summary of what the evidence shows',
      'Supporting evidence and requirements',
      'Open deviations, CAPAs, and change controls',
      'Cleaning and validation status',
      'Conflicting or superseded documents',
      'Missing evidence',
      'What quality personnel must verify before release',
    ],
  },

  queryExamples: pharmaQueryExamples,

  authorityWeights: {
    // Stricter than industrial: acting on a superseded SOP in a GMP setting is
    // itself a deviation, so a stale revision should almost never outrank the
    // current one on similarity alone.
    superseded: 0.35,
    draft: 0.5,
    withdrawn: 0.25,
    mostRecentRevision: 1.2,
    // Additive, and stronger than industrial: an open deviation or overdue
    // CAPA against the equipment is the first thing quality personnel need to
    // see, and omitting it from a release-readiness answer is the costliest
    // possible miss.
    openAction: 0.04,
  },

  // Release-readiness spans the SOP, the batch record, open deviations, the
  // CAPA, the change control, and the validation protocol. Same reasoning as
  // industrial: a narrow top-k silently drops the record that matters most.
  defaultTopK: 12,
};
