from typing import List, Dict, Any, Tuple
import logging
from backend.app.models.entities import Ambulance, Incident
from backend.app.services.routing_service import calculate_route, estimate_route_fast

logger = logging.getLogger(__name__)

class AmbulanceAllocationCandidate:
    def __init__(
        self,
        ambulance: Ambulance,
        route_info: Dict[str, Any],
        total_score: float,
        score_breakdown: Dict[str, float],
        reasons: List[str],
    ):
        self.ambulance = ambulance
        self.route_info = route_info
        self.total_score = total_score
        self.score_breakdown = score_breakdown
        self.reasons = reasons

    def to_dict(self, rank: int) -> Dict[str, Any]:
        return {
            "rank": rank,
            "ambulance_id": self.ambulance.id,
            "call_sign": self.ambulance.call_sign,
            "vehicle_type": self.ambulance.vehicle_type,
            "base_station": self.ambulance.base_station,
            "paramedic_level": self.ambulance.paramedic_level,
            "current_location": {
                "latitude": self.ambulance.current_latitude,
                "longitude": self.ambulance.current_longitude,
            },
            "fuel_level_percent": self.ambulance.fuel_level_percent,
            "equipment": self.ambulance.equipment,
            "distance_meters": self.route_info["distance_meters"],
            "eta_seconds": self.route_info["duration_seconds"],
            "eta_minutes": self.route_info["duration_minutes"],
            "routing_mode": self.route_info["routing_mode"],
            "is_simulated_route": self.route_info["is_simulated"],
            "total_score": round(self.total_score, 1),
            "score_breakdown": self.score_breakdown,
            "match_reasons": self.reasons,
            "route_geometry": self.route_info["geometry"],
        }


def score_and_rank_ambulances(
    incident: Incident,
    ambulances: List[Ambulance],
) -> Dict[str, Any]:
    """
    Executes intelligent multi-factor ambulance allocation:
      1. Pre-filtering: Excludes out-of-service, busy, or critically incapable units.
      2. Multi-factor scoring: Evaluates proximity/ETA, capability, equipment, and readiness.
      3. Explainability: Generates structured rationale and exact weight breakdowns.
    """
    suitable_candidates: List[AmbulanceAllocationCandidate] = []
    excluded_units: List[Dict[str, Any]] = []

    req_type = (incident.required_ambulance_type or "BLS").upper()
    is_critical_p1 = "Priority 1" in (incident.triage_level or "")

    for amb in ambulances:
        # Step 1: Hard Exclusion Filtering
        exclusion_reasons: List[str] = []

        if not amb.is_active:
            exclusion_reasons.append("Unit marked inactive in fleet registry.")

        if amb.status != "AVAILABLE":
            exclusion_reasons.append(f"Ambulance is currently {amb.status} (not available for new assignment).")

        if amb.fuel_level_percent < 20:
            exclusion_reasons.append(f"Low fuel ({amb.fuel_level_percent}%) below minimum operational threshold (20%).")

        equipment_lower = [e.lower() for e in (amb.equipment or [])]

        # Capability check: ALS requirement vs BLS vehicle
        if req_type == "ALS" and amb.vehicle_type != "ALS":
            has_ventilator = "ventilator" in equipment_lower
            has_defibrillator = "defibrillator" in equipment_lower
            if not (has_ventilator or has_defibrillator):
                exclusion_reasons.append(
                    "Clinical capability mismatch: Priority 1 incident mandates Advanced Life Support (ALS); vehicle lacks advanced life support kit."
                )

        if exclusion_reasons:
            excluded_units.append({
                "ambulance_id": amb.id,
                "call_sign": amb.call_sign,
                "vehicle_type": amb.vehicle_type,
                "status": amb.status,
                "reasons": exclusion_reasons,
            })
            continue

        # Step 2: Route & Response Time Calculation (Fast deterministic ranking)
        route_info = estimate_route_fast(
            start_lat=amb.current_latitude,
            start_lon=amb.current_longitude,
            dest_lat=incident.latitude,
            dest_lon=incident.longitude,
            include_geometry=True,
        )

        eta_minutes = route_info["duration_minutes"]
        reasons: List[str] = []

        # Factor 1: Proximity / Response Time Score (Weight: 40%)
        # 100 pts for <= 1 min, decays by 4.5 pts per minute
        s_eta = max(5.0, min(100.0, 100.0 - (eta_minutes * 4.5)))
        reasons.append(f"Estimated response time: {eta_minutes} mins ({round(route_info['distance_meters']/1000, 1)} km from {amb.base_station}).")

        # Factor 2: Capability Match Score (Weight: 25%)
        if req_type == "ALS":
            if amb.vehicle_type == "ALS":
                s_cap = 100.0
                reasons.append("Exact Capability Match: Advanced Life Support (ALS) vehicle with specialized ICU paramedic.")
            else:
                s_cap = 60.0
                reasons.append("Partial Capability Fit: BLS unit provisioned with emergency AED.")
        else:
            if amb.vehicle_type == "BLS":
                s_cap = 100.0
                reasons.append("Optimal Resource Utilization: BLS vehicle assigned to stable/moderate acuity incident.")
            else:
                s_cap = 75.0
                reasons.append("Acceptable Tier Substitution: ALS vehicle assigned to Standard incident (no lower-tier deficit).")

        # Factor 3: Equipment Compatibility Score (Weight: 20%)
        target_equipment: List[str] = ["oxygen", "stretcher"]
        if incident.chest_pain or "cardiac" in (incident.chief_complaint or "").lower():
            target_equipment.extend(["defibrillator", "ecg_monitor"])
        if incident.breathing_status == "Difficult" or incident.breathing_status == "Absent":
            target_equipment.extend(["ventilator", "suction"])
        if incident.severe_bleeding or incident.severe_trauma:
            target_equipment.extend(["trauma_kit", "splints"])

        matched_equip = [eq for eq in target_equipment if eq in equipment_lower]
        s_equip = min(100.0, (len(matched_equip) / max(1, len(target_equipment))) * 100.0)
        if matched_equip:
            reasons.append(f"Equipment Compatibility ({round(s_equip)}%): Onboard items include {', '.join(matched_equip[:3])}.")

        # Factor 4: Readiness & Paramedic Competency (Weight: 15%)
        paramedic_bonus = 50.0 if amb.paramedic_level == "ADVANCED" else 35.0
        fuel_score = (amb.fuel_level_percent / 100.0) * 50.0
        s_readiness = paramedic_bonus + fuel_score
        reasons.append(f"Operational Readiness: Paramedic level {amb.paramedic_level}, Fuel at {amb.fuel_level_percent}%.")

        # Multi-factor formula:
        total_score = (0.40 * s_eta) + (0.25 * s_cap) + (0.20 * s_equip) + (0.15 * s_readiness)

        candidate = AmbulanceAllocationCandidate(
            ambulance=amb,
            route_info=route_info,
            total_score=total_score,
            score_breakdown={
                "proximity_eta_score": round(s_eta, 1),
                "capability_match_score": round(s_cap, 1),
                "equipment_score": round(s_equip, 1),
                "readiness_score": round(s_readiness, 1),
            },
            reasons=reasons,
        )
        suitable_candidates.append(candidate)

    # Sort descending by total multi-factor score
    suitable_candidates.sort(key=lambda c: c.total_score, reverse=True)

    ranked_list = [c.to_dict(rank=idx + 1) for idx, c in enumerate(suitable_candidates)]

    return {
        "incident_id": incident.id,
        "required_ambulance_type": req_type,
        "triage_level": incident.triage_level,
        "ranked_ambulances": ranked_list,
        "excluded_ambulances": excluded_units,
        "recommended_ambulance": ranked_list[0] if ranked_list else None,
        "allocation_weights": {
            "proximity_eta": "40%",
            "capability_match": "25%",
            "equipment_compatibility": "20%",
            "readiness_and_crew": "15%",
        },
    }
