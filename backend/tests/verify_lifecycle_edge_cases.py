import sys
import os
sys.path.insert(0, os.path.abspath("."))

from fastapi import HTTPException
from backend.app.core.database import SessionLocal, Base, engine
from backend.app.models.entities import Incident, Ambulance, Hospital, Dispatch
from backend.app.services.seed_service import seed_database
from backend.app.api.dispatch import create_dispatch, advance_dispatch_lifecycle, confirm_ambulance, confirm_hospital
from backend.app.api.incidents import update_incident_status
from backend.app.schemas.dispatch import DispatchRequest, IncidentStatusUpdate, ConfirmationDecision

def test_lifecycle_edge_cases():
    print("=== LIFECYCLE & DUPLICATE DISPATCH EDGE CASES VERIFICATION ===")

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_database(db, force=True)

        incident = db.query(Incident).first()
        available_ambs = db.query(Ambulance).filter(Ambulance.status == "AVAILABLE").all()
        assert len(available_ambs) >= 2

        amb1 = available_ambs[0]
        amb2 = available_ambs[1]
        hosp = db.query(Hospital).first()

        # 1. Create first valid dispatch
        d1 = create_dispatch(
            payload=DispatchRequest(
                incident_id=incident.id,
                ambulance_id=amb1.id,
                destination_hospital_id=hosp.id,
            ),
            db=db,
        )
        assert d1.id is not None
        assert amb1.status == "RESERVED"
        assert incident.status == "ALLOCATED"
        assert d1.coordination_status == "PENDING_CONFIRMATIONS"
        print("✓ First dispatch provisional reservation successful.")

        # Confirm both ambulance and hospital
        confirm_ambulance(dispatch_id=d1.id, payload=ConfirmationDecision(decision="ACCEPTED"), db=db)
        confirm_hospital(dispatch_id=d1.id, payload=ConfirmationDecision(decision="ACCEPTED"), db=db)
        db.refresh(amb1)
        db.refresh(incident)
        assert amb1.status == "DISPATCHED"
        assert incident.status == "DISPATCHED"
        print("✓ Dual confirmation successful; ambulance marked DISPATCHED.")

        # 2. Duplicate dispatch test on SAME incident with different ambulance
        print("Testing duplicate dispatch rejection for same incident...")
        try:
            create_dispatch(
                payload=DispatchRequest(
                    incident_id=incident.id,
                    ambulance_id=amb2.id,
                    destination_hospital_id=hosp.id,
                ),
                db=db,
            )
            assert False, "Failed to reject duplicate dispatch for same active incident!"
        except HTTPException as e:
            assert e.status_code == 400
            assert "already has an active dispatch" in e.detail
            print(f"✓ Duplicate dispatch rejected: HTTP {e.status_code} - {e.detail}")

        # 3. Duplicate dispatch test for already BUSY ambulance on new incident
        print("Testing duplicate dispatch rejection for busy ambulance...")
        new_inc = Incident(
            caller_name="Second Caller",
            caller_phone="+91 99999 88888",
            location_address="Surathkal",
            latitude=12.9780,
            longitude=74.7940,
            chief_complaint="Fall injury",
            status="REPORTED",
        )
        db.add(new_inc)
        db.commit()

        try:
            create_dispatch(
                payload=DispatchRequest(
                    incident_id=new_inc.id,
                    ambulance_id=amb1.id,  # amb1 is already DISPATCHED
                    destination_hospital_id=hosp.id,
                ),
                db=db,
            )
            assert False, "Failed to reject dispatch of busy ambulance!"
        except HTTPException as e:
            assert e.status_code == 400
            assert "cannot be dispatched" in e.detail
            print(f"✓ Busy ambulance rejection verified: HTTP {e.status_code} - {e.detail}")

        # 4. Invalid status update test
        print("Testing invalid status transition rejection...")
        try:
            update_incident_status(
                incident_id=new_inc.id,
                payload=IncidentStatusUpdate(status="INVALID_STATUS_FOO"),
                db=db,
            )
            assert False, "Failed to reject invalid status string!"
        except HTTPException as e:
            assert e.status_code == 400
            assert "Invalid status" in e.detail
            print(f"✓ Invalid status rejected: HTTP {e.status_code} - {e.detail}")

        # Cleanup
        db.delete(d1)
        db.delete(new_inc)
        db.commit()
        print("LIFECYCLE & EDGE CASE VERIFICATION SUCCESSFUL.")

    finally:
        db.close()

if __name__ == "__main__":
    test_lifecycle_edge_cases()
