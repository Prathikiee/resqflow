import pytest
import time
from datetime import datetime, timezone
from backend.app.services.routing_service import calculate_route, calculate_bearing, generate_fallback_steps
from backend.app.api.dispatch import preview_route, advance_dispatch_lifecycle
from backend.app.api.ambulances import update_ambulance_telemetry
from backend.app.schemas.ambulance import AmbulanceLocationUpdate
from backend.app.models.entities import Ambulance, Dispatch, Incident, Hospital, User

def test_bearing_calculation():
    """Verify compass bearing calculation produces accurate 0-360 angles for cardinal directions."""
    # North
    b_north = calculate_bearing(12.0, 74.0, 13.0, 74.0)
    assert abs(b_north - 0.0) < 1.0 or abs(b_north - 360.0) < 1.0

    # East
    b_east = calculate_bearing(12.0, 74.0, 12.0, 75.0)
    assert abs(b_east - 90.0) < 1.0

    # South
    b_south = calculate_bearing(13.0, 74.0, 12.0, 74.0)
    assert abs(b_south - 180.0) < 1.0

    # West
    b_west = calculate_bearing(12.0, 75.0, 12.0, 74.0)
    assert abs(b_west - 270.0) < 1.0

def test_routing_service_output_and_fallback():
    """Verify calculate_route produces road geometry, turn-by-turn steps, distance, and duration."""
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

    steps = route["steps"]
    assert isinstance(steps, list)
    assert len(steps) >= 1

    first_step = steps[0]
    assert "instruction" in first_step
    assert "distance_meters" in first_step
    assert "duration_seconds" in first_step
    assert "type" in first_step
    assert "location" in first_step
    assert "bearing" in first_step

def test_dispatch_preview_route_endpoint():
    """Verify preview_route endpoint produces valid road geometry and steps."""
    data = preview_route(
        start_lat=12.8715,
        start_lon=74.8431,
        dest_lat=12.8845,
        dest_lon=74.8580,
    )
    assert "geometry" in data
    assert "distance_meters" in data
    assert "duration_seconds" in data
    assert "steps" in data
    assert len(data["steps"]) >= 1

def test_ambulance_telemetry_patch_and_stale_protection(db):
    """Verify update_ambulance_telemetry ingests telemetry and defends against stale buffered packets."""
    user = db.query(User).filter(User.role == "AMBULANCE_CREW").first()
    assert user is not None
    amb = db.query(Ambulance).filter(Ambulance.id == user.ambulance_id).first()
    if not amb:
        amb = db.query(Ambulance).first()
        user.ambulance_id = amb.id
        db.commit()
    amb_id = amb.id

    now_ts = time.time()

    # 1. Ingest fresh telemetry with live GPS parameters
    fresh_payload = AmbulanceLocationUpdate(
        latitude=12.8755,
        longitude=74.8455,
        heading=72.4,
        speed=45.2,
        accuracy=6.8,
        is_simulated=False,
        timestamp=now_ts,
    )
    updated = update_ambulance_telemetry(ambulance_id=amb_id, payload=fresh_payload, db=db, current_user=user)
    assert abs(updated.current_latitude - 12.8755) < 0.0001
    assert abs(updated.current_longitude - 74.8455) < 0.0001

    # 2. Transmit stale packet (e.g. buffered from 60 seconds ago)
    stale_payload = AmbulanceLocationUpdate(
        latitude=12.0000,
        longitude=74.0000,
        heading=0.0,
        speed=0.0,
        accuracy=10.0,
        is_simulated=False,
        timestamp=now_ts - 60.0,
    )
    stale_res = update_ambulance_telemetry(ambulance_id=amb_id, payload=stale_payload, db=db, current_user=user)
    # Must preserve recent 12.8755 coordinate rather than regressing to 12.0000
    assert abs(stale_res.current_latitude - 12.8755) < 0.0001
    assert abs(stale_res.current_longitude - 74.8455) < 0.0001

def test_telemetry_dispatch_mismatch_protection(db):
    """Verify telemetry targeting an inactive or wrong dispatch_id is safely ignored."""
    user = db.query(User).filter(User.role == "AMBULANCE_CREW").first()
    assert user is not None
    amb = db.query(Ambulance).filter(Ambulance.id == user.ambulance_id).first()
    if not amb:
        amb = db.query(Ambulance).first()
        user.ambulance_id = amb.id
        db.commit()

    # Create an active dispatch bound to this ambulance
    incident = db.query(Incident).first()
    active_disp = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        status="ASSIGNED",
        coordination_status="PENDING_CONFIRMATIONS",
        attempt_number=1,
    )
    db.add(active_disp)
    db.commit()
    db.refresh(active_disp)

    # Send telemetry with a completely wrong dispatch_id (e.g. 999999)
    mismatch_payload = AmbulanceLocationUpdate(
        latitude=12.9999,
        longitude=74.9999,
        heading=180.0,
        speed=50.0,
        dispatch_id=999999,
        timestamp=time.time(),
    )
    res = update_ambulance_telemetry(ambulance_id=amb.id, payload=mismatch_payload, db=db, current_user=user)
    # Coordinates must NOT change to 12.9999
    assert abs(res.current_latitude - 12.9999) > 0.01

def test_advance_dispatch_lifecycle_navigation_flow(db):
    """Verify step endpoint advances through the navigation milestones: ACCEPTED -> EN_ROUTE_INCIDENT -> ON_SCENE."""
    incident = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    hosp = db.query(Hospital).first()

    disp = Dispatch(
        incident_id=incident.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        status="ASSIGNED",
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # 1. Step 1: ASSIGNED -> EN_ROUTE_INCIDENT
    step1 = advance_dispatch_lifecycle(dispatch_id=disp.id, db=db)
    assert step1.status == "EN_ROUTE_INCIDENT"

    # 2. Step 2: EN_ROUTE_INCIDENT -> ON_SCENE (Arrived at Patient)
    step2 = advance_dispatch_lifecycle(dispatch_id=disp.id, db=db)
    assert step2.status == "ON_SCENE"

    # 3. Step 3: ON_SCENE -> EN_ROUTE_HOSPITAL
    step3 = advance_dispatch_lifecycle(dispatch_id=disp.id, db=db)
    assert step3.status == "EN_ROUTE_HOSPITAL"
