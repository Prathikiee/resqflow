from typing import List, Dict, Any
import logging
from backend.app.models.entities import Hospital, Incident
from backend.app.services.routing_service import calculate_route, estimate_route_fast

logger = logging.getLogger(__name__)

class HospitalRankingCandidate:
    def __init__(
        self,
        hospital: Hospital,
        route_info: Dict[str, Any],
        total_score: float,
        score_breakdown: Dict[str, float],
        reasons: List[str],
        matched_specialties: List[str],
    ):
        self.hospital = hospital
        self.route_info = route_info
        self.total_score = total_score
        self.score_breakdown = score_breakdown
        self.reasons = reasons
        self.matched_specialties = matched_specialties

    def to_dict(self, rank: int) -> Dict[str, Any]:
        return {
            "rank": rank,
            "hospital_id": self.hospital.id,
            "name": self.hospital.name,
            "address": self.hospital.address,
            "contact_number": self.hospital.contact_number,
            "location": {
                "latitude": self.hospital.latitude,
                "longitude": self.hospital.longitude,
            },
            "accepting_emergencies": self.hospital.accepting_emergencies,
            "readiness_status": getattr(self.hospital, "readiness_status", "READY") or "READY",
            "available_icu_beds": self.hospital.available_icu_beds,
            "total_icu_beds": self.hospital.total_icu_beds,
            "available_emergency_beds": self.hospital.available_emergency_beds,
            "reserved_emergency_beds": getattr(self.hospital, "reserved_emergency_beds", 0) or 0,
            "effective_available_emergency_beds": max(0, self.hospital.available_emergency_beds - (getattr(self.hospital, "reserved_emergency_beds", 0) or 0)),
            "total_emergency_beds": self.hospital.total_emergency_beds,
            "available_ward_beds": getattr(self.hospital, "available_ward_beds", 20) or 20,
            "total_ward_beds": getattr(self.hospital, "total_ward_beds", 50) or 50,
            "doctors_availability": getattr(self.hospital, "doctors_availability", []) or [],
            "last_updated_by": getattr(self.hospital, "last_updated_by", None),
            "specialties": self.hospital.specialties,
            "matched_specialties": self.matched_specialties,
            "distance_meters": self.route_info["distance_meters"],
            "transit_minutes": self.route_info["duration_minutes"],
            "transit_seconds": self.route_info["duration_seconds"],
            "routing_mode": self.route_info["routing_mode"],
            "is_simulated_route": self.route_info["is_simulated"],
            "total_suitability_score": round(self.total_score, 1),
            "score_breakdown": self.score_breakdown,
            "suitability_reasons": self.reasons,
            "route_geometry": self.route_info["geometry"],
        }


def rank_suitable_hospitals(
    incident: Incident,
    hospitals: List[Hospital],
) -> Dict[str, Any]:
    """
    Ranks receiving hospitals based on clinical department match,
    live ICU bed capacity, ER bay availability, and ambulance transit ETA.
    """
    candidates: List[HospitalRankingCandidate] = []

    # Determine clinical target specialty based on incident
    target_specialties: List[str] = ["Emergency Medicine"]
    if incident.chest_pain or "cardiac" in (incident.chief_complaint or "").lower():
        target_specialties.append("Cardiology")
    if incident.suspected_stroke:
        target_specialties.append("Stroke Unit")
    if incident.severe_bleeding or incident.severe_trauma:
        target_specialties.append("Trauma Level 1")
    if incident.patient_age is not None and incident.patient_age < 16:
        target_specialties.append("Pediatrics")
    if "burn" in (incident.chief_complaint or "").lower():
        target_specialties.append("Burn Care")

    for h in hospitals:
        # Exclude hospitals on divert or not accepting emergencies
        readiness = getattr(h, "readiness_status", "READY") or "READY"
        if not h.accepting_emergencies or readiness == "DIVERT":
            continue

        route_info = estimate_route_fast(
            start_lat=incident.latitude,
            start_lon=incident.longitude,
            dest_lat=h.latitude,
            dest_lon=h.longitude,
            include_geometry=True,
        )

        transit_mins = route_info["duration_minutes"]
        reasons: List[str] = []

        # 1. Specialty Match Score (Weight: 35%)
        hospital_specialties = [s.lower() for s in (h.specialties or [])]
        matched = [ts for ts in target_specialties if any(ts.lower() in hs for hs in hospital_specialties)]
        if len(matched) >= 2 or (len(target_specialties) > 1 and matched[0] != "Emergency Medicine" if matched else False):
            s_specialty = 100.0
            reasons.append(f"Dedicated Clinical Match: Facility has specialized department(s) for {', '.join(matched)}.")
        elif "Emergency Medicine" in h.specialties:
            s_specialty = 65.0
            reasons.append("General Emergency Capability: Certified ER department.")
        else:
            s_specialty = 40.0
            reasons.append("Secondary Referral Facility.")

        # Doctor Availability Check
        doctors = getattr(h, "doctors_availability", []) or []
        active_specialists = [
            d["name"] for d in doctors
            if d.get("status") == "AVAILABLE" and any(ts.lower() in d.get("specialty", "").lower() for ts in target_specialties)
        ]
        if active_specialists:
            s_specialty = min(100.0, s_specialty + 10.0)
            reasons.append(f"On-Duty Medical Staffing: Active specialists on shift ({', '.join(active_specialists[:2])}).")

        # 2. Transit Proximity Score (Weight: 30%)
        # 100 pts at 1 min, decays by 4 pts per minute
        s_proximity = max(5.0, min(100.0, 100.0 - (transit_mins * 4.0)))
        reasons.append(f"Transit Duration: ~{transit_mins} mins ({round(route_info['distance_meters']/1000, 1)} km from incident scene).")

        # 3. ICU Bed Availability Score (Weight: 20%)
        icu_ratio = h.available_icu_beds / max(1, h.total_icu_beds)
        s_icu = min(100.0, icu_ratio * 100.0)
        reasons.append(f"Critical Bed Status: {h.available_icu_beds}/{h.total_icu_beds} ICU beds vacant.")

        # 4. Emergency Bay Capacity Score (Weight: 15%)
        reserved_beds = getattr(h, "reserved_emergency_beds", 0) or 0
        effective_er_beds = max(0, h.available_emergency_beds - reserved_beds)
        er_ratio = effective_er_beds / max(1, h.total_emergency_beds)
        s_er = min(100.0, er_ratio * 100.0)
        reasons.append(f"Emergency Bay Status: {effective_er_beds}/{h.total_emergency_beds} unreserved bays open ({reserved_beds} reserved).")

        # Operational Readiness Penalty / Note
        readiness_mod = 0.0
        if readiness == "BUSY":
            readiness_mod = -15.0
            reasons.append("ED Readiness Status: Facility is currently BUSY (Potential intake and triage queue delay).")
        else:
            reasons.append("ED Readiness Status: Facility is READY for immediate inbound reception.")

        total_score = max(5.0, (0.35 * s_specialty) + (0.30 * s_proximity) + (0.20 * s_icu) + (0.15 * s_er) + readiness_mod)

        candidates.append(
            HospitalRankingCandidate(
                hospital=h,
                route_info=route_info,
                total_score=total_score,
                score_breakdown={
                    "specialty_score": round(s_specialty, 1),
                    "proximity_score": round(s_proximity, 1),
                    "icu_capacity_score": round(s_icu, 1),
                    "er_capacity_score": round(s_er, 1),
                },
                reasons=reasons,
                matched_specialties=matched,
            )
        )

    # Sort descending by suitability score
    candidates.sort(key=lambda c: c.total_score, reverse=True)
    ranked_list = [c.to_dict(rank=idx + 1) for idx, c in enumerate(candidates)]

    return {
        "incident_id": incident.id,
        "target_clinical_departments": target_specialties,
        "ranked_hospitals": ranked_list,
        "recommended_hospital": ranked_list[0] if ranked_list else None,
        "ranking_weights": {
            "clinical_specialty": "35%",
            "transit_proximity": "30%",
            "icu_bed_availability": "20%",
            "er_bay_capacity": "15%",
        },
    }
