// Industrial document metadata.
//
// Validated on ingestion. Unknown keys are rejected rather than ignored: a
// typo like `assetID` would otherwise be silently stored, produce a filter
// that never matches, and look like a retrieval bug much later.

import { z } from 'zod';

export const INDUSTRIAL_DOCUMENT_TYPES = [
  'operating_procedure',
  'maintenance_manual',
  'inspection_report',
  'safety_procedure',
  'regulatory_requirement',
  'shutdown_report',
  'corrective_action',
  'permit',
  'drawing',
] as const;

export const industrialMetadataSchema = z
  .object({
    // -- shared, promoted to columns by the pipeline ------------------------
    title: z.string().min(1),
    documentType: z.enum(INDUSTRIAL_DOCUMENT_TYPES),
    revision: z.string().optional(),
    effectiveDate: z.string().optional(),
    authority: z.string().optional(),
    status: z.enum(['active', 'superseded', 'draft', 'withdrawn']).default('active'),
    supersededBy: z.string().optional(),

    // -- industrial-specific -------------------------------------------------
    site: z.string().optional(),
    assetId: z.string().optional(),
    equipmentType: z.string().optional(),
    system: z.string().optional(),
    /** Open / closed state for corrective actions and inspection findings. */
    actionStatus: z.enum(['open', 'in_progress', 'closed', 'overdue']).optional(),
    dueDate: z.string().optional(),
    /** Free-form severity, e.g. 'high', 'category 2'. */
    severity: z.string().optional(),
    reference: z.string().optional(),
  })
  .strict();

export type IndustrialMetadata = z.infer<typeof industrialMetadataSchema>;
