import pytest
from datetime import timedelta
from unittest.mock import Mock
from fastapi import Response, HTTPException
from starlette.requests import Request
from starlette.websockets import WebSocket
from sqlalchemy.orm import Session
from backend.app.core.database import SessionLocal, Base, engine, upgrade_schema
from backend.app.services.seed_service import seed_database, DEMO_PASSWORD_DEFAULT
from backend.app.models.entities import User, Incident, Ambulance, Hospital, Dispatch, HandoverPacket
from backend.app.core.security import create_access_token, hash_password
from backend.app.core.auth import get_current_user, ROLE_CITIZEN, ROLE_AMBULANCE_CREW, ROLE_HOSPITAL_STAFF, ROLE_DISPATCHER, ROLE_SUPER_ADMIN
from backend.app.api.auth import login, create_user, list_users
from backend.app.api.incidents import create_incident, get_incident, list_incidents
from backend.app.api.dispatch import (
    create_dispatch,
    get_dispatch,
    list_dispatches,
    confirm_ambulance,
    confirm_hospital,
    reassign_dispatch,
    advance_dispatch_lifecycle,
    get_handover_packet,
    acknowledge_handover_packet,
)
from backend.app.main import authenticate_websocket_connection
from backend.app.schemas.auth import LoginRequest, UserCreateRequest
from backend.app.schemas.incident import IncidentCreate
from backend.app.schemas.dispatch import DispatchRequest, ConfirmationDecision, HandoverAcknowledgeRequest

@pytest.fixture(scope="module")
def fresh_db():
    Base.metadata.create_all(bind=engine)
    upgrade_schema()
    session = SessionLocal()
    seed_database(session, force=True)
    yield session
    session.close()

def build_mock_request(token: str) -> Request:
    return Request(scope={
        "type": "http",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
    })

# =========================================================================
# 1. Successful login returns JWT & user profile
# =========================================================================
def test_01_successful_login(fresh_db: Session):
    db = fresh_db
    res = Response()
    token_resp = login(
        LoginRequest(email="dispatcher@lifelink.demo", password=DEMO_PASSWORD_DEFAULT),
        response=res,
        db=db,
    )
    assert token_resp.access_token is not None
    assert token_resp.token_type == "bearer"
    assert token_resp.user.email == "dispatcher@lifelink.demo"
    assert token_resp.user.role == ROLE_DISPATCHER
    # Verify cookie was set on the response
    assert "set-cookie" in res.headers
    assert "lifelink_token" in res.headers["set-cookie"]

# =========================================================================
# 2. Incorrect password rejected with HTTP 401
# =========================================================================
def test_02_incorrect_password_rejected(fresh_db: Session):
    db = fresh_db
    res = Response()
    with pytest.raises(HTTPException) as exc_info:
        login(
            LoginRequest(email="dispatcher@lifelink.demo", password="WrongPassword123!"),
            response=res,
            db=db,
        )
    assert exc_info.value.status_code == 401
    assert "Invalid email or password" in exc_info.value.detail

# =========================================================================
# 3. Expired token rejected with HTTP 401
# =========================================================================
def test_03_expired_token_rejected(fresh_db: Session):
    db = fresh_db
    expired_token = create_access_token(
        {"sub": "1", "email": "dispatcher@lifelink.demo", "role": ROLE_DISPATCHER},
        expires_delta=timedelta(hours=-1),
    )
    req = build_mock_request(expired_token)
    with pytest.raises(HTTPException) as exc_info:
        get_current_user(req, db=db)
    assert exc_info.value.status_code == 401
    assert "Invalid or expired access token" in exc_info.value.detail

# =========================================================================
# 4. Deactivated account rejected with HTTP 403
# =========================================================================
def test_04_deactivated_account_rejected(fresh_db: Session):
    db = fresh_db
    user = db.query(User).filter(User.email == "deactivated@lifelink.demo").first()
    if not user:
        user = User(
            email="deactivated@lifelink.demo",
            password_hash=hash_password(DEMO_PASSWORD_DEFAULT),
            full_name="Deactivated Staff",
            role=ROLE_AMBULANCE_CREW,
            is_active=False,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        user.is_active = False
        db.commit()

    # Rejection at login
    res = Response()
    with pytest.raises(HTTPException) as exc_info:
        login(
            LoginRequest(email="deactivated@lifelink.demo", password=DEMO_PASSWORD_DEFAULT),
            response=res,
            db=db,
        )
    assert exc_info.value.status_code == 403
    assert "deactivated" in exc_info.value.detail.lower()

    # Rejection when presenting existing token
    valid_token = create_access_token({"sub": str(user.id), "email": user.email, "role": user.role})
    req = build_mock_request(valid_token)
    with pytest.raises(HTTPException) as exc_info2:
        get_current_user(req, db=db)
    assert exc_info2.value.status_code == 403
    assert "deactivated" in exc_info2.value.detail.lower()

# =========================================================================
# 5. Citizen access restrictions: sees own emergencies, forbidden on others
# =========================================================================
def test_05_citizen_privacy_isolation(fresh_db: Session):
    db = fresh_db
    citizen = db.query(User).filter(User.email == "citizen@lifelink.demo").first()

    # Citizen creates incident
    my_inc = create_incident(
        IncidentCreate(
            caller_name="Rahul Alva",
            caller_phone="+91 98451 99887",
            location_address="Bejai New Road, Mangaluru",
            latitude=12.8850,
            longitude=74.8470,
            chief_complaint="Severe chest pain with breathlessness",
            chest_pain=True,
        ),
        db=db,
        current_user=citizen,
    )
    assert my_inc.reporter_user_id == citizen.id

    # Another incident reported by someone else
    other_inc = Incident(
        caller_name="Other Citizen",
        caller_phone="+91 91111 22222",
        location_address="Private Clinic",
        latitude=12.8700,
        longitude=74.8500,
        chief_complaint="Private Medical Record",
        reporter_user_id=99999,
    )
    db.add(other_inc)
    db.commit()
    db.refresh(other_inc)

    # Citizen can inspect own incident
    fetched = get_incident(my_inc.id, db=db, current_user=citizen)
    assert fetched.id == my_inc.id

    # Citizen is forbidden from inspecting another citizen's incident
    with pytest.raises(HTTPException) as exc_info:
        get_incident(other_inc.id, db=db, current_user=citizen)
    assert exc_info.value.status_code == 403
    assert "Citizens can only inspect their own" in exc_info.value.detail

    # Citizen list only returns own reported emergencies
    c_list = list_incidents(db=db, current_user=citizen)
    returned_ids = [inc.id for inc in c_list]
    assert my_inc.id in returned_ids
    assert other_inc.id not in returned_ids

# =========================================================================
# 6. Ambulance crew access to assigned dispatch
# =========================================================================
def test_06_ambulance_crew_assigned_access(fresh_db: Session):
    db = fresh_db
    als101_user = db.query(User).filter(User.email == "als101@lifelink.demo").first()
    inc = db.query(Incident).first()
    hosp = db.query(Hospital).first()

    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=als101_user.ambulance_id,
        destination_hospital_id=hosp.id,
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="PENDING",
        hospital_confirmation_status="PENDING",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # ALS-101 crew accepts assignment
    res = confirm_ambulance(
        disp.id,
        ConfirmationDecision(decision="ACCEPTED"),
        db=db,
        current_user=als101_user,
    )
    assert res.ambulance_confirmation_status == "ACCEPTED"

# =========================================================================
# 7. Ambulance crew denial for another unit's dispatch (403)
# =========================================================================
def test_07_ambulance_crew_cross_unit_denial(fresh_db: Session):
    db = fresh_db
    als101 = db.query(Ambulance).filter(Ambulance.call_sign == "KA-19-ALS-101").first()
    als102_user = db.query(User).filter(User.email == "als102@lifelink.demo").first()
    inc = db.query(Incident).first()
    hosp = db.query(Hospital).first()

    # Dispatch assigned to ALS-101, NOT ALS-102
    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=als101.id,
        destination_hospital_id=hosp.id,
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="PENDING",
        hospital_confirmation_status="PENDING",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # ALS-102 crew attempts to confirm ALS-101's dispatch -> Must raise 403!
    with pytest.raises(HTTPException) as exc_info:
        confirm_ambulance(
            disp.id,
            ConfirmationDecision(decision="ACCEPTED"),
            db=db,
            current_user=als102_user,
        )
    assert exc_info.value.status_code == 403
    assert "own ambulance unit" in exc_info.value.detail

    # ALS-102 crew attempts to view ALS-101's dispatch details -> Must raise 403!
    with pytest.raises(HTTPException) as exc_view:
        get_dispatch(disp.id, db=db, current_user=als102_user)
    assert exc_view.value.status_code == 403
    assert "another ambulance unit" in exc_view.value.detail

# =========================================================================
# 8. Hospital staff access to assigned hospital dispatch & handover
# =========================================================================
def test_08_hospital_staff_assigned_access(fresh_db: Session):
    db = fresh_db
    kmc_user = db.query(User).filter(User.email == "kmc@lifelink.demo").first()
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()

    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=kmc_user.hospital_id,
        coordination_status="PENDING_CONFIRMATIONS",
        ambulance_confirmation_status="PENDING",
        hospital_confirmation_status="PENDING",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # KMC staff accepts bed reservation
    res = confirm_hospital(
        disp.id,
        ConfirmationDecision(decision="ACCEPTED"),
        db=db,
        current_user=kmc_user,
    )
    assert res.hospital_confirmation_status == "ACCEPTED"

    # Also accept ambulance to complete dual confirmation and generate handover packet
    confirm_ambulance(disp.id, ConfirmationDecision(decision="ACCEPTED"), db=db)

    # KMC staff acknowledges incoming handover packet
    ack = acknowledge_handover_packet(
        disp.id,
        HandoverAcknowledgeRequest(receiving_physician="Dr. Aditi Shenoy", bed_assigned="ER-01"),
        db=db,
        current_user=kmc_user,
    )
    assert ack.status == "ACKNOWLEDGED"

# =========================================================================
# 9. Hospital staff denial for another hospital's dispatch (403)
# =========================================================================
def test_09_hospital_staff_cross_facility_denial(fresh_db: Session):
    db = fresh_db
    kmc = db.query(Hospital).filter(Hospital.facility_code == "HOSP-MNG-001").first()
    aj_user = db.query(User).filter(User.email == "aj@lifelink.demo").first()
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()

    # Dispatch routed to KMC, NOT AJ
    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=kmc.id,
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # AJ staff attempts to confirm bed reservation at KMC -> 403 Forbidden!
    with pytest.raises(HTTPException) as exc_info:
        confirm_hospital(
            disp.id,
            ConfirmationDecision(decision="ACCEPTED"),
            db=db,
            current_user=aj_user,
        )
    assert exc_info.value.status_code == 403
    assert "own facility" in exc_info.value.detail

    # AJ staff attempts to view KMC dispatch -> 403 Forbidden!
    with pytest.raises(HTTPException) as exc_view:
        get_dispatch(disp.id, db=db, current_user=aj_user)
    assert exc_view.value.status_code == 403
    assert "routed to another hospital" in exc_view.value.detail

# =========================================================================
# 10. Dispatcher regional access
# =========================================================================
def test_10_dispatcher_regional_access(fresh_db: Session):
    db = fresh_db
    disp_user = db.query(User).filter(User.email == "dispatcher@lifelink.demo").first()

    # Dispatcher sees all incidents
    all_inc = list_incidents(db=db, current_user=disp_user)
    assert len(all_inc) >= 1

    # Dispatcher sees all dispatches
    all_disp = list_dispatches(db=db, current_user=disp_user)
    assert isinstance(all_disp, list)

    # Dispatcher can manually reassign
    inc = Incident(
        caller_name="Dispatcher Test Incident",
        caller_phone="+91 98888 77777",
        location_address="Kadri Park",
        latitude=12.8770,
        longitude=74.8580,
        chief_complaint="Chest discomfort",
        status="TRIAGED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)

    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()

    hosp = db.query(Hospital).first()
    disp = create_dispatch(
        DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id),
        db=db,
    )
    reassigned = reassign_dispatch(disp.id, db=db, current_user=disp_user)
    assert reassigned.attempt_number == 2

# =========================================================================
# 11. Super admin user provisioning
# =========================================================================
def test_11_super_admin_user_provisioning(fresh_db: Session):
    db = fresh_db
    # Cleanup previous run if exists
    db.query(User).filter(User.email == "newdispatcher@lifelink.demo").delete()
    db.commit()

    admin_user = db.query(User).filter(User.email == "admin@lifelink.demo").first()
    citizen_user = db.query(User).filter(User.email == "citizen@lifelink.demo").first()

    # Admin provisions a new dispatcher
    new_user = create_user(
        UserCreateRequest(
            email="newdispatcher@lifelink.demo",
            password="SecurePassword2026!",
            full_name="Assistant Dispatcher Kamath",
            role=ROLE_DISPATCHER,
        ),
        db=db,
        current_user=admin_user,
    )
    assert new_user.email == "newdispatcher@lifelink.demo"
    assert new_user.role == ROLE_DISPATCHER

    # Non-admin / citizen is forbidden from creating users (403)
    with pytest.raises(HTTPException) as exc_info:
        create_user(
            UserCreateRequest(
                email="unauthorized@lifelink.demo",
                password="Password123!",
                full_name="Unauthorized User",
                role=ROLE_SUPER_ADMIN,
            ),
            db=db,
            current_user=citizen_user,
        )
    assert exc_info.value.status_code == 403

# =========================================================================
# 12. Unauthorized WebSocket connection rejection
# =========================================================================
def test_12_websocket_unauthorized_rejection():
    # 1. Connection without token -> authenticate returns None (which leads to 4001 close)
    mock_ws = Mock(spec=WebSocket)
    mock_ws.query_params = {}
    mock_ws.cookies = {}
    mock_ws.headers = {}
    assert authenticate_websocket_connection(mock_ws) is None

    # 2. Connection with invalid token -> authenticate returns None (leads to 4001 close)
    mock_ws2 = Mock(spec=WebSocket)
    mock_ws2.query_params = {"token": "invalid.jwt.token"}
    mock_ws2.cookies = {}
    mock_ws2.headers = {}
    assert authenticate_websocket_connection(mock_ws2) is None

    # 3. Connection with valid token -> authenticate returns valid decoded user claims
    valid_token = create_access_token({"sub": "1", "email": "dispatcher@lifelink.demo", "role": ROLE_DISPATCHER})
    mock_ws3 = Mock(spec=WebSocket)
    mock_ws3.query_params = {"token": valid_token}
    mock_ws3.cookies = {}
    mock_ws3.headers = {}
    payload = authenticate_websocket_connection(mock_ws3)
    assert payload is not None
    assert payload["email"] == "dispatcher@lifelink.demo"
    assert payload["role"] == ROLE_DISPATCHER

# =========================================================================
# 13. Cross-organization patient data isolation
# =========================================================================
def test_13_cross_organization_data_isolation(fresh_db: Session):
    db = fresh_db
    kmc = db.query(Hospital).filter(Hospital.facility_code == "HOSP-MNG-001").first()
    aj_user = db.query(User).filter(User.email == "aj@lifelink.demo").first()
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()

    # Confirmed dispatch routed to KMC Hospital
    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=kmc.id,
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # Handover packet exists for KMC
    packet = get_handover_packet(disp.id, db=db)
    assert packet is not None

    # AJ hospital ER doctor attempts to access KMC handover packet -> 403 Forbidden!
    with pytest.raises(HTTPException) as exc_info:
        get_handover_packet(disp.id, db=db, current_user=aj_user)
    assert exc_info.value.status_code == 403
    assert "Hospital staff can only view handover packets routed to their own facility" in exc_info.value.detail

# =========================================================================
# 14. Citizen and hospital staff cannot directly create fleet dispatches
# =========================================================================
def test_14_citizen_and_hospital_cannot_create_dispatch(fresh_db: Session):
    db = fresh_db
    citizen_user = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    hospital_user = db.query(User).filter(User.role == ROLE_HOSPITAL_STAFF).first()
    disp_user = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    inc = Incident(
        caller_name="Test Dispatcher Auth Citizen",
        caller_phone="+919876543210",
        location_address="Mangaluru City",
        latitude=12.9141,
        longitude=74.8560,
        chief_complaint="Acute severe trauma",
        triage_level="Priority 1",
        triage_color="RED",
        status="TRIAGED",
    )
    db.add(inc)
    db.commit()
    db.refresh(inc)
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()
    hosp = db.query(Hospital).first()

    payload = DispatchRequest(incident_id=inc.id, ambulance_id=amb.id, destination_hospital_id=hosp.id)

    # Citizen blocked with 403
    with pytest.raises(HTTPException) as exc1:
        create_dispatch(payload, db=db, current_user=citizen_user)
    assert exc1.value.status_code == 403

    # Hospital staff blocked with 403
    with pytest.raises(HTTPException) as exc2:
        create_dispatch(payload, db=db, current_user=hospital_user)
    assert exc2.value.status_code == 403

    # Dispatcher authorized
    disp = create_dispatch(payload, db=db, current_user=disp_user)
    assert disp.id is not None

# =========================================================================
# 15. Citizen strictly forbidden from accessing clinical handover packets
# =========================================================================
def test_15_citizen_strictly_forbidden_from_clinical_handover(fresh_db: Session):
    db = fresh_db
    citizen_user = db.query(User).filter(User.role == ROLE_CITIZEN).first()
    inc = db.query(Incident).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()
    hosp = db.query(Hospital).first()

    disp = Dispatch(
        incident_id=inc.id,
        ambulance_id=amb.id,
        destination_hospital_id=hosp.id,
        coordination_status="CONFIRMED",
        ambulance_confirmation_status="ACCEPTED",
        hospital_confirmation_status="ACCEPTED",
        attempt_number=1,
    )
    db.add(disp)
    db.commit()
    db.refresh(disp)

    # Ensure Handover packet generated
    get_handover_packet(disp.id, db=db)

    # Citizen access to clinical SBAR packet is blocked
    with pytest.raises(HTTPException) as exc:
        get_handover_packet(disp.id, db=db, current_user=citizen_user)
    assert exc.value.status_code == 403
    assert "strictly confidential" in exc.value.detail.lower()

# =========================================================================
# 16. Seed/reset endpoint strictly restricted to SUPER_ADMIN
# =========================================================================
def test_16_seed_endpoint_strictly_restricted_to_super_admin(fresh_db: Session):
    from backend.app.api.seed import trigger_seed
    db = fresh_db
    admin_user = db.query(User).filter(User.role == ROLE_SUPER_ADMIN).first()
    disp_user = db.query(User).filter(User.role == ROLE_DISPATCHER).first()
    citizen_user = db.query(User).filter(User.role == ROLE_CITIZEN).first()

    # Citizen cannot seed
    with pytest.raises(HTTPException) as exc1:
        trigger_seed(force=False, db=db, current_user=citizen_user)
    assert exc1.value.status_code == 403

    # Dispatcher cannot seed
    with pytest.raises(HTTPException) as exc2:
        trigger_seed(force=False, db=db, current_user=disp_user)
    assert exc2.value.status_code == 403

    # Super Admin can seed
    res = trigger_seed(force=False, db=db, current_user=admin_user)
    assert res["status"] == "success"

# =========================================================================
# 17. Unauthenticated requests to operational endpoints rejected with 401
# =========================================================================
def test_17_unauthenticated_requests_to_operational_endpoints_rejected_with_401(fresh_db: Session):
    from backend.app.api.hospitals import update_hospital_capacity, HospitalCapacityUpdate
    from backend.app.api.ambulances import update_ambulance_status, update_ambulance_telemetry, AmbulanceLocationUpdate
    db = fresh_db

    hosp = db.query(Hospital).first()
    amb = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").first()
    if not amb:
        amb = db.query(Ambulance).first()
        amb.status = "AVAILABLE"
        amb.reservation_dispatch_id = None
        db.commit()

    # 1. Unauthenticated capacity update -> 401 Unauthorized
    with pytest.raises(HTTPException) as exc1:
        update_hospital_capacity(
            hospital_id=hosp.id,
            payload=HospitalCapacityUpdate(available_emergency_beds=5),
            db=db,
            current_user=None,
        )
    assert exc1.value.status_code == 401
    assert "Authentication required" in exc1.value.detail

    # 2. Unauthenticated ambulance status update -> 401 Unauthorized
    with pytest.raises(HTTPException) as exc2:
        update_ambulance_status(
            ambulance_id=amb.id,
            status="AVAILABLE",
            db=db,
            current_user=None,
        )
    assert exc2.value.status_code == 401
    assert "Authentication required" in exc2.value.detail

    # 3. Unauthenticated ambulance telemetry update -> 401 Unauthorized
    with pytest.raises(HTTPException) as exc3:
        update_ambulance_telemetry(
            ambulance_id=amb.id,
            payload=AmbulanceLocationUpdate(latitude=12.91, longitude=74.85),
            db=db,
            current_user=None,
        )
    assert exc3.value.status_code == 401
    assert "Authentication required" in exc3.value.detail

