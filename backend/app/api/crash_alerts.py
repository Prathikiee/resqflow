import json
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.app.core.database import get_db
from backend.app.models.entities import CrashAlert, Ambulance, Hospital, Dispatch, Incident, User
from backend.app.schemas.crash_alert import (
    CrashAlertIngest,
    CrashAlertSimulate,
    CrashAlertResponseUpdate,
    CrashAlertOut,
)
from backend.app.core.auth import (
    get_optional_current_user,
    ROLE_CITIZEN,
    ROLE_AMBULANCE_CREW,
    ROLE_HOSPITAL_STAFF,
    ROLE_DISPATCHER,
    ROLE_SUPER_ADMIN,
)
from backend.app.core.ws import broadcast_sync
from backend.app.services.timeline_service import log_incident_event

router = APIRouter(prefix="/api/crash-alerts", tags=["crash-alerts"])

ACTIVE_DISPATCH_STATUSES = [
    "ASSIGNED",
    "ACKNOWLEDGED",
    "EN_ROUTE_INCIDENT",
    "ON_SCENE",
    "EN_ROUTE_HOSPITAL",
    "AT_HOSPITAL",
    "EN_ROUTE",
    "TRANSPORTING",
]

def get_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

@router.post("/ingest", response_model=CrashAlertOut, status_code=status.HTTP_201_CREATED)
def ingest_crash_alert(
    payload: CrashAlertIngest,
    db: Session = Depends(get_db),
):
    """
    Hardware IoT Crash Telemetry Ingestion Contract.
    Intended for future ESP32 / IMU / GPS / GSM onboard telemetry integration.
    Automatically resolves the active transport dispatch, allocated incident,
    and destination hospital facility, then broadcasts an immediate priority alert.
    """
    ambulance = db.query(Ambulance).filter(Ambulance.id == payload.ambulance_id).first()
    if not ambulance:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Ambulance unit #{payload.ambulance_id} not registered in regional fleet",
        )

    # Find active dispatch for this ambulance unit
    active_dispatch = (
        db.query(Dispatch)
        .filter(
            Dispatch.ambulance_id == ambulance.id,
            Dispatch.status.in_(ACTIVE_DISPATCH_STATUSES),
        )
        .order_by(Dispatch.created_at.desc())
        .first()
    )

    hospital_id = None
    incident_id = None
    dispatch_id = None

    if active_dispatch:
        hospital_id = active_dispatch.destination_hospital_id
        incident_id = active_dispatch.incident_id
        dispatch_id = active_dispatch.id

    # Fallback to first available hospital if no active transport
    if not hospital_id:
        hosp = db.query(Hospital).first()
        if not hosp:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No registered hospital facilities available to receive crash alert",
            )
        hospital_id = hosp.id

    # Duplicate-alert debouncing: check for recent active alert within last 30 seconds
    cutoff_time = get_utc_now() - timedelta(seconds=30)
    recent_alert = (
        db.query(CrashAlert)
        .filter(
            CrashAlert.ambulance_id == ambulance.id,
            CrashAlert.status.in_(["TRIGGERED", "ACKNOWLEDGED"]),
            CrashAlert.created_at >= cutoff_time,
        )
        .order_by(CrashAlert.created_at.desc())
        .first()
    )

    # Threshold validation & false-positive assessment
    sensor_data = payload.sensor_data or {}
    severity = payload.severity
    g_force = sensor_data.get("g_force")
    airbag = sensor_data.get("airbag_deployed", False)
    rollover = sensor_data.get("rollover", False)

    # If sensor telemetry indicates sub-threshold reading without structural damage
    if g_force is not None and g_force < 2.5 and not airbag and not rollover:
        severity = "MINOR"

    if recent_alert:
        # Update existing active alert with latest sensor telemetry and location
        recent_alert.latitude = payload.latitude
        recent_alert.longitude = payload.longitude
        if payload.location_description:
            recent_alert.location_description = payload.location_description
        if sensor_data:
            recent_alert.sensor_data = sensor_data
        recent_alert.updated_at = get_utc_now()
        db.commit()
        db.refresh(recent_alert)
        alert = recent_alert
    else:
        alert = CrashAlert(
            ambulance_id=ambulance.id,
            incident_id=incident_id,
            hospital_id=hospital_id,
            dispatch_id=dispatch_id,
            source=payload.source or "HARDWARE_IOT",
            severity=severity,
            latitude=payload.latitude,
            longitude=payload.longitude,
            location_description=payload.location_description or f"Near {payload.latitude:.4f}, {payload.longitude:.4f}",
            sensor_data_json=json.dumps(sensor_data),
            status="TRIGGERED",
        )
        db.add(alert)
        db.commit()
        db.refresh(alert)

    # Log incident timeline event if tied to an active incident
    if incident_id and not recent_alert:
        log_incident_event(
            db=db,
            incident_id=incident_id,
            dispatch_id=dispatch_id,
            event_type="AMBULANCE_CRASH_ALERT",
            event_title="Ambulance Collision Detected",
            event_description=f"CRITICAL: Crash alert received for assigned unit {ambulance.call_sign} (Severity: {alert.severity})",
            actor_type="SYSTEM",
            actor_reference=f"IoT Telemetry / {alert.source}",
            metadata={
                "crash_alert_id": alert.id,
                "ambulance_id": ambulance.id,
                "ambulance_call_sign": ambulance.call_sign,
                "severity": alert.severity,
                "sensor_data": alert.sensor_data,
                "latitude": alert.latitude,
                "longitude": alert.longitude,
            },
        )

    # Scoped broadcast to destination hospital and dispatchers
    broadcast_sync(
        event_type="AMBULANCE_CRASH_DETECTED",
        data={
            "alert_id": alert.id,
            "ambulance_id": ambulance.id,
            "ambulance_call_sign": ambulance.call_sign,
            "incident_id": incident_id,
            "hospital_id": hospital_id,
            "hospital_name": alert.hospital_name,
            "dispatch_id": dispatch_id,
            "severity": alert.severity,
            "latitude": alert.latitude,
            "longitude": alert.longitude,
            "location_description": alert.location_description,
            "sensor_data": alert.sensor_data,
            "source": alert.source,
            "status": alert.status,
            "created_at": alert.created_at.isoformat() if alert.created_at else None,
        },
        hospital_id=hospital_id,
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="crash_alert",
        entity_id=alert.id,
    )

    return alert

@router.post("/simulate", response_model=CrashAlertOut, status_code=status.HTTP_201_CREATED)
def simulate_crash_alert(
    payload: Optional[CrashAlertSimulate] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Clearly labeled DEMO Simulation Endpoint for Demonstrating Crash Detection & Hospital Alerts.
    Generates realistic collision telemetry (g-force, rollover status, impact speed).
    """
    auth_user = current_user if isinstance(current_user, User) else None
    amb_id = payload.ambulance_id if payload else None
    target_hospital_id = None

    if auth_user and auth_user.role == ROLE_HOSPITAL_STAFF and auth_user.hospital_id:
        target_hospital_id = auth_user.hospital_id

    # If no specific ambulance requested, find one with an active dispatch to this hospital
    active_dispatch = None
    if target_hospital_id:
        active_dispatch = (
            db.query(Dispatch)
            .filter(
                Dispatch.destination_hospital_id == target_hospital_id,
                Dispatch.status.in_(ACTIVE_DISPATCH_STATUSES),
            )
            .order_by(Dispatch.created_at.desc())
            .first()
        )

    if not active_dispatch and amb_id:
        active_dispatch = (
            db.query(Dispatch)
            .filter(
                Dispatch.ambulance_id == amb_id,
                Dispatch.status.in_(ACTIVE_DISPATCH_STATUSES),
            )
            .order_by(Dispatch.created_at.desc())
            .first()
        )

    # Select ambulance
    ambulance = None
    if active_dispatch:
        ambulance = active_dispatch.ambulance
    elif amb_id:
        ambulance = db.query(Ambulance).filter(Ambulance.id == amb_id).first()
    else:
        ambulance = db.query(Ambulance).first()

    if not ambulance:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No operational ambulance available to simulate crash",
        )

    # Determine receiving hospital
    hosp_first = db.query(Hospital).first()
    default_hosp_id = hosp_first.id if hosp_first else 1
    hospital_id = (
        (active_dispatch.destination_hospital_id if active_dispatch else None)
        or target_hospital_id
        or default_hosp_id
    )

    incident_id = active_dispatch.incident_id if active_dispatch else None
    dispatch_id = active_dispatch.id if active_dispatch else None

    # Realistic simulated telemetry
    severity = payload.severity if payload and payload.severity else "CRITICAL"
    sensor_data = {
        "g_force": 5.4,
        "rollover": False,
        "impact_velocity_kmh": 64,
        "airbag_deployed": True,
        "front_chassis_deformation": "HIGH",
        "patient_cabin_intact": True,
        "vital_monitors_online": True,
    }

    # Location near Mangaluru coordinates
    lat = ambulance.current_latitude if ambulance.current_latitude else 12.8710
    lng = ambulance.current_longitude if ambulance.current_longitude else 74.8450

    # Debouncing / deduplication for simulation: check for recent active simulated alert within last 30 seconds
    cutoff_time = get_utc_now() - timedelta(seconds=30)
    recent_alert = (
        db.query(CrashAlert)
        .filter(
            CrashAlert.ambulance_id == ambulance.id,
            CrashAlert.source == "DEMO_SIMULATION",
            CrashAlert.status.in_(["TRIGGERED", "ACKNOWLEDGED", "TEAM_NOTIFIED", "BACKUP_REQUESTED"]),
            CrashAlert.created_at >= cutoff_time,
        )
        .order_by(CrashAlert.created_at.desc())
        .first()
    )

    if recent_alert:
        # Debounce: update existing active alert with refreshed telemetry instead of spawning duplicate rows
        recent_alert.latitude = lat
        recent_alert.longitude = lng
        if payload and payload.location_description:
            recent_alert.location_description = payload.location_description
        recent_alert.sensor_data = sensor_data
        recent_alert.updated_at = get_utc_now()
        db.commit()
        db.refresh(recent_alert)
        alert = recent_alert
    else:
        alert = CrashAlert(
            ambulance_id=ambulance.id,
            incident_id=incident_id,
            hospital_id=hospital_id,
            dispatch_id=dispatch_id,
            source="DEMO_SIMULATION",
            severity=severity,
            latitude=lat,
            longitude=lng,
            location_description=payload.location_description if payload and payload.location_description else f"MG Road / Ambedkar Circle intersection near {ambulance.call_sign}",
            sensor_data_json=json.dumps(sensor_data),
            status="TRIGGERED",
        )
        db.add(alert)
        db.commit()
        db.refresh(alert)

    if incident_id and not recent_alert:
        log_incident_event(
            db=db,
            incident_id=incident_id,
            dispatch_id=dispatch_id,
            event_type="AMBULANCE_CRASH_ALERT",
            event_title="Ambulance Collision Simulated",
            event_description=f"CRITICAL: Crash simulated for assigned unit {ambulance.call_sign} (Severity: {alert.severity})",
            actor_type="SYSTEM",
            actor_reference=f"Simulation ({auth_user.email if auth_user else 'Demo Operator'})",
            metadata={
                "crash_alert_id": alert.id,
                "ambulance_call_sign": ambulance.call_sign,
                "sensor_data": sensor_data,
            },
        )

    # Scoped broadcast to destination hospital and dispatchers
    broadcast_sync(
        event_type="AMBULANCE_CRASH_DETECTED",
        data={
            "alert_id": alert.id,
            "ambulance_id": ambulance.id,
            "ambulance_call_sign": ambulance.call_sign,
            "incident_id": incident_id,
            "hospital_id": hospital_id,
            "hospital_name": alert.hospital_name,
            "dispatch_id": dispatch_id,
            "severity": alert.severity,
            "latitude": alert.latitude,
            "longitude": alert.longitude,
            "location_description": alert.location_description,
            "sensor_data": alert.sensor_data,
            "source": alert.source,
            "status": alert.status,
            "created_at": alert.created_at.isoformat() if alert.created_at else None,
        },
        hospital_id=hospital_id,
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="crash_alert",
        entity_id=alert.id,
    )

    return alert

@router.get("", response_model=List[CrashAlertOut])
def list_crash_alerts(
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    List crash alerts with strict hospital and role isolation:
    - Hospital staff can ONLY view crash alerts for their assigned hospital.
    - Citizens cannot view crash alerts.
    - Dispatchers and admins have regional visibility.
    """
    auth_user = current_user if isinstance(current_user, User) else None
    query = db.query(CrashAlert)

    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Citizens are not authorized to view fleet crash alerts",
            )
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id:
                return []
            query = query.filter(CrashAlert.hospital_id == auth_user.hospital_id)
        elif auth_user.role == ROLE_AMBULANCE_CREW:
            if not auth_user.ambulance_id:
                return []
            query = query.filter(CrashAlert.ambulance_id == auth_user.ambulance_id)

    return query.order_by(CrashAlert.created_at.desc()).all()

@router.get("/{alert_id}", response_model=CrashAlertOut)
def get_crash_alert(
    alert_id: int,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Retrieve single crash alert with strict hospital data isolation.
    """
    alert = db.query(CrashAlert).filter(CrashAlert.id == alert_id).first()
    if not alert:
        raise HTTPException(status_code=404, detail="Crash alert record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Citizens are not authorized to view crash alerts",
            )
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or alert.hospital_id != auth_user.hospital_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied: Cannot view crash alerts for another hospital facility",
                )
        elif auth_user.role == ROLE_AMBULANCE_CREW:
            if not auth_user.ambulance_id or alert.ambulance_id != auth_user.ambulance_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied: Cannot view crash alerts for another ambulance unit",
                )

    return alert

@router.patch("/{alert_id}/respond", response_model=CrashAlertOut)
def respond_to_crash_alert(
    alert_id: int,
    payload: CrashAlertResponseUpdate,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_current_user),
):
    """
    Hospital Response / Acknowledgment to an ambulance crash alert.
    Supports updating status (ACKNOWLEDGED, TEAM_NOTIFIED, BACKUP_REQUESTED, RESOLVED)
    and adding internal hospital trauma response notes.
    """
    alert = db.query(CrashAlert).filter(CrashAlert.id == alert_id).first()
    if not alert:
        raise HTTPException(status_code=404, detail="Crash alert record not found")

    auth_user = current_user if isinstance(current_user, User) else None
    if auth_user:
        if auth_user.role == ROLE_CITIZEN:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Citizens cannot modify crash alert responses",
            )
        elif auth_user.role == ROLE_HOSPITAL_STAFF:
            if not auth_user.hospital_id or alert.hospital_id != auth_user.hospital_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Access denied: Cannot respond to crash alerts for another hospital facility",
                )

    valid_statuses = ["TRIGGERED", "ACKNOWLEDGED", "TEAM_NOTIFIED", "BACKUP_REQUESTED", "RESOLVED"]
    if payload.status not in valid_statuses:
        raise HTTPException(status_code=400, detail=f"Invalid status '{payload.status}'. Must be one of {valid_statuses}")

    alert.status = payload.status
    if payload.response_notes:
        existing_notes = alert.response_notes or ""
        timestamp_str = datetime.now(timezone.utc).strftime("%H:%M:%S")
        prefix = f"[{timestamp_str}] "
        if existing_notes:
            alert.response_notes = f"{existing_notes}\n{prefix}{payload.response_notes}"
        else:
            alert.response_notes = f"{prefix}{payload.response_notes}"

    if not alert.acknowledged_at:
        alert.acknowledged_at = get_utc_now()
        alert.acknowledged_by = payload.acknowledged_by or (auth_user.email if auth_user else "Hospital ER Staff")

    if alert.status == "RESOLVED":
        # Safely resolve any sibling un-debounced duplicate records from the same burst
        if alert.created_at:
            time_lower = alert.created_at - timedelta(seconds=60)
            time_upper = alert.created_at + timedelta(seconds=60)
            sibling_duplicates = (
                db.query(CrashAlert)
                .filter(
                    CrashAlert.id != alert.id,
                    CrashAlert.ambulance_id == alert.ambulance_id,
                    CrashAlert.source == alert.source,
                    CrashAlert.status != "RESOLVED",
                    CrashAlert.created_at >= time_lower,
                    CrashAlert.created_at <= time_upper,
                )
                .all()
            )
            for sib in sibling_duplicates:
                sib.status = "RESOLVED"
                sib.acknowledged_at = sib.acknowledged_at or alert.acknowledged_at
                sib.acknowledged_by = sib.acknowledged_by or alert.acknowledged_by
                if payload.response_notes:
                    sib.response_notes = (sib.response_notes or "") + f"\n[Resolved via alert #{alert.id}]"

    db.commit()
    db.refresh(alert)

    if alert.incident_id:
        log_incident_event(
            db=db,
            incident_id=alert.incident_id,
            dispatch_id=alert.dispatch_id,
            event_type="CRASH_ALERT_RESPONSE_UPDATED",
            event_title="Hospital Crash Response Updated",
            event_description=f"Hospital updated crash response to {alert.status}",
            actor_type="HOSPITAL_STAFF" if auth_user and auth_user.role == ROLE_HOSPITAL_STAFF else "SYSTEM",
            actor_reference=alert.acknowledged_by or "Hospital Staff",
            metadata={
                "crash_alert_id": alert.id,
                "status": alert.status,
                "notes": alert.response_notes,
            },
        )

    # Scoped broadcast
    broadcast_sync(
        event_type="CRASH_ALERT_UPDATED",
        data={
            "alert_id": alert.id,
            "ambulance_id": alert.ambulance_id,
            "incident_id": alert.incident_id,
            "hospital_id": alert.hospital_id,
            "status": alert.status,
            "acknowledged_at": alert.acknowledged_at.isoformat() if alert.acknowledged_at else None,
            "acknowledged_by": alert.acknowledged_by,
            "response_notes": alert.response_notes,
        },
        hospital_id=alert.hospital_id,
        target_roles=[ROLE_DISPATCHER, ROLE_SUPER_ADMIN],
        entity_type="crash_alert",
        entity_id=alert.id,
    )

    return alert
