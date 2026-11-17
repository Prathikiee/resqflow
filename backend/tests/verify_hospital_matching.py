import sys
import os
sys.path.insert(0, os.path.abspath("."))

from backend.app.models.entities import Hospital, Incident
from backend.app.services.hospital_engine import rank_suitable_hospitals

def test_hospital_matching():
    print("=== HOSPITAL MATCHING & CAPACITY VERIFICATION ===")

    # Hospital A: Closed / Not accepting emergencies -> MUST BE EXCLUDED
    hosp_closed = Hospital(
        id=201,
        name="Mangaluru Closed Clinic",
        address="Bunder Port",
        latitude=12.8600,
        longitude=74.8400,
        total_icu_beds=10,
        available_icu_beds=5,
        total_emergency_beds=20,
        available_emergency_beds=10,
        specialties=["Emergency Medicine"],
        accepting_emergencies=False,  # Not accepting
        contact_number="+91 824 000000",
    )

    # Hospital B: General Emergency, Low ICU vacancy (1 bed)
    hosp_low_icu = Hospital(
        id=202,
        name="District General Care",
        address="Hampankatta",
        latitude=12.8700,
        longitude=74.8450,
        total_icu_beds=20,
        available_icu_beds=1,  # Only 1 bed
        total_emergency_beds=20,
        available_emergency_beds=4,
        specialties=["Emergency Medicine"],
        accepting_emergencies=True,
        contact_number="+91 824 111111",
    )

    # Hospital C: Super Specialty with Burn Care & high ICU vacancy (12 beds)
    hosp_burn_super = Hospital(
        id=203,
        name="AJ Super Specialty",
        address="Kuntikan",
        latitude=12.8988,
        longitude=74.8465,
        total_icu_beds=25,
        available_icu_beds=12,
        total_emergency_beds=30,
        available_emergency_beds=15,
        specialties=["Emergency Medicine", "Burn Care", "Trauma Level 1"],
        accepting_emergencies=True,
        contact_number="+91 824 222222",
    )

    hospitals = [hosp_closed, hosp_low_icu, hosp_burn_super]

    # Incident: Severe industrial burn injury
    burn_incident = Incident(
        id=888,
        caller_name="Factory Supervisor",
        caller_phone="+91 98450 77889",
        location_address="Baikampady Industrial Estate, Mangaluru",
        latitude=12.9300,
        longitude=74.8100,
        chief_complaint="Severe chemical boiler explosion with deep full-thickness thermal burns",
        triage_level="Priority 1 (Critical)",
        triage_color="RED",
    )

    res = rank_suitable_hospitals(incident=burn_incident, hospitals=hospitals)
    ranked = res["ranked_hospitals"]

    print(f"Hospitals provided: {len(hospitals)}, Ranked returned: {len(ranked)}")

    # 1. Closed hospital exclusion check
    ranked_names = [h["name"] for h in ranked]
    assert "Mangaluru Closed Clinic" not in ranked_names, "Hospital with accepting_emergencies=False was not excluded!"
    print("✓ Unavailable hospital exclusion verified (accepting_emergencies=False eliminated).")

    # 2. Burn Care Specialty Match Check
    top = ranked[0]
    assert top["name"] == "AJ Super Specialty", f"Expected AJ Super Specialty at rank #1, got {top['name']}"
    assert "Burn Care" in top["matched_specialties"], "Burn Care specialty was not detected in matched specialties!"
    assert top["score_breakdown"]["specialty_score"] == 100.0
    print(f"✓ Specialty compatibility verified: Top hospital matched 'Burn Care' with 100.0 specialty score.")

    # 3. Capacity verification
    assert top["available_icu_beds"] == 12
    assert top["available_emergency_beds"] == 15
    print("✓ Bed capacity integration verified.")

    # 4. Routing metadata & simulation attribution check
    assert "routing_mode" in top
    assert "is_simulated_route" in top
    print(f"✓ Route simulation label verified: mode='{top['routing_mode']}', is_simulated={top['is_simulated_route']}.")

    print("ALL HOSPITAL MATCHING SCENARIOS VERIFIED.")

if __name__ == "__main__":
    test_hospital_matching()
