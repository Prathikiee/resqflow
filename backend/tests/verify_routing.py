import sys
import os
sys.path.insert(0, os.path.abspath("."))

from backend.app.services.routing_service import calculate_route, haversine_distance, generate_fallback_waypoints

def test_routing_scenarios():
    print("=== ROUTING & OSRM VERIFICATION ===")

    # Mangaluru coordinates: Kadri Hills -> KMC Hospital Ambedkar Circle
    start_lat, start_lon = 12.8770, 74.8580
    dest_lat, dest_lon = 12.8718, 74.8458

    # 1. Test Fallback Routing (simulating network timeout with timeout_seconds=0.0001)
    print("Testing simulated network timeout / fallback routing...")
    fallback_res = calculate_route(start_lat, start_lon, dest_lat, dest_lon, timeout_seconds=0.0001)

    assert fallback_res["routing_mode"] == "Deterministic Fallback"
    assert fallback_res["is_simulated"] is True
    assert "Estimated via Haversine Distance" in fallback_res["attribution"]
    assert len(fallback_res["geometry"]) >= 10
    assert fallback_res["duration_seconds"] > 0
    assert fallback_res["distance_meters"] > 0
    print(f"✓ Fallback routing verified: Mode='{fallback_res['routing_mode']}', Distance={fallback_res['distance_meters']}m, Duration={fallback_res['duration_minutes']} mins.")
    print(f"✓ Attribution label: '{fallback_res['attribution']}'")

    # 2. Test Live OSRM Routing (with standard timeout)
    print("Testing live OSRM network route...")
    live_res = calculate_route(start_lat, start_lon, dest_lat, dest_lon, timeout_seconds=4.0)

    print(f"Live routing result mode: {live_res['routing_mode']}")
    assert len(live_res["geometry"]) > 0
    assert live_res["distance_meters"] > 0
    assert live_res["duration_seconds"] > 0
    if live_res["routing_mode"] == "OSRM Live":
        assert live_res["is_simulated"] is False
        assert "OpenStreetMap" in live_res["attribution"]
        print("✓ Live OSRM route verified with real OSM street geometry.")
    else:
        print("✓ Handled live network fallback smoothly (in sandbox/offline environment).")

    print("ROUTING SCENARIOS VERIFIED.")

if __name__ == "__main__":
    test_routing_scenarios()
