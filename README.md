**ResQFlow — Emergency Response & Ambulance Coordination Platform**


ResQFlow is an intelligent emergency medical dispatch and ambulance coordination platform engineered for rapid, explainable emergency response across the Mangaluru, Karnataka metropolitan corridor.


Key Capabilities (P0 & P1 Core)
1. Emergency Registration & Intake:
   - Rapid caller intake with Mangaluru landmark presets (Kadri Hills, Hampankatta, Kuntikan, Bunder, Ullal, Surathkal).
   - Structured clinical presentation input (AVPU consciousness scale, respiratory effort, acute cardiac flags, stroke signs, trauma level).
2. Explainable Rule-Based Clinical Triage:
   - Transparent rule heuristic categorizing calls into Priority 1 (Red / Critical), Priority 2 (Yellow / Urgent), or Priority 3 (Green / Standard).
   - Full human-readable decision trace justifying every triage level and assigning required ambulance capability (ALS vs BLS).
   - Explicit clinical disclaimer regarding non-diagnostic decision support.
3. Multi-Factor Ambulance Allocation Engine:
   - Hard Exclusion Pre-Filtering: Eliminates busy units (status != "AVAILABLE"), units in maintenance, or units with low fuel (<20%), and excludes BLS units lacking resuscitation equipment from Priority 1 calls.
   - Multi-Factor Scoring:
     \(\text{Total Score} = 0.40 \times \text{ETA} + 0.25 \times \text{Capability} + 0.20 \times \text{Equipment} + 0.15 \times \text{Readiness}\)
   - Full Explainability: Displays why the top unit was selected, visual factor breakdown bars, and lists excluded units with specific rejection reasons.
4. Hospital Suitability & Capacity Matcher:
   - Matches incoming incident pathology to receiving hospital departments (Trauma Level 1, Cardiology, Stroke Unit, Pediatrics, Burn Care).
   - Incorporates live ICU bed vacancy, emergency bay capacity, and ambulance transit duration.
5. OSRM Route & ETA Engine (w/ Deterministic Fallback):
   - Queries OpenStreetMap OSRM driving profile with emergency priority speed adjustment.
   - Resilient fallback utilizing Haversine distance with urban tortuosity (1.32x) and 40 km/h response profile.
   - Explicit labeling distinguishing live OSRM data from estimated fallback routes.
6. Emergency Command Center & Map:
   - Interactive dark-mode GIS map built with React Leaflet.
   - Custom markers for emergency incidents (pulsing by priority), ALS/BLS ambulances (with status rings), and hospitals (with bed vacancy indicators).
   - Route polylines visualizing active dispatch paths.
7. Incident Lifecycle State Machine:
   - Full operational lifecycle tracking:
     \(\text{REPORTED} \rightarrow \text{TRIAGED} \rightarrow \text{ALLOCATED} \rightarrow \text{DISPATCHED} \rightarrow \text{EN\_ROUTE} \rightarrow \text{ON\_SCENE} \rightarrow \text{TRANSPORTING} \rightarrow \text{RESOLVED}\)
   - Synchronous updates to ambulance location, actual response time logging, and fleet availability upon hospital handover.
     
Hardware Prototype (Experimental)
ResQFlow may also include a simple hardware prototype to explore automatic accident detection and location sharing.
- ESP32: Acts as the controller and reads data from connected sensors.
- MPU6050 Sensor: Detects sudden acceleration, impact, or unusual movement that may indicate a vehicle accident.
- GPS Module: Provides the vehicle's location so it can be shared with the emergency response system.
The hardware concept is experimental and under development. It is not yet a verified crash-detection system and does not replace manually reported emergencies.
Architecture & Technology Stack
- Frontend: Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, Lucide icons, Leaflet & React Leaflet.
- Backend: FastAPI, Python 3.12, Pydantic v2, SQLAlchemy 2.0.
- Database: Dual-mode persistence:
  - Primary: Supabase PostgreSQL (DATABASE_URL).
  - Resilient Offline Fallback: Local SQLite database (resqflow.db).
- Routing: OpenStreetMap OSRM + Deterministic Urban Fallback.
Quickstart & Local Setup
1. Environment Configuration
Copy .env.example to .env:
cp .env.example .env
(Leave DATABASE_URL empty to use automatic local SQLite, or paste your Supabase PostgreSQL connection string).
2. Backend Setup & Run
 Activate virtual environment
backend\.venv\Scripts\activate   # Windows
 or: source backend/.venv/bin/activate (Linux/Mac)

 Install dependencies (if not already installed)
pip install -r backend/requirements.txt

 Run test suite (18 comprehensive unit & integration tests)
pytest -v

 Start FastAPI server on port 8000
python -m uvicorn backend.app.main:app --port 8000 --reload
API Documentation will be live at http://127.0.0.1:8000/docs.
3. Frontend Setup & Run
 In another terminal window:
npm run dev --prefix frontend
 or: cd frontend && npm run dev
Open http://localhost:3000 in your browser to view the Live Emergency Command Center.
Seed Data Summary (Mangaluru Region)
- Hospitals (5):
  1. KMC Hospital Ambedkar Circle (Trauma Level 1, Cardiology, Stroke Unit)
  2. Government Wenlock District Hospital (Major Public Emergency, Trauma Level 2)
  3. Father Muller Medical College Hospital (Kankanady Multi-specialty)
  4. AJ Hospital & Research Centre (Kuntikan Super Specialty, Burn Care, Neurosurgery)
  5. Yenepoya Specialty Hospital (Kodialbail Nephrology & Cardiology)
- Ambulance Fleet (8):
  - KA-19-ALS-101: KMC Central Hub (Available, Advanced Life Support)
  - KA-19-ALS-102: AJ Kuntikan Post (Available, Advanced Life Support)
  - KA-19-BLS-201: Wenlock Depot (Available, Basic Life Support)
  - KA-19-BLS-202: Kadri Fire Outpost (Available, Basic Life Support)
  - KA-19-ALS-103: Surathkal Sector (Available, Advanced Life Support)
  - KA-19-BLS-203: Ullal Coastal Unit (Available, Basic Life Support)
  - KA-19-ALS-104: Pumpwell Junction (Dispatched — demonstrating busy exclusion)
  - KA-19-BLS-204: Bejai Service Center (Maintenance — demonstrating maintenance exclusion)
