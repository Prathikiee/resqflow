import logging
import asyncio
import uuid
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import List, Dict, Any, Optional, Union
from fastapi import WebSocket

logger = logging.getLogger(__name__)

ROLE_CITIZEN = "CITIZEN"
ROLE_AMBULANCE_CREW = "AMBULANCE_CREW"
ROLE_HOSPITAL_STAFF = "HOSPITAL_STAFF"
ROLE_DISPATCHER = "DISPATCHER"
ROLE_SUPER_ADMIN = "SUPER_ADMIN"

REGIONAL_COORDINATOR_ROLES = {ROLE_DISPATCHER, ROLE_SUPER_ADMIN}

@dataclass
class WebSocketClient:
    websocket: WebSocket
    user_id: int
    email: str
    role: str
    ambulance_id: Optional[int] = None
    hospital_id: Optional[int] = None
    facility_code: Optional[str] = None
    connected_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

def create_event_envelope(
    event_type: str,
    payload: Dict[str, Any],
    entity_type: Optional[str] = None,
    entity_id: Optional[Union[int, str]] = None,
    event_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Constructs a structured, typed event envelope for cross-portal delivery.
    """
    resolved_entity_type = entity_type or payload.get("entity_type")
    resolved_entity_id = entity_id or payload.get("entity_id") or payload.get("dispatch_id") or payload.get("incident_id")
    
    return {
        "event_id": event_id or f"evt_{uuid.uuid4().hex[:12]}",
        "event": event_type,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "entity_type": resolved_entity_type,
        "entity_id": resolved_entity_id,
        "payload": payload,
        "data": payload,  # Backward compatibility alias
    }

class ConnectionManager:
    """
    Authenticated, role-aware, and organization-isolated WebSocket Connection Manager.
    Supports targeted event delivery across Regional Dispatchers, Ambulance Crews,
    Hospital ER Staff, and Citizen Reporters.
    """
    def __init__(self):
        self.active_clients: List[WebSocketClient] = []

    @property
    def active_connections(self) -> List[WebSocket]:
        """Backwards compatibility for legacy checks."""
        return [client.websocket for client in self.active_clients]

    async def connect(
        self,
        websocket: WebSocket,
        user_meta: Optional[Dict[str, Any]] = None,
    ) -> WebSocketClient:
        await websocket.accept()
        meta = user_meta or {}
        
        # Parse user identifiers safely
        raw_uid = meta.get("sub") or meta.get("id") or 0
        try:
            uid = int(raw_uid)
        except (ValueError, TypeError):
            uid = 0

        raw_amb_id = meta.get("ambulance_id")
        amb_id = int(raw_amb_id) if raw_amb_id is not None else None

        raw_hosp_id = meta.get("hospital_id")
        hosp_id = int(raw_hosp_id) if raw_hosp_id is not None else None

        client = WebSocketClient(
            websocket=websocket,
            user_id=uid,
            email=str(meta.get("email", "anonymous")),
            role=str(meta.get("role", "ANONYMOUS")),
            ambulance_id=amb_id,
            hospital_id=hosp_id,
            facility_code=meta.get("facility_code"),
        )
        self.active_clients.append(client)
        logger.info(
            f"WebSocket connected: user_id={client.user_id}, role={client.role}, "
            f"email={client.email}, active_total={len(self.active_clients)}"
        )
        return client

    def disconnect(self, websocket: WebSocket):
        self.active_clients = [c for c in self.active_clients if c.websocket != websocket]
        logger.info(f"WebSocket client disconnected. Total active: {len(self.active_clients)}")

    def is_client_eligible(
        self,
        client: WebSocketClient,
        target_roles: Optional[List[str]] = None,
        ambulance_id: Optional[int] = None,
        hospital_id: Optional[int] = None,
        reporter_user_id: Optional[int] = None,
        broadcast_to_all: bool = False,
    ) -> bool:
        """
        Evaluates whether a connected client is authorized to receive a targeted event.
        - Regional coordinators (DISPATCHER, SUPER_ADMIN) have regional operational oversight.
        - Paramedics receive events matching their assigned unit ID (ambulance_id).
        - Hospital ER staff receive events matching their assigned hospital facility ID (hospital_id).
        - Citizens receive events matching their personal reported emergency (reporter_user_id).
        """
        if broadcast_to_all:
            return True

        # Regional Dispatchers and Admins receive all operational coordination events
        if client.role in REGIONAL_COORDINATOR_ROLES:
            return True

        # Target by specific roles (e.g. explicitly targeted roles)
        if target_roles and client.role in target_roles:
            return True

        # Target by assigned ambulance unit
        if ambulance_id is not None and client.role == ROLE_AMBULANCE_CREW and client.ambulance_id == ambulance_id:
            return True

        # Target by assigned hospital facility
        if hospital_id is not None and client.role == ROLE_HOSPITAL_STAFF and client.hospital_id == hospital_id:
            return True

        # Target by citizen reporter user ID
        if reporter_user_id is not None and client.role == ROLE_CITIZEN and client.user_id == reporter_user_id:
            return True

        return False

    async def broadcast(
        self,
        event_type: str,
        data: Dict[str, Any],
        target_roles: Optional[List[str]] = None,
        ambulance_id: Optional[int] = None,
        hospital_id: Optional[int] = None,
        reporter_user_id: Optional[int] = None,
        entity_type: Optional[str] = None,
        entity_id: Optional[Union[int, str]] = None,
        broadcast_to_all: bool = False,
    ):
        """
        Sends structured, targeted event notifications to authorized WebSocket clients.
        """
        if not self.active_clients:
            return

        envelope = create_event_envelope(
            event_type=event_type,
            payload=data,
            entity_type=entity_type,
            entity_id=entity_id,
        )

        disconnected = []
        for client in list(self.active_clients):
            if self.is_client_eligible(
                client=client,
                target_roles=target_roles,
                ambulance_id=ambulance_id,
                hospital_id=hospital_id,
                reporter_user_id=reporter_user_id,
                broadcast_to_all=broadcast_to_all,
            ):
                try:
                    await client.websocket.send_json(envelope)
                except Exception as e:
                    logger.warning(f"Error sending to WebSocket client {client.email}: {e}")
                    disconnected.append(client.websocket)

        for dead_ws in disconnected:
            self.disconnect(dead_ws)

    def get_active_client_count(self) -> int:
        return len(self.active_clients)

    def get_active_clients(self) -> List[WebSocketClient]:
        return list(self.active_clients)

ws_manager = ConnectionManager()

def broadcast_sync(
    event_type: str,
    data: Dict[str, Any],
    target_roles: Optional[List[str]] = None,
    ambulance_id: Optional[int] = None,
    hospital_id: Optional[int] = None,
    reporter_user_id: Optional[int] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[Union[int, str]] = None,
    broadcast_to_all: bool = False,
):
    """
    Safely triggers structured, targeted broadcast without blocking synchronous execution.
    Executed immediately following a successful database transaction commit.
    """
    if not ws_manager.active_clients:
        return

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(
            ws_manager.broadcast(
                event_type=event_type,
                data=data,
                target_roles=target_roles,
                ambulance_id=ambulance_id,
                hospital_id=hospital_id,
                reporter_user_id=reporter_user_id,
                entity_type=entity_type,
                entity_id=entity_id,
                broadcast_to_all=broadcast_to_all,
            )
        )
    except RuntimeError:
        # No running event loop in this execution thread (e.g. direct sync unit test)
        pass
    except Exception as e:
        logger.debug(f"Broadcast sync skipped: {e}")
