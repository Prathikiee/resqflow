import re
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Tuple
from backend.app.models.entities import Incident
from backend.app.services.routing_service import haversine_distance

# Configurable matching thresholds
MAX_DISTANCE_METERS = 500.0       # 500m proximity threshold
MAX_TIME_DELTA_SECONDS = 1800.0   # 30 minutes threshold
MIN_DUPLICATE_THRESHOLD = 0.55    # 55% similarity triggers POSSIBLE_DUPLICATE

STOPWORDS = {
    "a", "an", "the", "in", "on", "at", "near", "by", "of", "to", "and", "or",
    "is", "was", "are", "were", "with", "from", "for", "there", "has", "have",
    "some", "one", "two", "reported", "reporting", "witnessed", "saw", "please",
    "help", "send", "emergency", "incident", "someone", "person", "people"
}

def extract_keywords(text: str) -> set:
    if not text:
        return set()
    words = re.findall(r"[a-zA-Z0-9]+", text.lower())
    return {w for w in words if len(w) > 2 and w not in STOPWORDS}

def calculate_type_similarity(type_a: str, type_b: str) -> float:
    a = (type_a or "").strip().lower()
    b = (type_b or "").strip().lower()
    if not a or not b:
        return 0.4
    if a == b:
        return 1.0
    if a in b or b in a:
        return 0.8

    # Related emergency categories
    road_synonyms = {"accident", "traffic", "collision", "crash", "vehicle", "bike", "car"}
    cardiac_synonyms = {"cardiac", "chest", "heart", "attack", "cpr"}
    trauma_synonyms = {"trauma", "fall", "injury", "bleeding", "fracture"}

    def matches_group(text, group):
        return any(term in text for term in group)

    for group in (road_synonyms, cardiac_synonyms, trauma_synonyms):
        if matches_group(a, group) and matches_group(b, group):
            return 0.85

    return 0.2

def evaluate_report_against_incident(
    report_lat: float,
    report_lon: float,
    report_time: datetime,
    report_type: str,
    report_desc: str,
    incident: Incident,
) -> Dict[str, Any]:
    """
    Evaluates similarity between an incoming witness report and an active Incident.
    Returns composite score, breakdown factors, and human-readable explanation.
    """
    # 1. Spatial proximity
    dist = haversine_distance(report_lat, report_lon, incident.latitude, incident.longitude)
    if dist <= 50.0:
        dist_score = 1.0
    elif dist <= MAX_DISTANCE_METERS:
        dist_score = max(0.1, 1.0 - (dist / MAX_DISTANCE_METERS) * 0.8)
    else:
        # Distance exceeded
        dist_score = max(0.0, 0.2 * (MAX_DISTANCE_METERS / dist))

    # 2. Temporal proximity
    # Ensure UTC-naive comparison
    inc_time = incident.created_at
    if inc_time.tzinfo:
        inc_time = inc_time.replace(tzinfo=None)
    rep_time = report_time
    if rep_time.tzinfo:
        rep_time = rep_time.replace(tzinfo=None)

    time_delta = abs((rep_time - inc_time).total_seconds())
    if time_delta <= 180.0:  # within 3 minutes
        time_score = 1.0
    elif time_delta <= MAX_TIME_DELTA_SECONDS:
        time_score = max(0.2, 1.0 - (time_delta / MAX_TIME_DELTA_SECONDS) * 0.7)
    else:
        time_score = max(0.0, 0.2 * (MAX_TIME_DELTA_SECONDS / time_delta))

    # 3. Categorical similarity
    # Check against incident triage / complaint
    type_score = max(
        calculate_type_similarity(report_type, incident.chief_complaint),
        calculate_type_similarity(report_type, getattr(incident, "required_ambulance_type", "")),
        calculate_type_similarity(report_type, "Road Traffic Accident" if "accident" in incident.chief_complaint.lower() else "Medical"),
    )

    # 4. Textual keyword overlap
    rep_kw = extract_keywords(report_desc) | extract_keywords(report_type)
    inc_kw = extract_keywords(incident.chief_complaint) | extract_keywords(incident.location_address)
    overlap = rep_kw & inc_kw
    if overlap:
        kw_score = min(1.0, len(overlap) / max(1, min(len(rep_kw), len(inc_kw))))
    else:
        kw_score = 0.2

    # Weighted composite similarity:
    # 45% Distance + 25% Time + 15% Type + 15% Keywords
    composite = (
        (0.45 * dist_score)
        + (0.25 * time_score)
        + (0.15 * type_score)
        + (0.15 * kw_score)
    )

    # Build explainability breakdown
    factors = []
    if dist <= MAX_DISTANCE_METERS:
        factors.append(f"Proximity: {round(dist)}m (<{round(MAX_DISTANCE_METERS)}m threshold)")
    else:
        factors.append(f"Distance: {round(dist)}m")

    if time_delta <= MAX_TIME_DELTA_SECONDS:
        factors.append(f"Time delta: {round(time_delta / 60, 1)} min (<{round(MAX_TIME_DELTA_SECONDS / 60)} min)")
    else:
        factors.append(f"Time delta: {round(time_delta / 60, 1)} min")

    if overlap:
        factors.append(f"Matching terms: {', '.join(sorted(list(overlap))[:4])}")

    if type_score >= 0.7:
        factors.append(f"Consistent incident type ({report_type})")

    explanation = "Duplicate correlation: " + "; ".join(factors) + "."

    return {
        "incident_id": incident.id,
        "composite_score": round(composite, 3),
        "distance_meters": round(dist, 1),
        "time_difference_seconds": round(time_delta, 1),
        "matching_keywords": list(overlap),
        "explanation": explanation,
        "is_possible_duplicate": bool(composite >= MIN_DUPLICATE_THRESHOLD and dist <= MAX_DISTANCE_METERS),
    }

def find_best_incident_match(
    report_lat: float,
    report_lon: float,
    report_time: datetime,
    report_type: str,
    report_desc: str,
    active_incidents: List[Incident],
) -> Optional[Dict[str, Any]]:
    """
    Ranks active incidents and returns the strongest correlation match if above minimum threshold.
    """
    if not active_incidents:
        return None

    evaluations = []
    for inc in active_incidents:
        # Ignore already resolved or cancelled incidents if active incidents exist
        eval_result = evaluate_report_against_incident(
            report_lat=report_lat,
            report_lon=report_lon,
            report_time=report_time,
            report_type=report_type,
            report_desc=report_desc,
            incident=inc,
        )
        evaluations.append(eval_result)

    evaluations.sort(key=lambda x: x["composite_score"], reverse=True)
    best = evaluations[0]

    return best
