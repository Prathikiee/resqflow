import sys
import os
sys.path.insert(0, os.path.abspath("."))

import json
import urllib.request

BASE_URL = "http://127.0.0.1:8000"

def request_json(path, method="GET", body=None):
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {"Content-Type": "application/json"} if body else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read().decode("utf-8"))

def test_frontend_e2e_api():
    print("=== FRONTEND END-TO-END WORKFLOW INTEGRATION VERIFICATION ===")

    # 1. Health Probe
    health = request_json("/health")
    assert health["status"] == "healthy"
    assert "Mangaluru" in health["region"]["city"]
    print("✓ Step 1: Health endpoint operational (Mangaluru operations hub).")

    # 2. Triage Preview (User fills symptom form)
    preview = request_json("/api/incidents/triage-preview", method="POST", body={
        "chief_complaint": "Pedestrian struck by heavy vehicle, suspected pelvic trauma and arterial bleeding",
        "consciousness_level": "Pain",
        "breathing_status": "Difficult",
        "severe_bleeding": True,
        "severe_trauma": True,
        "chest_pain": False,
        "suspected_stroke": False,
        "patient_age": 28,
    })
    assert preview["triage_color"] == "RED"
    assert "Priority 1" in preview["triage_level"]
    assert preview["required_ambulance_type"] == "ALS"
    assert any("Hemorrhage" in j or "Trauma" in j for j in preview["justifications"])
    print(f"✓ Step 2: Instant triage preview verified ({preview['triage_level']}, ALS required).")

    # 3. Register Emergency Incident (User clicks 'Confirm & Register')
    new_inc = request_json("/api/incidents", method="POST", body={
        "caller_name": "Divya Hegde",
        "caller_phone": "+91 98450 99887",
        "location_address": "Kuntikan Highway Flyover, Mangaluru",
        "latitude": 12.8980,
        "longitude": 74.8460,
        "chief_complaint": "Pedestrian struck by heavy vehicle, suspected pelvic trauma and arterial bleeding",
        "consciousness_level": "Pain",
        "breathing_status": "Difficult",
        "severe_bleeding": True,
        "severe_trauma": True,
        "chest_pain": False,
        "suspected_stroke": False,
        "patient_age": 28,
        "patient_gender": "Female",
    })
    inc_id = new_inc["id"]
    assert inc_id is not None
    assert new_inc["status"] == "TRIAGED"
    print(f"✓ Step 3: Emergency incident #{inc_id} persisted in database.")

    # 4. Multi-Factor Allocation Recommendations (Modal opens)
    recs = request_json(f"/api/dispatch/recommend/{inc_id}")
    amb_recs = recs["ambulance_allocation"]
    hosp_recs = recs["hospital_ranking"]

    ranked_ambs = amb_recs["ranked_ambulances"]
    assert len(ranked_ambs) > 0, "No suitable ambulances ranked!"
    top_amb = ranked_ambs[0]

    # Verify score breakdown weights exist
    bd = top_amb["score_breakdown"]
    assert "proximity_eta_score" in bd
    assert "capability_match_score" in bd
    assert "equipment_score" in bd
    assert "readiness_score" in bd
    print(f"✓ Step 4: Multi-factor allocation computed. Top unit: {top_amb['call_sign']} (Score: {top_amb['total_score']}/100, ETA: {top_amb['eta_minutes']}m).")

    # Verify excluded units transparency
    excluded_ambs = amb_recs["excluded_ambulances"]
    assert len(excluded_ambs) > 0
    print(f"✓ Step 5: Pre-filtered excluded units verified ({len(excluded_ambs)} units rejected with documented reasons).")

    # Verify Hospital Matching
    ranked_hosps = hosp_recs["ranked_hospitals"]
    assert len(ranked_hosps) > 0
    top_hosp = ranked_hosps[0]
    assert "Trauma Level 1" in top_hosp["matched_specialties"] or "Emergency Medicine" in top_hosp["specialties"]
    print(f"✓ Step 6: Hospital suitability matched: {top_hosp['name']} (Score: {top_hosp['total_suitability_score']}, Transit: {top_hosp['transit_minutes']}m).")

    # 5. Confirm Dispatch (User clicks 'Confirm & Dispatch')
    dispatch = request_json("/api/dispatch", method="POST", body={
        "incident_id": inc_id,
        "ambulance_id": top_amb["ambulance_id"],
        "destination_hospital_id": top_hosp["hospital_id"],
    })
    disp_id = dispatch["id"]
    assert disp_id is not None
    assert dispatch["status"] == "ASSIGNED"
    assert len(dispatch["route_geometry"]) > 0
    print(f"✓ Step 7: Dispatch #{disp_id} created with route geometry ({len(dispatch['route_geometry'])} waypoints).")

    # 6. Step Lifecycle: ASSIGNED -> EN_ROUTE_INCIDENT
    step1 = request_json(f"/api/dispatch/{disp_id}/step", method="PATCH")
    assert step1["status"] == "EN_ROUTE_INCIDENT"
    inc_state1 = request_json(f"/api/incidents/{inc_id}")
    assert inc_state1["status"] == "EN_ROUTE"
    print("✓ Step 8: Lifecycle advanced: ASSIGNED -> EN_ROUTE.")

    # 7. Step Lifecycle: EN_ROUTE_INCIDENT -> ON_SCENE
    step2 = request_json(f"/api/dispatch/{disp_id}/step", method="PATCH")
    assert step2["status"] == "ON_SCENE"
    assert step2["arrived_incident_at"] is not None
    inc_state2 = request_json(f"/api/incidents/{inc_id}")
    assert inc_state2["status"] == "ON_SCENE"
    print("✓ Step 9: Lifecycle advanced: EN_ROUTE -> ON_SCENE (Scene arrival logged).")

    # 8. Step Lifecycle: ON_SCENE -> EN_ROUTE_HOSPITAL
    step3 = request_json(f"/api/dispatch/{disp_id}/step", method="PATCH")
    assert step3["status"] == "EN_ROUTE_HOSPITAL"
    inc_state3 = request_json(f"/api/incidents/{inc_id}")
    assert inc_state3["status"] == "TRANSPORTING"
    print("✓ Step 10: Lifecycle advanced: ON_SCENE -> TRANSPORTING (Hospital transit route active).")

    # 9. Step Lifecycle: EN_ROUTE_HOSPITAL -> COMPLETED
    step4 = request_json(f"/api/dispatch/{disp_id}/step", method="PATCH")
    assert step4["status"] == "COMPLETED"
    assert step4["completed_at"] is not None
    inc_state4 = request_json(f"/api/incidents/{inc_id}")
    assert inc_state4["status"] == "RESOLVED"

    # Verify ambulance is returned to AVAILABLE at the receiving hospital
    amb_final = request_json(f"/api/ambulances/{top_amb['ambulance_id']}")
    assert amb_final["status"] == "AVAILABLE"
    assert amb_final["current_latitude"] == top_hosp["location"]["latitude"]
    assert amb_final["current_longitude"] == top_hosp["location"]["longitude"]
    print("✓ Step 11: Lifecycle completed: Handover logged, Incident RESOLVED, Ambulance returned to AVAILABLE at hospital.")

    print("ALL FRONTEND E2E WORKFLOW INTEGRATION STEPS 100% VERIFIED.")

if __name__ == "__main__":
    test_frontend_e2e_api()
