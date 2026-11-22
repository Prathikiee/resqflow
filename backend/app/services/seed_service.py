import logging
from sqlalchemy.orm import Session
from backend.app.models.entities import Ambulance, Hospital, Incident, Dispatch, HandoverPacket, WitnessReport, IncidentEvent, User, PatientVitals
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
            {"id": "doc_1_1", "name": "Dr. Aditi Shenoy", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 101"},
            {"id": "doc_1_2", "name": "Dr. Rajesh Kamath", "specialty": "Cardiology", "department": "Cardiology", "shift": "On-Call (24h)", "status": "AVAILABLE", "contact_number": "Ext. 102"},
            {"id": "doc_1_3", "name": "Dr. Shwetha Rai", "specialty": "Pediatrics", "department": "Pediatrics", "shift": "Day", "status": "AVAILABLE", "contact_number": "Ext. 103"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2444590",
        "emergency_contact_person": "Dr. Aditi Shenoy (ER Triage Lead)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 12,
        "ventilators_available": 8,
        "pediatric_beds_total": 12,
        "pediatric_beds_available": 6,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "OPERATIONAL", "cath_lab": "OPERATIONAL", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "ADEQUATE", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
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
            {"id": "doc_2_1", "name": "Dr. Vikram Hegde", "specialty": "Trauma Surgery", "department": "Trauma Care", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 201"},
            {"id": "doc_2_2", "name": "Dr. Vinay Alva", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Night", "status": "AVAILABLE", "contact_number": "Ext. 202"},
            {"id": "doc_2_3", "name": "Dr. Radhika Rao", "specialty": "Burn Care", "department": "Burn Unit", "shift": "On-Call", "status": "AVAILABLE", "contact_number": "Ext. 203"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2225533",
        "emergency_contact_person": "Dr. Vikram Hegde (Trauma Director)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 15,
        "ventilators_available": 10,
        "pediatric_beds_total": 10,
        "pediatric_beds_available": 5,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "OPERATIONAL", "cath_lab": "OPERATIONAL", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "LOW", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
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
            {"id": "doc_3_1", "name": "Dr. Farhan Ahmed", "specialty": "Critical Care", "department": "Critical Care", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 301"},
            {"id": "doc_3_2", "name": "Dr. Meera Pai", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Evening", "status": "AVAILABLE", "contact_number": "Ext. 302"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2422201",
        "emergency_contact_person": "Dr. Farhan Ahmed (Intensivist)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 10,
        "ventilators_available": 6,
        "pediatric_beds_total": 8,
        "pediatric_beds_available": 4,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "STANDBY", "cath_lab": "OPERATIONAL", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "ADEQUATE", "A_POS": "LOW", "B_POS": "ADEQUATE"},
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
            {"id": "doc_4_1", "name": "Dr. Santhosh Prabhu", "specialty": "Cardiology", "department": "Cardiology", "shift": "Morning", "status": "BUSY", "contact_number": "Ext. 401"},
            {"id": "doc_4_2", "name": "Dr. Preethi D'Souza", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Evening", "status": "AVAILABLE", "contact_number": "Ext. 402"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2880880",
        "emergency_contact_person": "Dr. Preethi D'Souza (Casualty Officer)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 10,
        "ventilators_available": 3,
        "pediatric_beds_total": 8,
        "pediatric_beds_available": 2,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "OPERATIONAL", "cath_lab": "OPERATIONAL", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "LOW", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
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
            {"id": "doc_5_1", "name": "Dr. Ananya Bhat", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 501"},
            {"id": "doc_5_2", "name": "Dr. Karthik Shetty", "specialty": "Nephrology", "department": "Nephrology", "shift": "Evening", "status": "AVAILABLE", "contact_number": "Ext. 502"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 4238855",
        "emergency_contact_person": "Dr. Ananya Bhat (ER Incharge)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 8,
        "ventilators_available": 5,
        "pediatric_beds_total": 10,
        "pediatric_beds_available": 6,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "OPERATIONAL", "cath_lab": "STANDBY", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "ADEQUATE", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
    },
    {
        "name": "Father Muller Medical College Hospital",
        "facility_code": "HOSP-MNG-006",
        "address": "Father Muller Road, Kankanady, Mangaluru, Karnataka 575002",
        "latitude": 12.8631,
        "longitude": 74.8540,
        "total_icu_beds": 26,
        "available_icu_beds": 9,
        "total_emergency_beds": 35,
        "available_emergency_beds": 15,
        "total_ward_beds": 65,
        "available_ward_beds": 28,
        "readiness_status": "READY",
        "specialties": ["Emergency Medicine", "General Surgery", "Orthopedics", "Cardiology", "Psychiatry"],
        "doctors_availability": [
            {"id": "doc_6_1", "name": "Dr. Naveen Rodrigues", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 601"},
            {"id": "doc_6_2", "name": "Dr. Prathima Prabhu", "specialty": "General Surgery", "department": "Surgery", "shift": "Evening", "status": "AVAILABLE", "contact_number": "Ext. 602"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2238000",
        "emergency_contact_person": "Dr. Naveen Rodrigues (Senior Casualty MO)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 14,
        "ventilators_available": 9,
        "pediatric_beds_total": 15,
        "pediatric_beds_available": 8,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "OPERATIONAL", "cath_lab": "OPERATIONAL", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "ADEQUATE", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
    },
    {
        "name": "City Hospital Research and Diagnostic Centre",
        "facility_code": "HOSP-MNG-007",
        "address": "Pound Garden, Kadri Toll Gate, Mangaluru, Karnataka 575003",
        "latitude": 12.8745,
        "longitude": 74.8421,
        "total_icu_beds": 16,
        "available_icu_beds": 5,
        "total_emergency_beds": 22,
        "available_emergency_beds": 7,
        "total_ward_beds": 42,
        "available_ward_beds": 14,
        "readiness_status": "READY",
        "specialties": ["Emergency Medicine", "Orthopedics", "Neurology", "Cardiology"],
        "doctors_availability": [
            {"id": "doc_7_1", "name": "Dr. Ashwin Kamath", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 701"},
            {"id": "doc_7_2", "name": "Dr. Deepa Nair", "specialty": "Neurology", "department": "Neurology", "shift": "Night", "status": "AVAILABLE", "contact_number": "Ext. 702"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2212345",
        "emergency_contact_person": "Dr. Ashwin Kamath (Casualty Incharge)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 8,
        "ventilators_available": 4,
        "pediatric_beds_total": 8,
        "pediatric_beds_available": 4,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "STANDBY", "cath_lab": "STANDBY", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "LOW", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
    },
    {
        "name": "Highland Hospital",
        "facility_code": "HOSP-MNG-008",
        "address": "Highlands, Falnir Road, Mangaluru, Karnataka 575002",
        "latitude": 12.8665,
        "longitude": 74.8525,
        "total_icu_beds": 14,
        "available_icu_beds": 4,
        "total_emergency_beds": 20,
        "available_emergency_beds": 6,
        "total_ward_beds": 38,
        "available_ward_beds": 12,
        "readiness_status": "READY",
        "specialties": ["Emergency Medicine", "Critical Care", "Obstetrics & Gynecology", "Pediatrics"],
        "doctors_availability": [
            {"id": "doc_8_1", "name": "Dr. Ayesha Banu", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 801"},
            {"id": "doc_8_2", "name": "Dr. Zahir Hussain", "specialty": "Critical Care", "department": "ICU", "shift": "Night", "status": "AVAILABLE", "contact_number": "Ext. 802"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2433433",
        "emergency_contact_person": "Dr. Ayesha Banu (ER Registrar)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 7,
        "ventilators_available": 4,
        "pediatric_beds_total": 10,
        "pediatric_beds_available": 5,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "STANDBY", "cath_lab": "STANDBY", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "LOW", "A_POS": "ADEQUATE", "B_POS": "LOW"},
    },
    {
        "name": "Tejasvini Hospital",
        "facility_code": "HOSP-MNG-009",
        "address": "Kadri Temple Road, Kadri, Mangaluru, Karnataka 575002",
        "latitude": 12.8812,
        "longitude": 74.8562,
        "total_icu_beds": 18,
        "available_icu_beds": 6,
        "total_emergency_beds": 24,
        "available_emergency_beds": 9,
        "total_ward_beds": 44,
        "available_ward_beds": 16,
        "readiness_status": "READY",
        "specialties": ["Orthopedics", "Trauma Care", "Emergency Medicine", "Sports Medicine"],
        "doctors_availability": [
            {"id": "doc_9_1", "name": "Dr. Shantharam Shetty", "specialty": "Orthopedics", "department": "Orthopedics", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 901"},
            {"id": "doc_9_2", "name": "Dr. Sandeep Kumar", "specialty": "Emergency Medicine", "department": "Trauma Bay", "shift": "Day", "status": "AVAILABLE", "contact_number": "Ext. 902"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2216666",
        "emergency_contact_person": "Dr. Sandeep Kumar (Trauma Unit Chief)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 9,
        "ventilators_available": 6,
        "pediatric_beds_total": 6,
        "pediatric_beds_available": 4,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "OPERATIONAL", "cath_lab": "STANDBY", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "ADEQUATE", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
    },
    {
        "name": "Mangala Hospital",
        "facility_code": "HOSP-MNG-010",
        "address": "Vajra Complex, Kankanady Bypass Road, Mangaluru, Karnataka 575002",
        "latitude": 12.8790,
        "longitude": 74.8480,
        "total_icu_beds": 15,
        "available_icu_beds": 4,
        "total_emergency_beds": 20,
        "available_emergency_beds": 7,
        "total_ward_beds": 36,
        "available_ward_beds": 11,
        "readiness_status": "READY",
        "specialties": ["Nephrology", "Emergency Medicine", "Dialysis", "General Medicine"],
        "doctors_availability": [
            {"id": "doc_10_1", "name": "Dr. Ganapathi Bhat", "specialty": "Emergency Medicine", "department": "Emergency Medicine", "shift": "Morning", "status": "AVAILABLE", "contact_number": "Ext. 1001"},
            {"id": "doc_10_2", "name": "Dr. Savitha Shenoy", "specialty": "Nephrology", "department": "Nephrology", "shift": "Day", "status": "AVAILABLE", "contact_number": "Ext. 1002"},
        ],
        "accepting_emergencies": True,
        "contact_number": "+91 824 2442444",
        "emergency_contact_person": "Dr. Ganapathi Bhat (Casualty Medical Officer)",
        "oxygen_status": "NORMAL",
        "ventilators_total": 7,
        "ventilators_available": 4,
        "pediatric_beds_total": 6,
        "pediatric_beds_available": 3,
        "equipment_readiness": {"ct_scanner": "OPERATIONAL", "mri": "STANDBY", "cath_lab": "STANDBY", "trauma_ot": "READY"},
        "blood_bank_status": {"O_POS": "ADEQUATE", "O_NEG": "LOW", "A_POS": "ADEQUATE", "B_POS": "ADEQUATE"},
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
        db.query(PatientVitals).delete()
        db.query(HandoverPacket).delete()
        db.query(Dispatch).delete()
        db.query(Incident).delete()
        db.query(Ambulance).delete()
        db.query(Hospital).delete()
        db.commit()

    # Seed Hospitals
    hospital_count = db.query(Hospital).count()
    if hospital_count == 0 or force:
        if force:
            db.query(Hospital).delete()
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
                emergency_contact_person=h_data.get("emergency_contact_person"),
                oxygen_status=h_data.get("oxygen_status", "NORMAL"),
                ventilators_total=h_data.get("ventilators_total", 10),
                ventilators_available=h_data.get("ventilators_available", 6),
                pediatric_beds_total=h_data.get("pediatric_beds_total", 10),
                pediatric_beds_available=h_data.get("pediatric_beds_available", 5),
                last_updated_by="System Seed (DEMO DATA)",
            )
            h.specialties = h_data["specialties"]
            h.doctors_availability = h_data.get("doctors_availability", [])
            h.equipment_readiness = h_data.get("equipment_readiness", {})
            h.blood_bank_status = h_data.get("blood_bank_status", {})
            db.add(h)
            seeded_counts["hospitals"] += 1
        db.commit()
    else:
        # Backfill facility codes and attributes if missing on existing records, or insert missing hospitals
        for h_data in MANGALURU_HOSPITALS:
            existing_h = db.query(Hospital).filter(Hospital.name == h_data["name"]).first()
            if existing_h:
                if not existing_h.facility_code:
                    existing_h.facility_code = h_data.get("facility_code")
                if not existing_h.readiness_status:
                    existing_h.readiness_status = h_data.get("readiness_status", "READY")
                if not existing_h.doctors_availability:
                    existing_h.doctors_availability = h_data.get("doctors_availability", [])
                if not existing_h.oxygen_status:
                    existing_h.oxygen_status = h_data.get("oxygen_status", "NORMAL")
                if not existing_h.emergency_contact_person:
                    existing_h.emergency_contact_person = h_data.get("emergency_contact_person")
                if not existing_h.equipment_readiness:
                    existing_h.equipment_readiness = h_data.get("equipment_readiness", {})
                if not existing_h.blood_bank_status:
                    existing_h.blood_bank_status = h_data.get("blood_bank_status", {})
            else:
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
                    emergency_contact_person=h_data.get("emergency_contact_person"),
                    oxygen_status=h_data.get("oxygen_status", "NORMAL"),
                    ventilators_total=h_data.get("ventilators_total", 10),
                    ventilators_available=h_data.get("ventilators_available", 6),
                    pediatric_beds_total=h_data.get("pediatric_beds_total", 10),
                    pediatric_beds_available=h_data.get("pediatric_beds_available", 5),
                    last_updated_by="System Seed (DEMO DATA)",
                )
                h.specialties = h_data["specialties"]
                h.doctors_availability = h_data.get("doctors_availability", [])
                h.equipment_readiness = h_data.get("equipment_readiness", {})
                h.blood_bank_status = h_data.get("blood_bank_status", {})
                db.add(h)
                seeded_counts["hospitals"] += 1
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
        "password": "Lifelink@2026!",
    },
    {
        "email": "admin@lifelink.demo",
        "full_name": "System Administrator Nayak",
        "role": "SUPER_ADMIN",
        "phone_number": "+91 824 2220101",
        "password": "Lifelink@2026!",
    },
    # 10 Mangaluru Hospital Demo Accounts (Unique Password starting with Hospital initial letter + unique suffix)
    {
        "email": "kmc@lifelink.demo",
        "full_name": "Dr. Aditi Shenoy (KMC ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "KMC Hospital Ambedkar Circle",
        "phone_number": "+91 824 2444591",
        "password": "Kmc#HospitalPass2026!Mangaluru",
    },
    {
        "email": "aj@lifelink.demo",
        "full_name": "Dr. Vikram Hegde (AJ Hospital ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "AJ Hospital & Research Centre",
        "phone_number": "+91 824 2225534",
        "password": "Aj#HospitalPass2026!Mangaluru",
    },
    {
        "email": "unity@lifelink.demo",
        "full_name": "Dr. Farhan Ahmed (Unity ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "Unity Hospital",
        "phone_number": "+91 824 2422202",
        "password": "Unity#HospitalPass2026!Mangaluru",
    },
    {
        "email": "indiana@lifelink.demo",
        "full_name": "Dr. Preethi D'Souza (Indiana ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "Indiana Hospital",
        "phone_number": "+91 824 2880881",
        "password": "Indiana#HospitalPass2026!Mangaluru",
    },
    {
        "email": "yenepoya@lifelink.demo",
        "full_name": "Dr. Ananya Bhat (Yenepoya ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "Yenepoya Specialty Hospital",
        "phone_number": "+91 824 4238856",
        "password": "Yenepoya#HospitalPass2026!Mangaluru",
    },
    {
        "email": "fathermuller@lifelink.demo",
        "full_name": "Dr. Naveen Rodrigues (Father Muller ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "Father Muller Medical College Hospital",
        "phone_number": "+91 824 2238001",
        "password": "FatherMuller#HospitalPass2026!Mangaluru",
    },
    {
        "email": "cityhospital@lifelink.demo",
        "full_name": "Dr. Ashwin Kamath (City Hospital ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "City Hospital Research and Diagnostic Centre",
        "phone_number": "+91 824 2212346",
        "password": "CityHospital#HospitalPass2026!Mangaluru",
    },
    {
        "email": "highland@lifelink.demo",
        "full_name": "Dr. Ayesha Banu (Highland ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "Highland Hospital",
        "phone_number": "+91 824 2433434",
        "password": "Highland#HospitalPass2026!Mangaluru",
    },
    {
        "email": "tejasvini@lifelink.demo",
        "full_name": "Dr. Shantharam Shetty (Tejasvini ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "Tejasvini Hospital",
        "phone_number": "+91 824 2216667",
        "password": "Tejasvini#HospitalPass2026!Mangaluru",
    },
    {
        "email": "mangala@lifelink.demo",
        "full_name": "Dr. Ganapathi Bhat (Mangala ER)",
        "role": "HOSPITAL_STAFF",
        "hospital_name": "Mangala Hospital",
        "phone_number": "+91 824 2442445",
        "password": "Mangala#HospitalPass2026!Mangaluru",
    },
    {
        "email": "als101@lifelink.demo",
        "full_name": "Paramedic Sunil Kumar (ALS-101)",
        "role": "AMBULANCE_CREW",
        "ambulance_call_sign": "KA-19-ALS-101",
        "phone_number": "+91 94481 10101",
        "password": "Lifelink@2026!",
    },
    {
        "email": "als102@lifelink.demo",
        "full_name": "Paramedic Ganesh Poojary (ALS-102)",
        "role": "AMBULANCE_CREW",
        "ambulance_call_sign": "KA-19-ALS-102",
        "phone_number": "+91 94481 10102",
        "password": "Lifelink@2026!",
    },
    {
        "email": "citizen@lifelink.demo",
        "full_name": "Rahul Alva",
        "role": "CITIZEN",
        "phone_number": "+91 98451 99887",
        "password": "Lifelink@2026!",
    },
]

def seed_demo_users(db: Session, force: bool = False) -> int:
    """
    Provisions or ensures the Lifelink demo accounts.
    """
    count = 0
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

        acc_password = acc.get("password", DEMO_PASSWORD_DEFAULT)
        pwd_hash = hash_password(acc_password)

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
