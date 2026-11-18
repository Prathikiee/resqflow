import logging
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any
from sqlalchemy.orm import Session
from backend.app.models.entities import IncidentEvent
from backend.app.core.ws import broadcast_sync

logger = logging.getLogger(__name__)

def get_utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)

def log_incident_event(
    db: Session,
    incident_id: int,
    event_type: str,
    event_title: str,
    event_description: str,
    actor_type: str = "SYSTEM",
    actor_reference: Optional[str] = None,
    dispatch_id: Optional[int] = None,
    metadata: Optional[Dict[str, Any]] = None,
    deduplicate_seconds: int = 5,
    commit: bool = True,
) -> IncidentEvent:
    """
    FEATURE 5 — UNIFIED EMERGENCY COORDINATION TIMELINE:
    Records a persistent, chronological event in the incident history.
    Prevents duplicate entries on repeated API requests within deduplicate_seconds.
    Broadcasts INCIDENT_EVENT_LOGGED WebSocket event.
    """
    now = get_utc_now()

    # Deduplicate recent identical events to ensure idempotency
    if deduplicate_seconds > 0:
        recent_cutoff = now - timedelta(seconds=deduplicate_seconds)
        query = db.query(IncidentEvent).filter(
            IncidentEvent.incident_id == incident_id,
            IncidentEvent.event_type == event_type,
            IncidentEvent.created_at >= recent_cutoff,
        )
        if dispatch_id is not None:
            query = query.filter(IncidentEvent.dispatch_id == dispatch_id)
        existing = query.first()
        if existing:
            return existing

    event = IncidentEvent(
        incident_id=incident_id,
        dispatch_id=dispatch_id,
        event_type=event_type,
        event_title=event_title,
        event_description=event_description,
        actor_type=actor_type,
        actor_reference=actor_reference,
        created_at=now,
    )
    event.event_metadata = metadata or {}

    db.add(event)
    try:
        if commit:
            db.commit()
            db.refresh(event)
        else:
            db.flush()
    except Exception as e:
        logger.error(f"Error persisting incident event {event_type} for incident #{incident_id}: {e}")
        if commit:
            db.rollback()
        raise

    broadcast_sync(
        "INCIDENT_EVENT_LOGGED",
        {
            "event_id": event.id,
            "incident_id": incident_id,
            "dispatch_id": dispatch_id,
            "event_type": event_type,
            "event_title": event_title,
            "event_description": event_description,
            "actor_type": actor_type,
            "actor_reference": actor_reference,
            "created_at": event.created_at.isoformat(),
            "metadata": event.event_metadata,
        },
        entity_type="incident_event",
        entity_id=event.id,
        broadcast_to_all=True,
    )

    return event
