// Pharmaceutical manufacturing document metadata.
//
// Note what differs from industrial: batch/lot, validation status, and
// approval status are first-class here, because in a GMP setting the state of
// a document's approval is itself the evidence a reviewer needs. Strict mode
// again — an unrecognised field is a mistake, not an extension point.

import { z } from 'zod';

export const PHARMA_DOCUMENT_TYPES = [
  'sop',
  'batch_manufacturing_record',
  'cleaning_procedure',
  'deviation',
  'capa',
  'validation_protocol',
  'change_control',
  'inspection_finding',
  'quality_requirement',
  'analytical_method',
] as const;

export const pharmaMetadataSchema = z
  .object({
    // -- shared, promoted to columns by the pipeline ------------------------
    title: z.string().min(1),
    // Optional so an ad-hoc upload can be ingested without first being
    // classified. The vocabulary stays strict: a value outside this list is
    // still rejected. An untyped document is excluded from revision-conflict
    // grouping and authority ranking, which both key on document type.
    documentType: z.enum(PHARMA_DOCUMENT_TYPES).optional(),
    revision: z.string().optional(),
    effectiveDate: z.string().optional(),
    authority: z.string().optional(),
    status: z.enum(['active', 'superseded', 'draft', 'withdrawn']).default('active'),
    supersededBy: z.string().optional(),

    // -- pharma-specific -----------------------------------------------------
    site: z.string().optional(),
    product: z.string().optional(),
    productCode: z.string().optional(),
    batchNumber: z.string().optional(),
    equipmentId: z.string().optional(),
    line: z.string().optional(),
    sopNumber: z.string().optional(),
    deviationId: z.string().optional(),
    capaId: z.string().optional(),
    changeControlId: z.string().optional(),
    validationStatus: z
      .enum(['validated', 'qualification_in_progress', 'not_validated', 'revalidation_due'])
      .optional(),
    /** Document approval state — distinct from lifecycle `status`. */
    approvalStatus: z.enum(['approved', 'pending_approval', 'rejected']).optional(),
    /** Open / closed state for deviations and CAPAs. */
    actionStatus: z.enum(['open', 'in_progress', 'closed', 'overdue']).optional(),
    dueDate: z.string().optional(),
    severity: z.string().optional(),
    reference: z.string().optional(),
  })
  .strict();

export type PharmaMetadata = z.infer<typeof pharmaMetadataSchema>;
