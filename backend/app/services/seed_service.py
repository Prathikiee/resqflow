import logging
from sqlalchemy.orm import Session
from backend.app.models.entities import Ambulance, Hospital, Incident, Dispatch, HandoverPacket, WitnessReport, IncidentEvent, User
from backend.app.services.triage_engine import assess_incident_severity
from backend.app.core.security import hash_password

logger = logging.getLogger(__name__)

MANGALURU_HOSPITALS = [
    {
        "name": "KMC Hospital Ambedkar Circle",
        "facility_code": "HOSP-MNG-001",
        "address": "Ambedkar Circle, Balmatta Road, Mangaluru, Karnataka 575001",
        "latitude": 12.8718,
        "longitude": 74.8458,
        "total_icu_beds": 22,
        "available_icu_beds": 7,
        "total_emergency_beds": 35,
        "available_emergency_beds": 14,
        "total_ward_beds": 60,
        "available_ward_beds": 25,
        "readiness_status": "READY",
        "specialties": ["Trauma Level 1", "Cardiology", "Stroke Unit", "Emergency Medicine", "Pediatrics"],
        "doctors_availability": [
            {"name": "Dr. Aditi Shenoy", "specialty": "Emergency Medicine", "shift": "Day (08:00 - 20:00)", "status": "AVAILABLE"},
            {"name": "Dr. Rajesh Kamath", "specialty": "Cardiology", "shift": "On-Call (24h)", "status": "AVAILABLE"},
            {"name": "Dr. Shwetha Rai", "specialty": "Pediatrics", "shift": "Day (08:00 - 20:00)", "status": "AVAILABLE"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2444590",
    },
    {
        "name": "AJ Hospital & Research Centre",
        "facility_code": "HOSP-MNG-002",
        "address": "NH 66, Kuntikan, Mangaluru, Karnataka 575004",
        "latitude": 12.8988,
        "longitude": 74.8465,
        "total_icu_beds": 25,
        "available_icu_beds": 8,
        "total_emergency_beds": 30,
        "available_emergency_beds": 10,
        "total_ward_beds": 50,
        "available_ward_beds": 18,
        "readiness_status": "READY",
        "specialties": ["Trauma Level 1", "Cardiology", "Burn Care", "Neurosurgery", "Emergency Medicine"],
        "doctors_availability": [
            {"name": "Dr. Vikram Hegde", "specialty": "Trauma Surgery", "shift": "Day (08:00 - 20:00)", "status": "AVAILABLE"},
            {"name": "Dr. Vinay Alva", "specialty": "Emergency Medicine", "shift": "Night (20:00 - 08:00)", "status": "AVAILABLE"},
            {"name": "Dr. Radhika Rao", "specialty": "Burn Care", "shift": "On-Call", "status": "AVAILABLE"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2225533",
    },
    {
        "name": "Unity Hospital",
        "facility_code": "HOSP-MNG-003",
        "address": "Highlands, Falnir / Kankanady, Mangaluru, Karnataka 575002",
        "latitude": 12.8642,
        "longitude": 74.8569,
        "total_icu_beds": 18,
        "available_icu_beds": 4,
        "total_emergency_beds": 25,
        "available_emergency_beds": 6,
        "total_ward_beds": 45,
        "available_ward_beds": 14,
        "readiness_status": "READY",
        "specialties": ["Cardiology", "Critical Care", "General Surgery", "Emergency Medicine"],
        "doctors_availability": [
            {"name": "Dr. Farhan Ahmed", "specialty": "Critical Care", "shift": "Day (08:00 - 20:00)", "status": "AVAILABLE"},
            {"name": "Dr. Meera Pai", "specialty": "Emergency Medicine", "shift": "Day (08:00 - 20:00)", "status": "AVAILABLE"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2422201",
    },
    {
        "name": "Indiana Hospital",
        "facility_code": "HOSP-MNG-004",
        "address": "Mahaveera Circle, Pumpwell, Mangaluru, Karnataka 575002",
        "latitude": 12.8614,
        "longitude": 74.8698,
        "total_icu_beds": 20,
        "available_icu_beds": 1,
        "total_emergency_beds": 28,
        "available_emergency_beds": 2,
        "total_ward_beds": 50,
        "available_ward_beds": 5,
        "readiness_status": "BUSY",  # Simulated busy hospital as requested
        "specialties": ["Cardiology", "Vascular Surgery", "Emergency Medicine", "Pediatrics"],
        "doctors_availability": [
            {"name": "Dr. Santhosh Prabhu", "specialty": "Cardiology", "shift": "Day (08:00 - 20:00)", "status": "BUSY_IN_PROCEDURE"},
            {"name": "Dr. Preethi D'Souza", "specialty": "Emergency Medicine", "shift": "Day (08:00 - 20:00)", "status": "AVAILABLE"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2880880",
    },
    {
        "name": "Yenepoya Specialty Hospital",
        "facility_code": "HOSP-MNG-005",
        "address": "Kodialbail, Mangaluru, Karnataka 575003",
        "latitude": 12.8805,
        "longitude": 74.8432,
        "total_icu_beds": 15,
        "available_icu_beds": 4,
        "total_emergency_beds": 25,
        "available_emergency_beds": 8,
        "total_ward_beds": 40,
        "available_ward_beds": 15,
        "readiness_status": "READY",
        "specialties": ["Cardiology", "Nephrology", "Emergency Medicine", "Oncology"],
        "doctors_availability": [
            {"name": "Dr. Ananya Bhat", "specialty": "Emergency Medicine", "shift": "Day (08:00 - 20:00)", "status": "AVAILABLE"},
            {"name": "Dr. Karthik Shetty", "specialty": "Nephrology", "shift": "On-Call", "status": "AVAILABLE"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 4238855",
    },
]

MANGALURU_AMBULANCES = [
    {
        "call_sign": "KA-19-ALS-101",
        "vehicle_type": "ALS",
        "equipment": ["ventilator", "defibrillator", "oxygen", "ecg_monitor", "infusion_pump", "suction"],
        "paramedic_level": "ADVANCED",
        "status": "AVAILABLE",
        "base_station": "Surathkal Sector Depot",
        "current_latitude": 12.9815,
        "current_longitude": 74.7950,
        "fuel_level_percent": 95,
    },
    {
        "call_sign": "KA-19-ALS-102",
        "vehicle_type": "ALS",
        "equipment": ["ventilator", "defibrillator", "oxygen", "ecg_monitor", "trauma_kit"],
        "paramedic_level": "ADVANCED",
        "status": "AVAILABLE",
        "base_station": "AJ Hospital Kuntikan Post",
        "current_latitude": 12.8995,
        "current_longitude": 74.8470,
        "fuel_level_percent": 88,
    },
    {
        "call_sign": "KA-19-ALS-103",
        "vehicle_type": "ALS",
        "equipment": ["ventilator", "defibrillator", "oxygen", "ecg_monitor", "trauma_kit", "stretcher"],
        "paramedic_level": "ADVANCED",
        "status": "AVAILABLE",
        "base_station": "Hampankatta Central Station",
        "current_latitude": 12.8685,
        "current_longitude": 74.8415,
        "fuel_level_percent": 92,
    },
    {
        "call_sign": "KA-19-ALS-104",
        "vehicle_type": "ALS",
        "equipment": ["ventilator", "defibrillator", "oxygen", "stretcher"],
        "paramedic_level": "ADVANCED",
        "status": "MAINTENANCE",  # At least one ambulance unavailable as requested
        "base_station": "Pumpwell Transit Depot",
        "current_latitude": 12.8620,
        "current_longitude": 74.8710,
        "fuel_level_percent": 45,
    },
    {
        "call_sign": "KA-19-BLS-204",
        "vehicle_type": "BLS",
        "equipment": ["oxygen", "aed", "stretcher", "trauma_kit"],
        "paramedic_level": "BASIC",
        "status": "MAINTENANCE",  # Out-of-service BLS unit
        "base_station": "Bejai Bus Terminal Post",
        "current_latitude": 12.8870,
        "current_longitude": 74.8480,
        "fuel_level_percent": 40,
    },
]

def seed_database(db: Session, force: bool = False) -> dict:
    """
    Seeds initial realistic Mangaluru operational data:
    5 hospitals, 8 ambulances, and 1 demonstration incident.
    """
    seeded_counts = {"hospitals": 0, "ambulances": 0, "incidents": 0}

    if force:
        db.query(IncidentEvent).delete()
        db.query(WitnessReport).delete()
        db.query(HandoverPacket).delete()
        db.query(Dispatch).delete()
        db.query(Incident).delete()
        db.query(Ambulance).delete()
        db.query(Hospital).delete()
        db.commit()

    # Seed Hospitals
    hospital_count = db.query(Hospital).count()
    if hospital_count == 0:
        for h_data in MANGALURU_HOSPITALS:
            h = Hospital(
                name=h_data["name"],
                facility_code=h_data.get("facility_code"),
                address=h_data["address"],
                latitude=h_data["latitude"],
                longitude=h_data["longitude"],
                total_icu_beds=h_data["total_icu_beds"],
                available_icu_beds=h_data["available_icu_beds"],
                total_emergency_beds=h_data["total_emergency_beds"],
                available_emergency_beds=h_data["available_emergency_beds"],
                reserved_emergency_beds=0,
                total_ward_beds=h_data.get("total_ward_beds", 50),
                available_ward_beds=h_data.get("available_ward_beds", 20),
                readiness_status=h_data.get("readiness_status", "READY"),
                accepting_emergencies=h_data["accepting_emergencies"],
                contact_number=h_data["contact_number"],
                last_updated_by="System Seed (DEMO DATA)",
            )
            h.specialties = h_data["specialties"]
            h.doctors_availability = h_data.get("doctors_availability", [])
            db.add(h)
            seeded_counts["hospitals"] += 1
        db.commit()
    else:
        # Backfill facility codes and attributes if missing on existing records
        for h_data in MANGALURU_HOSPITALS:
            existing_h = db.query(Hospital).filter(Hospital.name == h_data["name"]).first()
            if existing_h:
                if not existing_h.facility_code:
                    existing_h.facility_code = h_data.get("facility_code")
                if not existing_h.readiness_status:
                    existing_h.readiness_status = h_data.get("readiness_status", "READY")
                if not existing_h.doctors_availability:
                    existing_h.doctors_availability = h_data.get("doctors_availability", [])
        db.commit()

    # Seed Ambulances
    amb_count = db.query(Ambulance).count()
    if amb_count == 0 or force:
        if force:
            db.query(Ambulance).delete()
        for a_data in MANGALURU_AMBULANCES:
            a = Ambulance(
                call_sign=a_data["call_sign"],
                vehicle_type=a_data["vehicle_type"],
                paramedic_level=a_data["paramedic_level"],
                status=a_data["status"],
                base_station=a_data["base_station"],
                current_latitude=a_data["current_latitude"],
                current_longitude=a_data["current_longitude"],
                fuel_level_percent=a_data["fuel_level_percent"],
                is_active=True,
            )
            a.equipment = a_data["equipment"]
            db.add(a)
            seeded_counts["ambulances"] += 1
        db.commit()

    # Seed initial demonstration incident if none exist
    inc_count = db.query(Incident).count()
    if inc_count == 0 or force:
        if force:
            db.query(Incident).delete()
        triage = assess_incident_severity(
            chief_complaint="Elderly person collapsed at Kadri Hills jogging park with acute chest pain and respiratory distress",
            consciousness_level="Voice",
            breathing_status="Difficult",
            chest_pain=True,
            severe_trauma=False,
            severe_bleeding=False,
            patient_age=58,
        )
        demo_incident = Incident(
            caller_name="Ramesh Bhat",
            caller_phone="+91 98451 22334",
            location_address="Kadri Hills Park Road, Mangaluru",
            latitude=12.8770,
            longitude=74.8580,
            chief_complaint="Elderly person collapsed at Kadri Hills jogging park with acute chest pain and respiratory distress",
            patient_age=58,
            patient_gender="Male",
            consciousness_level="Voice",
            breathing_status="Difficult",
            chest_pain=True,
            severe_bleeding=False,
            suspected_stroke=False,
            severe_trauma=False,
            triage_level=triage.triage_level,
            triage_color=triage.triage_color,
            triage_score=triage.triage_score,
            required_ambulance_type=triage.required_ambulance_type,
            status="REPORTED",
        )
        demo_incident.triage_justifications = triage.justifications
        db.add(demo_incident)
        db.commit()
        seeded_counts["incidents"] += 1

    # Seed demo user accounts
    users_seeded = seed_demo_users(db, force=force)
    seeded_counts["users"] = users_seeded

    logger.info(f"Seed completed: {seeded_counts}")
    return seeded_counts


DEMO_PASSWORD_DEFAULT = "Lifelink@2026!"

DEMO_ACCOUNTS = [
    {
        "email": "dispatcher@lifelink.demo",
        "full_name": "Regional Dispatcher Rao",
        "role": "DISPATCHER",
        "phone_number": "+91 824 2220100",
    },
    {
        "email": "admin@lifelink.demo",
        "full_name": "System Administrator Nayak",
        "role": "SUPER_ADMIN",
        "phone_number": "+91 824 2220101",
    },
    {
        "email": "kmc@lifelink.demo",
        "full_name": "Dr. Aditi Shenoy (KMC ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "KMC Hospital Ambedkar Circle",
        "phone_number": "+91 824 2444591",
    },
    {
        "email": "aj@lifelink.demo",
        "full_name": "Dr. Vikram Hegde (AJ Hospital ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "AJ Hospital & Research Centre",
        "phone_number": "+91 824 2225534",
    },
    {
        "email": "als101@lifelink.demo",
        "full_name": "Paramedic Sunil Kumar (ALS-101)",
        "role": "AMBULANCE_CREW",
        "ambulance_call_sign": "KA-19-ALS-101",
        "phone_number": "+91 94481 10101",
    },
    {
        "email": "als102@lifelink.demo",
        "full_name": "Paramedic Ganesh Poojary (ALS-102)",
        "role": "AMBULANCE_CREW",
        "ambulance_call_sign": "KA-19-ALS-102",
        "phone_number": "+91 94481 10102",
    },
    {
        "email": "citizen@lifelink.demo",
        "full_name": "Rahul Alva",
        "role": "CITIZEN",
        "phone_number": "+91 98451 99887",
    },
]

def seed_demo_users(db: Session, force: bool = False) -> int:
    """
    Provisions or ensures the 7 standard Lifelink demo accounts.
    """
    count = 0
    pwd_hash = hash_password(DEMO_PASSWORD_DEFAULT)
    for acc in DEMO_ACCOUNTS:
        u = db.query(User).filter(User.email == acc["email"]).first()
        h_id = None
        if "hospital_name" in acc:
            h = db.query(Hospital).filter(Hospital.name == acc["hospital_name"]).first()
            if h:
                h_id = h.id

        a_id = None
        if "ambulance_call_sign" in acc:
            a = db.query(Ambulance).filter(Ambulance.call_sign == acc["ambulance_call_sign"]).first()
            if a:
                a_id = a.id

        if not u:
            u = User(
                email=acc["email"],
                password_hash=pwd_hash,
                full_name=acc["full_name"],
                role=acc["role"],
                hospital_id=h_id,
                ambulance_id=a_id,
                phone_number=acc.get("phone_number"),
                is_active=True,
            )
            db.add(u)
            count += 1
        elif force:
            u.full_name = acc["full_name"]
            u.role = acc["role"]
            u.password_hash = pwd_hash
            u.hospital_id = h_id
            u.ambulance_id = a_id
            u.phone_number = acc.get("phone_number")
            u.is_active = True
            count += 1
    db.commit()
    return count
