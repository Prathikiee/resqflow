import sys
import os
sys.path.insert(0, os.path.abspath("."))

from backend.app.models.entities import Ambulance, Incident
from backend.app.services.allocation_engine import score_and_rank_ambulances

def test_allocation_scenarios():
    print("=== AMBULANCE ALLOCATION VERIFICATION ===")

    # Setup 4 distinct ambulances in Mangaluru
    # Amb A: Close, but low fuel (10%) -> MUST BE HARD EXCLUDED
    amb_low_fuel = Ambulance(
        id=101,
        call_sign="AMB-LOW-FUEL",
        vehicle_type="ALS",
        paramedic_level="ADVANCED",
        status="AVAILABLE",
        base_station="Hampankatta",
        current_latitude=12.8700,
        current_longitude=74.8450,
        fuel_level_percent=10,  # <20%
        equipment=["ventilator", "defibrillator", "oxygen"],
        is_active=True,
    )

    # Amb B: Close (1 km away), but currently DISPATCHED -> MUST BE HARD EXCLUDED
    amb_busy = Ambulance(
        id=102,
        call_sign="AMB-BUSY",
        vehicle_type="ALS",
        paramedic_level="ADVANCED",
        status="DISPATCHED",
        base_station="Kadri",
        current_latitude=12.8750,
        current_longitude=74.8550,
        fuel_level_percent=90,
        equipment=["ventilator", "defibrillator", "oxygen"],
        is_active=True,
    )

    # Amb C: Very close (0.5 km away), but BLS with NO ventilator / NO defibrillator -> MUST BE EXCLUDED FOR ALS
    amb_close_bare_bls = Ambulance(
        id=103,
        call_sign="AMB-CLOSE-BARE-BLS",
        vehicle_type="BLS",
        paramedic_level="BASIC",
        status="AVAILABLE",
        base_station="Kadri Hills Gate",
        current_latitude=12.8765,
        current_longitude=74.8575,
        fuel_level_percent=95,
        equipment=["stretcher", "bandages"],  # No oxygen, no ventilator, no defibrillator
        is_active=True,
    )

    # Amb D: Moderate distance (3 km away), full ALS equipment, 90% fuel -> SUITABLE
    amb_moderate_als = Ambulance(
        id=104,
        call_sign="AMB-MODERATE-ALS",
        vehicle_type="ALS",
        paramedic_level="ADVANCED",
        status="AVAILABLE",
        base_station="KMC Ambedkar Circle",
        current_latitude=12.8718,
        current_longitude=74.8458,
        fuel_level_percent=90,
        equipment=["ventilator", "defibrillator", "oxygen", "ecg_monitor"],
        is_active=True,
    )

    # Amb E: Farther (7 km away, Kuntikan AJ), full ALS equipment, 85% fuel -> SUITABLE but lower rank than D
    amb_far_als = Ambulance(
        id=105,
        call_sign="AMB-FAR-ALS",
        vehicle_type="ALS",
        paramedic_level="ADVANCED",
        status="AVAILABLE",
        base_station="AJ Kuntikan",
        current_latitude=12.8988,
        current_longitude=74.8465,
        fuel_level_percent=85,
        equipment=["ventilator", "defibrillator", "oxygen", "ecg_monitor"],
        is_active=True,
    )

    fleet = [amb_low_fuel, amb_busy, amb_close_bare_bls, amb_moderate_als, amb_far_als]

    # Test Case 1: Priority 1 Emergency requiring ALS
    p1_incident = Incident(
        id=999,
        caller_name="Critical Patient",
        caller_phone="+91 98450 11223",
        location_address="Kadri Park, Mangaluru",
        latitude=12.8770,
        longitude=74.8580,
        chief_complaint="Cardiac arrest, unresponsive, agonal breathing",
        triage_level="Priority 1 (Critical)",
        triage_color="RED",
        triage_score=100,
        required_ambulance_type="ALS",
        chest_pain=True,
        breathing_status="Absent",
        consciousness_level="Unresponsive",
    )

    results = score_and_rank_ambulances(incident=p1_incident, ambulances=fleet)

    excluded = results["excluded_ambulances"]
    excluded_map = {ex["call_sign"]: ex["reasons"] for ex in excluded}

    print(f"Total fleet: {len(fleet)}, Excluded count: {len(excluded)}, Ranked count: {len(results['ranked_ambulances'])}")

    # Verify exclusions
    assert "AMB-LOW-FUEL" in excluded_map, "Low fuel ambulance was not excluded!"
    assert any("Low fuel" in r for r in excluded_map["AMB-LOW-FUEL"]), f"Reason missing: {excluded_map['AMB-LOW-FUEL']}"
    print("✓ Hard exclusion verified: Low fuel (<20%) eliminated.")

    assert "AMB-BUSY" in excluded_map, "Busy (DISPATCHED) ambulance was not excluded!"
    assert any("DISPATCHED" in r for r in excluded_map["AMB-BUSY"]), f"Reason missing: {excluded_map['AMB-BUSY']}"
    print("✓ Hard exclusion verified: Busy (DISPATCHED) unit eliminated.")

    assert "AMB-CLOSE-BARE-BLS" in excluded_map, "Bare BLS ambulance without defibrillator/ventilator was not excluded for Priority 1 ALS incident!"
    assert any("Clinical capability mismatch" in r for r in excluded_map["AMB-CLOSE-BARE-BLS"])
    print("✓ Hard exclusion verified: Bare BLS vehicle eliminated for Priority 1 ALS incident.")

    # Verify ranking between moderate distance vs farther distance
    ranked = results["ranked_ambulances"]
    assert len(ranked) == 2, f"Expected exactly 2 suitable units, got {len(ranked)}"

    top_unit = ranked[0]
    second_unit = ranked[1]

    assert top_unit["call_sign"] == "AMB-MODERATE-ALS", f"Expected AMB-MODERATE-ALS to be #1, got {top_unit['call_sign']}"
    assert second_unit["call_sign"] == "AMB-FAR-ALS", f"Expected AMB-FAR-ALS to be #2, got {second_unit['call_sign']}"
    assert top_unit["total_score"] > second_unit["total_score"], "Closer suitable unit must score higher than farther suitable unit"
    print(f"✓ Ranking verified: Closer ALS ({top_unit['total_score']} pts) ranked over Farther ALS ({second_unit['total_score']} pts).")

    # Verify breakdown weights calculation:
    for u in ranked:
        bd = u["score_breakdown"]
        reconstructed = (
            0.40 * bd["proximity_eta_score"]
            + 0.25 * bd["capability_match_score"]
            + 0.20 * bd["equipment_score"]
            + 0.15 * bd["readiness_score"]
        )
        assert abs(round(reconstructed, 1) - u["total_score"]) <= 0.2, f"Score mismatch: {reconstructed} vs {u['total_score']}"
    print("✓ Scoring formula arithmetic verified against all weights.")
    print("ALL AMBULANCE ALLOCATION SCENARIOS VERIFIED.")

if __name__ == "__main__":
    test_allocation_scenarios()
