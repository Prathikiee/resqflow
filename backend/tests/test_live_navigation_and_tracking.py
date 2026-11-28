import pytest
from datetime import datetime, timezone, timedelta
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.core.database import get_db
from backend.app.services.routing_service import calculate_route, calculate_bearing, generate_fallback_steps
from backend.app.models.entities import Ambulance, Dispatch, Incident, Hospital

client = TestClient(app)

@pytest.fixture
def auth_headers_ambulance():
    resp = client.post("/api/auth/token", data={"username": "ambulance_kmc_01", "password": "password123"})
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

def test_bearing_calculation():
    """Verify compass bearing calculation gives expected cardinal/intercardinal angles."""
    # Directly north
    b_north = calculate_bearing(12.0, 74.0, 13.0, 74.0)
    assert abs(b_north - 0.0) < 1.0 or abs(b_north - 360.0) < 1.0

    # Directly east
    b_east = calculate_bearing(12.0, 74.0, 12.0, 75.0)
    assert abs(b_east - 90.0) < 1.0

    # Directly south
    b_south = calculate_bearing(13.0, 74.0, 12.0, 74.0)
    assert abs(b_south - 180.0) < 1.0

    # Directly west
    b_west = calculate_bearing(12.0, 75.0, 12.0, 74.0)
    assert abs(b_west - 270.0) < 1.0

def test_routing_service_output_and_fallback():
    """Verify calculate_route returns geometry, steps, distance, and duration."""
    # Mangaluru KMC to Kadri Park
    start_lat, start_lon = 12.8715, 74.8431
    dest_lat, dest_lon = 12.8845, 74.8580

    route = calculate_route(start_lat, start_lon, dest_lat, dest_lon)
    assert "geometry" in route
    assert "distance_meters" in route
    assert "duration_seconds" in route
    assert "steps" in route
    assert len(route["geometry"]) >= 2
    assert route["distance_meters"] > 0
    assert route["duration_seconds"] > 0

    # Verify steps structure
    steps = route["steps"]
    assert isinstance(steps, list)
    assert len(steps) >= 1
    first_step = steps[0]
    assert "instruction" in first_step
    assert "distance_meters" in first_step
    assert "duration_seconds" in first_step
    assert "type" in first_step

def test_dispatch_route_api():
    """Verify /api/dispatch/route endpoint provides road routes with turn-by-turn steps."""
    resp = client.get("/api/dispatch/route", params={
        "start_lat": 12.8715,
        "start_lon": 74.8431,
        "dest_lat": 12.8845,
        "dest_lon": 74.8580,
        "dest_label": "Emergency Incident"
    })
    assert resp.status_code == 200
    data = resp.json()
    assert "geometry" in data
    assert "distance_meters" in data
    assert "duration_seconds" in data
    assert "steps" in data
    assert len(data["steps"]) >= 1
    assert data["routing_mode"] in ["OSRM_ROAD_NETWORK", "EMERGENCY_CORRIDOR_ROAD_MODEL"]

def test_ambulance_telemetry_ingestion_and_protection(auth_headers_ambulance):
    """Verify PATCH /api/ambulances/{id}/telemetry accepts heading, speed, simulation flag, and guards against stale data."""
    # 1. Fetch ambulance list to get a valid ID
    amb_resp = client.get("/api/ambulances", headers=auth_headers_ambulance)
    assert amb_resp.status_code == 200
    ambulances = amb_resp.json()
    assert len(ambulances) > 0
    amb = ambulances[0]
    amb_id = amb["id"]

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    # 2. Send valid live telemetry
    telemetry_payload = {
        "latitude": 12.8750,
        "longitude": 74.8450,
        "heading": 45.2,
        "speed": 35.8,
        "accuracy": 8.0,
        "is_simulated": False,
        "timestamp": now_iso
    }
    patch_resp = client.patch(f"/api/ambulances/{amb_id}/telemetry", json=telemetry_payload, headers=auth_headers_ambulance)
    assert patch_resp.status_code == 200
    updated_amb = patch_resp.json()
    assert abs(updated_amb["current_latitude"] - 12.8750) < 0.0001
    assert abs(updated_amb["current_longitude"] - 74.8450) < 0.0001

    # 3. Send stale telemetry (e.g. 10 minutes ago)
    stale_time = (now - timedelta(minutes=10)).isoformat()
    stale_payload = {
        "latitude": 12.0000,
        "longitude": 74.0000,
        "heading": 0.0,
        "speed": 0.0,
        "accuracy": 10.0,
        "is_simulated": False,
        "timestamp": stale_time
    }
    stale_resp = client.patch(f"/api/ambulances/{amb_id}/telemetry", json=stale_payload, headers=auth_headers_ambulance)
    # Stale coordinate must be rejected/ignored, preserving the latest coordinate
    assert stale_resp.status_code == 200
    assert abs(stale_resp.json()["current_latitude"] - 12.8750) < 0.0001

def test_telemetry_dispatch_mismatch_protection(auth_headers_ambulance):
    """Verify telemetry with mismatched dispatch_id is safely ignored."""
    amb_resp = client.get("/api/ambulances", headers=auth_headers_ambulance)
    amb_id = amb_resp.json()[0]["id"]

    now_iso = datetime.now(timezone.utc).isoformat()
    # Non-existent dispatch 999999
    payload = {
        "latitude": 12.9999,
        "longitude": 74.9999,
        "heading": 180.0,
        "speed": 50.0,
        "accuracy": 5.0,
        "is_simulated": True,
        "dispatch_id": 999999,
        "timestamp": now_iso
    }
    resp = client.patch(f"/api/ambulances/{amb_id}/telemetry", json=payload, headers=auth_headers_ambulance)
    assert resp.status_code == 200
    # Current coordinates must NOT have updated to 12.9999
    assert abs(resp.json()["current_latitude"] - 12.9999) > 0.01
