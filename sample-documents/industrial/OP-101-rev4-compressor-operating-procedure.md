---
title: OP-101 Centrifugal Compressor C-101 Operating Procedure
documentType: operating_procedure
revision: Rev 4
effectiveDate: 2025-11-03
authority: Operations Engineering, Northfield Terminal
status: active
site: Northfield Terminal
assetId: C-101
equipmentType: centrifugal compressor
system: Gas Compression
reference: OP-101
---

# OP-101 Centrifugal Compressor C-101 Operating Procedure

**Revision:** Rev 4 | **Effective:** 2025-11-03 | **Supersedes:** Rev 3 (2023-06-12)
**Asset:** C-101, Gas Compression Train A, Northfield Terminal

> This is a synthetic document created for demonstration purposes. It describes a
> fictional asset at a fictional site and is not derived from any real operating procedure.

## 1. Scope

This procedure covers normal start-up, steady-state operation, normal shutdown, and
emergency shutdown of Centrifugal Compressor C-101. It applies to all Operations
personnel holding current C-101 competency sign-off.

This procedure does **not** cover maintenance activities. For maintenance isolation
requirements, refer to SP-204 Energy Isolation and Lock-Out/Tag-Out.

## 2. Change Summary for Rev 4

Rev 4 supersedes Rev 3 in full. The following changes were made under MOC-2025-118:

- Minimum seal gas differential pressure raised from 0.3 bar to **0.5 bar** following
  the seal failure investigated under CA-2024-087.
- Vibration alarm setpoint reduced from 7.1 mm/s to **6.5 mm/s** RMS.
- Added mandatory dry gas seal panel check to the pre-start checklist (Section 4.1).

## 3. Operating Limits

| Parameter | Normal | Alarm | Trip |
| --- | --- | --- | --- |
| Suction pressure | 12–18 barg | < 10 barg | < 8 barg |
| Discharge pressure | 48–62 barg | > 66 barg | > 70 barg |
| Discharge temperature | 85–115 °C | > 125 °C | > 140 °C |
| Vibration (radial, RMS) | < 4.5 mm/s | > 6.5 mm/s | > 11.2 mm/s |
| Seal gas differential | > 0.8 bar | < 0.5 bar | < 0.3 bar |
| Lube oil pressure | 2.4–3.1 barg | < 2.0 barg | < 1.6 barg |

## 4. Start-Up

### 4.1 Pre-Start Checklist

All items must be confirmed by the Panel Operator and countersigned by the Shift
Supervisor before start-up is initiated:

1. Confirm no active permits or lock-out devices are applied to C-101 or its
   associated systems. Reference SP-204 §5 for permit clearance verification.
2. Confirm lube oil reservoir level is between 60% and 85% and oil temperature
   is above 30 °C.
3. Confirm dry gas seal panel indicates a differential pressure above 0.8 bar with
   no active alarms. **(Added Rev 4)**
4. Confirm suction and discharge isolation valves are in the correct lineup per
   drawing PID-C101-03.
5. Confirm the anti-surge control valve strokes fully open on demand.
6. Confirm vibration monitoring is online and no channels are bypassed.

### 4.2 Start-Up Sequence

1. Establish seal gas supply and allow the differential to stabilise above 0.8 bar.
2. Start the auxiliary lube oil pump and confirm pressure above 2.4 barg.
3. Open the anti-surge recycle valve to 100%.
4. Initiate driver start and confirm rotation direction.
5. Ramp to minimum stable speed and hold for 10 minutes, monitoring vibration.
6. Close the recycle valve progressively while maintaining discharge pressure
   within the normal band.

## 5. Normal Shutdown

1. Reduce load progressively, opening the anti-surge recycle valve as required.
2. Confirm the machine is fully recycled before initiating driver stop.
3. Maintain seal gas supply for a minimum of 30 minutes after rotation ceases.
4. Maintain auxiliary lube oil flow until bearing metal temperature falls below 50 °C.

## 6. Emergency Shutdown

Initiate ESD from the panel or any field station. Confirm the machine trips, the
recycle valve opens fully, and seal gas remains established. Do not reset an ESD
until the initiating cause has been identified and cleared by the Shift Supervisor.

## 7. Related Documents

- SP-204 Energy Isolation and Lock-Out/Tag-Out
- MM-C101 Compressor C-101 Maintenance Manual
- PID-C101-03 Gas Compression Train A P&ID
