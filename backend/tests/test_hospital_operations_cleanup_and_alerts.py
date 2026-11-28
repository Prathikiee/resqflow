import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.core.database import get_db
from backend.app.models.entities import Hospital, Incident
from backend.app.services.hospital_engine import rank_suitable_hospitals

client = TestClient(app)

@pytest.fixture
def auth_headers_hospital_1():
    # Login as hospital staff for Hospital 1 (KMC)
    resp = client.post("/api/auth/token", data={"username": "hospital_kmc", "password": "password123"})
    if resp.status_code == 200:
        token = resp.json()["access_token"]
        return {"Authorization": f"Bearer {token}"}
    return {}

@pytest.fixture
def auth_headers_dispatcher():
    resp = client.post("/api/auth/token", data={"username": "dispatcher_mangaluru", "password": "password123"})
    if resp.status_code == 200:
        token = resp.json()["access_token"]
        return {"Authorization": f"Bearer {token}"}
    return {}

def test_facility_network_and_context_switching(auth_headers_hospital_1):
    """Verify that network list returns 30 regional facilities and facility switching creates isolated tokens."""
    # 1. Fetch network
    resp = client.get("/api/hospitals/network", headers=auth_headers_hospital_1)
    assert resp.status_code == 200
    network = resp.json()
    assert len(network) == 30
    facility_codes = [h["facility_code"] for h in network if h.get("facility_code")]
    assert len(set(facility_codes)) == len(facility_codes)  # All codes unique

    # 2. Switch facility context to Father Muller (ID 3)
    switch_resp = client.post("/api/auth/switch-facility/3", headers=auth_headers_hospital_1)
    assert switch_resp.status_code == 200
    switch_data = switch_resp.json()
    assert switch_data["user"]["hospital_id"] == 3
    new_token = switch_data["access_token"]

    # 3. Verify user info with new token
    me_resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {new_token}"})
    assert me_resp.status_code == 200
    assert me_resp.json()["hospital_id"] == 3

def test_doctor_crud_persistence_and_shift_evaluation(auth_headers_hospital_1):
    """Verify functional CRUD operations for doctors, persisted to database with shift evaluation."""
    # 1. Add doctor
    new_doc_payload = {
        "name": "Dr. Test Ops Surgeon",
        "specialty": "Trauma Surgery",
        "department": "Emergency Medicine",
        "designation": "Senior Consultant",
        "shift": "Morning (08:00 - 16:00)",
        "shift_type": "MORNING",
        "shift_start": "08:00",
        "shift_end": "16:00",
        "working_days": ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
        "status": "AVAILABLE",
        "emergency_coverage": True,
        "contact_number": "Ext. 999",
        "is_active": True,
    }
    create_resp = client.post("/api/hospitals/1/doctors", json=new_doc_payload, headers=auth_headers_hospital_1)
    assert create_resp.status_code == 201
    doctors = create_resp.json()
    matching_docs = [d for d in doctors if d["name"] == "Dr. Test Ops Surgeon"]
    assert len(matching_docs) == 1
    doc_id = matching_docs[0]["id"]
    assert matching_docs[0]["specialty"] == "Trauma Surgery"

    # 2. Edit doctor
    update_payload = {
        "specialty": "Polytrauma & Critical Care",
        "designation": "Chief Trauma Surgeon",
        "contact_number": "Ext. 998",
    }
    update_resp = client.put(f"/api/hospitals/1/doctors/{doc_id}", json=update_payload, headers=auth_headers_hospital_1)
    assert update_resp.status_code == 200
    updated_docs = update_resp.json()
    upd_doc = next(d for d in updated_docs if d["id"] == doc_id)
    assert upd_doc["specialty"] == "Polytrauma & Critical Care"
    assert upd_doc["designation"] == "Chief Trauma Surgeon"

    # 3. Quick Status toggle
    status_resp = client.patch(f"/api/hospitals/1/doctors/{doc_id}/status", json={"status": "BUSY"}, headers=auth_headers_hospital_1)
    assert status_resp.status_code == 200
    status_docs = status_resp.json()
    busy_doc = next(d for d in status_docs if d["id"] == doc_id)
    assert busy_doc["status"] == "BUSY"

    # 4. Delete doctor
    del_resp = client.delete(f"/api/hospitals/1/doctors/{doc_id}", headers=auth_headers_hospital_1)
    assert del_resp.status_code == 200
    remaining_docs = del_resp.json()
    assert not any(d["id"] == doc_id for d in remaining_docs)

def test_bed_capacity_management_and_validation(auth_headers_hospital_1):
    """Verify bed capacity calculation: Available = Total - Occupied - Reserved - Unavailable, and validation."""
    # 1. Valid update with trauma category included
    valid_payload = {
        "emergency": {"total": 25, "occupied": 10, "reserved": 2, "unavailable": 1},
        "icu": {"total": 15, "occupied": 8, "reserved": 1, "unavailable": 1},
        "trauma": {"total": 10, "occupied": 4, "reserved": 0, "unavailable": 1},
        "hdu": {"total": 8, "occupied": 3, "reserved": 0, "unavailable": 0},
        "general_ward": {"total": 60, "occupied": 30, "reserved": 0, "unavailable": 5},
    }
    resp = client.patch("/api/hospitals/1/bed-capacity", json=valid_payload, headers=auth_headers_hospital_1)
    assert resp.status_code == 200
    breakdown = resp.json()
    assert breakdown["emergency"]["total"] == 25
    assert breakdown["emergency"]["occupied"] == 10
    assert breakdown["emergency"]["reserved"] == 2
    assert breakdown["emergency"]["unavailable"] == 1
    # available = 25 - 10 - 2 - 1 = 12
    assert breakdown["emergency"]["available"] == 12
    assert breakdown["trauma"]["available"] == 5  # 10 - 4 - 0 - 1 = 5

    # 2. Validation error: occupied + reserved + unavailable > total
    invalid_overcapacity = {
        "emergency": {"total": 20, "occupied": 15, "reserved": 5, "unavailable": 2}, # 22 > 20
    }
    err_resp = client.patch("/api/hospitals/1/bed-capacity", json=invalid_overcapacity, headers=auth_headers_hospital_1)
    assert err_resp.status_code == 422
    assert "exceeds total" in err_resp.json()["detail"].lower()

    # 3. Validation error: negative values
    invalid_negative = {
        "emergency": {"total": 20, "occupied": -1, "reserved": 0, "unavailable": 0},
    }
    err_neg = client.patch("/api/hospitals/1/bed-capacity", json=invalid_negative, headers=auth_headers_hospital_1)
    assert err_neg.status_code == 422

def test_departments_crud_and_capabilities_matrix(auth_headers_hospital_1):
    """Verify department add/edit/delete and capabilities matrix persistence."""
    # 1. Add Department
    dept_payload = {
        "name": "Hyperbaric Emergency Medicine",
        "operational_status": "ACTIVE",
        "operating_hours": "24/7",
        "emergency_coverage": True,
        "specialty_availability": ["Diving Medicine", "Carbon Monoxide Resuscitation"],
        "notes": "Dedicated hyperbaric decompression chamber",
    }
    add_resp = client.post("/api/hospitals/1/departments", json=dept_payload, headers=auth_headers_hospital_1)
    assert add_resp.status_code == 201
    depts = add_resp.json()
    created_dept = next(d for d in depts if d["name"] == "Hyperbaric Emergency Medicine")
    dept_id = created_dept["id"]
    assert created_dept["emergency_coverage"] is True

    # 2. Update Department
    update_dept_payload = {
        "operational_status": "LIMITED",
        "operating_hours": "08:00 - 20:00",
        "notes": "Operating on reduced staffing schedule",
    }
    patch_resp = client.patch(f"/api/hospitals/1/departments/{dept_id}", json=update_dept_payload, headers=auth_headers_hospital_1)
    assert patch_resp.status_code == 200
    updated_depts = patch_resp.json()
    upd_d = next(d for d in updated_depts if d["id"] == dept_id)
    assert upd_d["operational_status"] == "LIMITED"
    assert upd_d["operating_hours"] == "08:00 - 20:00"

    # 3. Delete Department
    del_resp = client.delete(f"/api/hospitals/1/departments/{dept_id}", headers=auth_headers_hospital_1)
    assert del_resp.status_code == 200
    rem_depts = del_resp.json()
    assert not any(d["id"] == dept_id for d in rem_depts)

    # 4. Capabilities Matrix update
    caps_payload = {
        "cardiac_emergency": "AVAILABLE",
        "trauma_capability": "AVAILABLE",
        "operating_theatre": "AVAILABLE",
        "ventilator_availability": "LIMITED",
    }
    caps_resp = client.patch("/api/hospitals/1/capabilities", json=caps_payload, headers=auth_headers_hospital_1)
    assert caps_resp.status_code == 200
    caps = caps_resp.json()
    assert caps["cardiac_emergency"] == "AVAILABLE"
    assert caps["ventilator_availability"] == "LIMITED"

def test_dispatcher_matching_engine_incorporates_readiness_and_departments():
    """Verify that Dispatcher hospital matching dynamically responds to readiness, capabilities and departments."""
    # Create test hospital entities in memory
    h_ready = Hospital(
        id=101,
        name="Test Center Ready",
        address="Central Mangaluru",
        latitude=12.8700,
        longitude=74.8400,
        total_emergency_beds=20,
        available_emergency_beds=10,
        reserved_emergency_beds=0,
        total_icu_beds=10,
        available_icu_beds=5,
        readiness_status="READY",
        accepting_emergencies=True,
        specialties_json='["Cardiology", "Emergency Medicine"]',
        capabilities_json='{"cardiac_emergency": "AVAILABLE"}',
        contact_number="9999999991",
    )

    h_divert = Hospital(
        id=102,
        name="Test Center Divert",
        address="Near Scene",
        latitude=12.8705,
        longitude=74.8405,
        total_emergency_beds=20,
        available_emergency_beds=10,
        reserved_emergency_beds=0,
        total_icu_beds=10,
        available_icu_beds=5,
        readiness_status="DIVERT",  # Diverted!
        accepting_emergencies=False,
        specialties_json='["Cardiology", "Emergency Medicine"]',
        capabilities_json='{"cardiac_emergency": "AVAILABLE"}',
        contact_number="9999999992",
    )

    h_busy = Hospital(
        id=103,
        name="Test Center Busy",
        address="Central Mangaluru",
        latitude=12.8700,
        longitude=74.8400,
        total_emergency_beds=20,
        available_emergency_beds=10,
        reserved_emergency_beds=0,
        total_icu_beds=10,
        available_icu_beds=5,
        readiness_status="BUSY",  # Busy!
        accepting_emergencies=True,
        specialties_json='["Cardiology", "Emergency Medicine"]',
        capabilities_json='{"cardiac_emergency": "AVAILABLE"}',
        contact_number="9999999993",
    )

    # Cardiac Incident
    incident = Incident(
        id=999,
        latitude=12.8710,
        longitude=74.8410,
        chest_pain=True,
        chief_complaint="Severe acute chest pain radiating to left arm",
        severity="CRITICAL",
    )

    ranking = rank_suitable_hospitals(incident, [h_ready, h_divert, h_busy])
    ranked_ids = [c["hospital_id"] for c in ranking["ranked_hospitals"]]

    # 1. Diverted hospital must be excluded
    assert 102 not in ranked_ids

    # 2. Ready hospital must outrank Busy hospital
    assert 101 in ranked_ids
    assert 103 in ranked_ids
    score_ready = next(c["total_suitability_score"] for c in ranking["ranked_hospitals"] if c["hospital_id"] == 101)
    score_busy = next(c["total_suitability_score"] for c in ranking["ranked_hospitals"] if c["hospital_id"] == 103)
    assert score_ready > score_busy

