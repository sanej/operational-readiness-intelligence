// Industrial domain pack.
//
// Everything industry-specific about ORI's default demonstration lives here
// and in the four sibling files. The core pipeline reads this through the
// DomainPack interface and has no knowledge of compressors, permits, or
// isolation.

import type { DomainPack } from '../../core/types';
import { industrialMetadataSchema } from './metadata-schema';
import { industrialSystemPrompt } from './system-prompt';
import { industrialQueryExamples } from './query-examples';

export const industrialPack: DomainPack = {
  id: 'industrial',
  displayName: 'Industrial Operations',
  description:
    'Operating procedures, maintenance manuals, inspection reports, safety procedures, ' +
    'and corrective actions for regulated industrial assets.',

  documentTypes: [
    { id: 'operating_procedure', label: 'Operating Procedure', description: 'How an asset or system is operated' },
    { id: 'maintenance_manual', label: 'Maintenance Manual', description: 'OEM or site maintenance instructions' },
    { id: 'inspection_report', label: 'Inspection Report', description: 'Findings from a scheduled or statutory inspection' },
    { id: 'safety_procedure', label: 'Safety Procedure', description: 'Isolation, permit-to-work, and HSE controls' },
    { id: 'regulatory_requirement', label: 'Regulatory Requirement', description: 'Environmental or statutory obligations' },
    { id: 'shutdown_report', label: 'Shutdown / Turnaround Report', description: 'Outcomes of a previous shutdown' },
    { id: 'corrective_action', label: 'Corrective Action Record', description: 'Actions raised against a finding or failure' },
    { id: 'permit', label: 'Permit', description: 'Work authorisation and its conditions' },
    { id: 'drawing', label: 'Drawing / P&ID', description: 'Engineering drawings and diagrams' },
  ],

  metadataSchema: industrialMetadataSchema,

  filterableFields: [
    { field: 'site', label: 'Site' },
    { field: 'assetId', label: 'Asset ID' },
    { field: 'documentType', label: 'Document Type' },
    { field: 'equipmentType', label: 'Equipment Type' },
    { field: 'actionStatus', label: 'Action Status' },
  ],

  terminology: {
    'Asset ID': 'The unique tag for a piece of equipment, e.g. C-101 for a compressor.',
    LOTO: 'Lock-Out/Tag-Out — physical isolation of energy sources before work.',
    'Permit to Work': 'A formal authorisation defining conditions under which work may proceed.',
    'Corrective Action': 'A recorded action raised to address a defect, finding, or failure.',
    'Turnaround / Shutdown': 'A planned outage during which major maintenance is performed.',
    'Statutory Inspection': 'An inspection required by regulation rather than by site policy.',
    MOC: 'Management of Change — the process governing modifications to plant or procedure.',
  },

  systemPrompt: industrialSystemPrompt,

  answerStructure: [
    'Summary of what the evidence shows',
    'Supporting evidence and requirements',
    'Outstanding items and unresolved actions',
    'Conflicting or superseded documents',
    'Missing evidence',
    'What must be verified by a qualified person before proceeding',
  ],

  queryExamples: industrialQueryExamples,

  authorityWeights: {
    // A superseded procedure describes the same work in almost the same words
    // as its replacement, so similarity alone will surface it. Penalise hard.
    superseded: 0.45,
    draft: 0.7,
    withdrawn: 0.3,
    mostRecentRevision: 1.15,
    // Additive. An open or overdue finding on the asset is decisive for a
    // readiness decision but scores within a few hundredths of routine
    // documentation about the same asset — enough to break that tie, not
    // enough to outrank a clearly more relevant document.
    openAction: 0.03,
  },

  // A readiness question is inherently multi-document: the procedure, the
  // isolation requirements, the open findings, the corrective action, and the
  // spares position all bear on it. Eight chunks is enough for a single-fact
  // lookup but crowds out the corrective action on a synthesis question, which
  // is the omission that matters most.
  defaultTopK: 12,
};
