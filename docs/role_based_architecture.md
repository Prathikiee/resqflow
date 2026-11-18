# LIFELINK / ResQFlow — Role-Based Platform Architecture

## Executive Overview
LIFELINK / ResQFlow is architected as a multi-stakeholder emergency coordination system for regional response corridors (Mangaluru operational deployment: 12.9141° N, 74.8560° E). 

To ensure clean decoupling between emergency actors and support future mobile native applications (iOS/Android) alongside the Central Web Command Center, the platform defines four distinct user personas, permission boundaries, and dedicated workflow interfaces.

---

## 1. Stakeholder Roles & Responsibilities

| Role | Target Client | Primary Responsibilities | Data Visibility |
| :--- | :--- | :--- | :--- |
| **1. Citizen / Emergency Reporter** | Mobile App / Web SOS Lite | • Report live GPS location of an emergency<br>• Provide structured symptoms & chief complaint<br>• View real-time assigned ambulance ETA and arrival radar<br>• Submit secondary eyewitness reports | Own incident only, assigned ambulance location/ETA. No access to other incidents or fleet inventory. |
| **2. Ambulance Paramedic Crew** | Mobile App / In-Vehicle Tablet | • Receive provisional dispatch notifications<br>• Accept or reject dispatch within 90s reservation TTL<br>• Advance lifecycle stages (`ASSIGNED` → `EN_ROUTE` → `ON_SCENE` → `TRANSPORTING` → `COMPLETED`)<br>• Stream high-frequency telemetry (GPS coordinates, fuel level)<br>• Review patient clinical profile & triage justification | Assigned dispatch details, patient clinical briefing, receiving hospital destination route. |
| **3. Hospital ER Triage Staff** | Desktop Web Console / Tablet | • Receive incoming pre-arrival Emergency Handover Packets<br>• Accept or reject bed capacity reservations<br>• Acknowledge patient pre-arrival alerts to prepare trauma bays<br>• Update live ICU and emergency bed vacancy levels | Incoming dispatches directed to own facility, digital handover packets, ER capacity counts. |
| **4. Dispatcher / Regional Admin** | Web Command Center (Current App) | • Full GIS map operational oversight across region<br>• Run multi-factor ambulance and hospital allocation engine<br>• Oversee automated escalation and reassignments<br>• Deduplicate multi-witness reports with spatial/temporal matching<br>• Review complete audit timeline stream of coordination events | Complete regional operations data, all incidents, all fleet units, all hospitals. |

---

## 2. API Contract & Security Specification

### Authentication Strategy
- **Standard**: JSON Web Token (JWT) Bearer tokens passed in `Authorization: Bearer <token>` HTTP header.
- **Payload Schema**:
  ```json
  {
    "sub": "user_1024",
    "role": "AMBULANCE_CREW", // "CITIZEN" | "AMBULANCE_CREW" | "HOSPITAL_STAFF" | "DISPATCHER"
    "resource_id": 3,         // e.g., Ambulance ID 3 or Hospital ID 2 (if role-bound)
    "exp": 1797580800
  }
  ```

### Role-Based Access Control (RBAC) Matrix

| Endpoint | Method | Permitted Roles | Notes |
| :--- | :--- | :--- | :--- |
| `/api/incidents` | `POST` | `CITIZEN`, `DISPATCHER` | Citizen registers emergency or Dispatcher logs call |
| `/api/incidents` | `GET` | `DISPATCHER` | Regional queue view |
| `/api/incidents/{id}` | `GET` | All (conditional) | Citizen views own; Crew views assigned; Hosp views incoming |
| `/api/witness-reports` | `POST` | `CITIZEN`, `DISPATCHER` | Civilians report accidents or secondary sightings |
| `/api/witness-reports/{id}/link` | `POST` | `DISPATCHER` | Dispatcher confirms duplicate correlation |
| `/api/witness-reports/{id}/mark-distinct` | `POST` | `DISPATCHER` | Dispatcher classifies as distinct event |
| `/api/dispatch` | `POST` | `DISPATCHER` | Initiates provisional 90s reservation |
| `/api/dispatch/{id}/confirm/ambulance` | `POST` | `AMBULANCE_CREW`, `DISPATCHER` | Paramedic crew accepts/declines assignment |
| `/api/dispatch/{id}/confirm/hospital` | `POST` | `HOSPITAL_STAFF`, `DISPATCHER` | ER triage confirms bed availability |
| `/api/dispatch/{id}/step` | `PATCH` | `AMBULANCE_CREW`, `DISPATCHER` | Crew steps through emergency lifecycle |
| `/api/dispatch/{id}/handover` | `GET` | `HOSPITAL_STAFF`, `DISPATCHER`, `AMBULANCE_CREW` | Pre-arrival clinical packet transmission |
| `/api/dispatch/{id}/handover/acknowledge` | `POST` | `HOSPITAL_STAFF`, `DISPATCHER` | Hospital confirms receipt & prepares bay |
| `/api/incidents/{id}/timeline` | `GET` | `DISPATCHER`, `HOSPITAL_STAFF` | Unified audit trail stream |

---

## 3. Future Mobile Applications Roadmap

Following completion and operational verification of the centralized Web Command Center, dedicated client applications will be built using cross-platform frameworks:

1. **LIFELINK Citizen SOS (React Native / Flutter)**
   - One-tap SOS GPS broadcast.
   - Interactive questionnaire for fast AVPU/bleeding symptom flags.
   - Real-time map with ambulance tracker and live arrival ETA.
2. **LIFELINK Crew Navigator (React Native / Android)**
   - High-contrast night-mode turn-by-turn navigation overlay.
   - Large touch targets for one-tap Accept/Reject during 90s reservation countdown.
   - Offline-capable state machine with automatic sync upon reconnect.
3. **LIFELINK ER Reception (Web PWA / iOS / Android Tablet)**
   - Audible high-priority chime upon dual confirmation of critical (Red) patient.
   - Pre-arrival clinical vital cards and trauma team preparation checklist.
   - Single-tap ER Bay reservation confirmation.
