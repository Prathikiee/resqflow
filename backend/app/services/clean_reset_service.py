import logging
from typing import Dict, Any
from sqlalchemy.orm import Session
from backend.app.models.entities import (
    Incident,
    Dispatch,
    HandoverPacket,
    IncidentEvent,
    WitnessReport,
    CrashAlert,
    PatientVitals,
    Ambulance,
    Hospital,
    User,
    utc_now,
)
from backend.app.core.ws import broadcast_sync

logger = logging.getLogger("resqflow.clean_reset")

def execute_clean_demo_reset(db: Session, broadcast: bool = True) -> Dict[str, Any]:
    """
    Safely and transactionally clears all operational emergency cases across ResQFlow:
    - Patient vitals
    - Handover packets
    - Incident events & audit records
    - Witness reports
    - Crash alerts & collision telemetry records
    - Dispatches & dual confirmation attempts
    - Citizen & collision incidents
    
    Preserves:
    - All 30 seeded network hospitals, doctors, shifts, equipment, and departments
    - All ambulance master records (resets status to 'AVAILABLE', clears reservation_dispatch_id)
    - All user accounts and authentications
    - Sensor thresholds, hardware ingestion pipeline, ESP32 integration
    """
    # 1. Snapshot counts before
    counts_before = {
        "incidents": db.query(Incident).count(),
        "dispatches": db.query(Dispatch).count(),
        "handover_packets": db.query(HandoverPacket).count(),
        "incident_events": db.query(IncidentEvent).count(),
        "witness_reports": db.query(WitnessReport).count(),
        "crash_alerts": db.query(CrashAlert).count(),
        "patient_vitals": db.query(PatientVitals).count(),
        "ambulances": db.query(Ambulance).count(),
        "hospitals": db.query(Hospital).count(),
        "users": db.query(User).count(),
    }
    
    logger.info(f"Starting Clean Demo Reset. Before: {counts_before}")
    
    # 2. Delete operational emergency data in foreign-key dependency order
    deleted_vitals = db.query(PatientVitals).delete()
    deleted_handovers = db.query(HandoverPacket).delete()
    deleted_events = db.query(IncidentEvent).delete()
    deleted_witness = db.query(WitnessReport).delete()
    deleted_crash = db.query(CrashAlert).delete()
    deleted_dispatches = db.query(Dispatch).delete()
    deleted_incidents = db.query(Incident).delete()
    
    # 3. Reset Ambulance fleet master records to clean standby
    # Reset operational status to AVAILABLE, clear any reserved dispatch id
    ambulances = db.query(Ambulance).all()
    for amb in ambulances:
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        amb.is_active = True
        
    # 4. Reset Hospital operational reservation states
    # Clear reserved_emergency_beds to 0 and ensure readiness
    hospitals = db.query(Hospital).all()
    for hosp in hospitals:
        hosp.reserved_emergency_beds = 0
        hosp.accepting_emergencies = True
        hosp.readiness_status = "READY"
        
    db.commit()
    
    # 5. Snapshot counts after
    counts_after = {
        "incidents": db.query(Incident).count(),
        "dispatches": db.query(Dispatch).count(),
        "handover_packets": db.query(HandoverPacket).count(),
        "incident_events": db.query(IncidentEvent).count(),
        "witness_reports": db.query(WitnessReport).count(),
        "crash_alerts": db.query(CrashAlert).count(),
        "patient_vitals": db.query(PatientVitals).count(),
        "ambulances": db.query(Ambulance).count(),
        "hospitals": db.query(Hospital).count(),
        "users": db.query(User).count(),
    }
    
    logger.info(f"Clean Demo Reset completed. After: {counts_after}")
    
    # 6. Broadcast Realtime WebSocket Reset Event to all connected clients
    if broadcast:
        try:
            broadcast_sync(
                event_type="DEMO_RESET",
                data={
                    "action": "CLEAN_RESET",
                    "message": "All active emergency cases cleared for fresh demonstration.",
                    "timestamp": str(utc_now()),
                }
            )
        except Exception as ws_err:
            logger.warning(f"Could not broadcast reset event over WebSocket: {ws_err}")
            
    return {
        "status": "success",
        "message": "All operational emergency cases cleared successfully. All portals are clean.",
        "counts_before": counts_before,
        "counts_after": counts_after,
        "deleted": {
            "incidents": deleted_incidents,
            "dispatches": deleted_dispatches,
            "handover_packets": deleted_handovers,
            "incident_events": deleted_events,
            "witness_reports": deleted_witness,
            "crash_alerts": deleted_crash,
            "patient_vitals": deleted_vitals,
        },
        "preserved": {
            "hospitals": counts_after["hospitals"],
            "ambulances": counts_after["ambulances"],
            "users": counts_after["users"],
        }
    }
