---
title: DEV-2026-047 Deviation — Clean Hold Time Exceeded, GRN-2100
documentType: deviation
revision: Rev 1
effectiveDate: 2026-05-19
authority: Quality Assurance, Ardley Park Site
status: active
site: Ardley Park
product: Product PX-200
productCode: PX-200
equipmentId: GRN-2100
line: Line 2
deviationId: DEV-2026-047
actionStatus: open
severity: major
reference: DEV-2026-047
---

# DEV-2026-047 Deviation — Clean Hold Time Exceeded, GRN-2100

**Raised:** 2026-05-19 | **Classification:** Major
**Status:** OPEN — investigation in progress
**Equipment:** GRN-2100, Line 2 | **Product affected:** PX-200

> Synthetic document created for demonstration purposes. Fictional site, product,
> and equipment. No patient or personally identifiable information.

## 1. Description

During preparation for batch PX-200-2605, the equipment status label on GRN-2100
was found to show a cleaning completion time of 2026-05-14 14:20. At the point of
discovery on 2026-05-19 08:45, the elapsed clean hold time was **114 hours**.

SOP-CL-004 Rev 3, effective at the time of cleaning, specifies a maximum clean
hold time of 72 hours. The elapsed time therefore exceeded the specified limit by
42 hours.

The batch was **not** started. Manufacturing placed the equipment on hold and
raised this deviation.

## 2. Immediate Action

- Batch PX-200-2605 start was held pending disposition.
- Equipment placed on QA hold; status label changed to "DO NOT USE".
- Bowl and product contact surfaces visually inspected on 2026-05-19. No visible
  residue observed. Photographs retained in the deviation file.

## 3. Complicating Factor — Conflicting Procedure Revisions

The investigation identified that **SOP-CL-004 Rev 4** was issued effective
2026-03-02 and extends the clean hold time to 120 hours. Under Rev 4, the elapsed
114 hours would have been within limit.

However, Rev 4 was issued under change control **CC-2026-011, which remains open**.
The change control has not been closed and the associated retraining has not been
confirmed as complete. It is therefore not established which revision was in force
at the time of the cleaning on 2026-05-14.

**This point is unresolved and is the primary open item in this investigation.**

## 4. Investigation Status — OPEN

| Investigation step | Status |
| --- | --- |
| Determine which SOP revision was in force on 2026-05-14 | **Not complete** |
| Confirm CC-2026-011 status and retraining records | **Not complete** |
| Review hold-time study data supporting the 120-hour limit | **Not complete** |
| Bioburden testing of held equipment | **Not performed** |
| Product impact assessment | **Not complete** |

## 5. Product Impact

No product impact assessment has been completed. No batch has been manufactured
using the equipment in the affected state, so no released product is implicated at
this time.

## 6. CAPA

CAPA **CAPA-2026-019** has been raised against this deviation to address the
document control failure that allowed two revisions of SOP-CL-004 to be
concurrently effective. That CAPA is open.

## 7. Disposition

**No disposition has been made.** The equipment remains on QA hold. The deviation
cannot be closed until the investigation steps in Section 4 are complete and a
product impact assessment has been performed and approved by QA.
