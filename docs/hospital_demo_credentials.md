# LIFELINK / ResQFlow — Hospital Demo Accounts & Credentials Guide

This guide documents the 10 demo hospital accounts seeded for the Mangaluru emergency response network. Each hospital has an isolated account with role `HOSPITAL_STAFF` linked to its distinct facility ID in the database.

> [!IMPORTANT]
> **Data Isolation Guarantee**: In accordance with healthcare data isolation requirements, Hospital Staff logged into one facility can **never** access another facility's doctors, bed capacity, allocated incidents, inbound ambulances, or crash alerts. Attempting to query another hospital's resources yields `HTTP 403 Forbidden`.

---

## 1. Seeded Mangaluru Hospital Accounts

All hospital passwords securely hash via `bcrypt` in the database and adhere to the convention of starting with the first letter of the hospital name followed by a unique, secure demo-only suffix (`#HospitalPass2026!Mangaluru`).

| # | Hospital Name | Facility Code | Location / Landmark | Email / Username | Password |
|---|---|---|---|---|---|
| 1 | **KMC Hospital** | `KMC-AMB-01` | Ambedkar Circle, Mangaluru | `kmc@lifelink.demo` | `Kmc#HospitalPass2026!Mangaluru` |
| 2 | **A.J. Hospital & Research Centre** | `AJH-KUN-02` | Kuntikana Junction, Mangaluru | `aj@lifelink.demo` | `Aj#HospitalPass2026!Mangaluru` |
| 3 | **Unity Hospital** | `UNT-KAN-03` | Highlands / Kankanady, Mangaluru | `unity@lifelink.demo` | `Unity#HospitalPass2026!Mangaluru` |
| 4 | **Indiana Hospital & Heart Institute** | `IND-PUM-04` | Pumpwell Circle, Mangaluru | `indiana@lifelink.demo` | `Indiana#HospitalPass2026!Mangaluru` |
| 5 | **Yenepoya Speciality Hospital** | `YEN-KOD-05` | Kodialbail, Mangaluru | `yenepoya@lifelink.demo` | `Yenepoya#HospitalPass2026!Mangaluru` |
| 6 | **Father Muller Medical College Hospital** | `FMM-KAN-06` | Kankanady, Mangaluru | `fathermuller@lifelink.demo` | `FatherMuller#HospitalPass2026!Mangaluru` |
| 7 | **City Hospital Research & Diagnostic Centre** | `CTH-MGL-07` | Kadri / Mallikatta, Mangaluru | `cityhospital@lifelink.demo` | `CityHospital#HospitalPass2026!Mangaluru` |
| 8 | **Highland Hospital** | `HGH-FLN-08` | Falnir Road, Mangaluru | `highland@lifelink.demo` | `Highland#HospitalPass2026!Mangaluru` |
| 9 | **Tejasvini Hospital & SSIOT** | `TEJ-KDR-09` | Kadri Temple Road, Mangaluru | `tejasvini@lifelink.demo` | `Tejasvini#HospitalPass2026!Mangaluru` |
| 10 | **Mangala Hospital & Kidney Foundation** | `MGL-MGL-10` | Vajra Hills, Kadri, Mangaluru | `mangala@lifelink.demo` | `Mangala#HospitalPass2026!Mangaluru` |

---

## 2. Other Core Demo Accounts

| Role | Operational Scope | Email / Username | Password |
|---|---|---|---|
| **Regional Dispatcher** | Regional Command Center / Cross-Hospital Supervisory | `dispatcher@lifelink.demo` | `Lifelink@2026!` |
| **Paramedic Crew (ALS-101)** | Advanced Life Support Ambulance KA-19-ALS-101 | `als101@lifelink.demo` | `Lifelink@2026!` |
| **Citizen SOS Reporter** | Civilian Emergency Incident Reporting | `citizen@lifelink.demo` | `Lifelink@2026!` |
| **Super Administrator** | Platform Management & Master Auditing | `admin@lifelink.demo` | `Lifelink@2026!` |

---

## 3. Hospital Resource Capacities (Seeded Baseline)

All 10 facilities are marked with the `DEMO DATA` tag and feature realistic specialized departments:

- **Trauma & Stroke Centers**: KMC Hospital, A.J. Hospital, Father Muller Medical College Hospital
- **Cardiac Care & Cath Labs**: Indiana Hospital & Heart Institute, KMC Hospital, Unity Hospital
- **Burn Care Center**: A.J. Hospital & Research Centre
- **Orthopedics & Spine**: Tejasvini Hospital & SSIOT
- **Nephrology & Urology**: Mangala Hospital & Kidney Foundation, Yenepoya Speciality Hospital
- **Multispecialty & General**: Highland Hospital, City Hospital Research Centre

Each hospital record maintains:
- Available vs Occupied Emergency Department Resuscitation Bays
- Available vs Occupied Intensive Care Unit (ICU) Beds
- Available vs Occupied Inpatient Ward Beds
- Available vs Occupied Pediatric Beds
- Oxygen Supply Status (`NORMAL`, `LOW`, `CRITICAL`)
- Dedicated Ventilators (`total` and `available`)
- Blood Bank Stock Matrix (Packed RBCs, O-Negative units, Platelets, Plasma)
- Active Emergency Duty Doctor Rosters
