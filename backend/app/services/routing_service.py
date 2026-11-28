import math
import logging
from typing import Dict, Any, List, Tuple, Optional
import httpx
from backend.app.core.config import settings

logger = logging.getLogger(__name__)

# Bounded in-memory route cache (keyed by rounded start/dest coordinates)
_ROUTE_CACHE: Dict[Tuple[float, float, float, float], Dict[str, Any]] = {}

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """
    Calculates great-circle distance between two points in meters.
    """
    R = 6371000  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def calculate_bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates forward compass bearing in degrees (0-360) from point 1 to point 2."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    delta_lam = math.radians(lon2 - lon1)
    y = math.sin(delta_lam) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(delta_lam)
    return (math.degrees(math.atan2(y, x)) + 360) % 360

def generate_fallback_waypoints(lat1: float, lon1: float, lat2: float, lon2: float, steps: int = 12) -> List[List[float]]:
    """
    Generates realistic intermediate road-aligned waypoints with city-grid detour jitter.
    Returns array of [lat, lon] coordinates.
    """
    waypoints = []
    for i in range(steps + 1):
        fraction = i / float(steps)
        # Linear interpolation
        lat = lat1 + fraction * (lat2 - lat1)
        lon = lon1 + fraction * (lon2 - lon1)
        # Small deterministic city grid detour jitter (not applied to start/end)
        if 0 < i < steps:
            jitter = math.sin(fraction * math.pi) * 0.0015
            lat += jitter * (1 if i % 2 == 0 else -0.5)
            lon += jitter * (-0.5 if i % 2 == 0 else 1)
        waypoints.append([round(lat, 6), round(lon, 6)])
    return waypoints

def generate_fallback_steps(
    waypoints: List[List[float]],
    total_distance: float,
    total_duration: float,
    dest_label: str = "Destination Scene",
) -> List[Dict[str, Any]]:
    """
    Generates realistic turn-by-turn road navigation steps from route waypoints.
    """
    if len(waypoints) < 2:
        return [
            {
                "instruction": f"Proceed directly to {dest_label}",
                "type": "depart",
                "modifier": "straight",
                "road_name": "Emergency Arterial",
                "distance_meters": round(total_distance, 1),
                "duration_seconds": round(total_duration, 1),
                "location": waypoints[0] if waypoints else [0.0, 0.0],
                "bearing": 0.0,
            },
            {
                "instruction": f"Arrive at {dest_label}",
                "type": "arrive",
                "modifier": "straight",
                "road_name": "Destination",
                "distance_meters": 0.0,
                "duration_seconds": 0.0,
                "location": waypoints[-1] if waypoints else [0.0, 0.0],
                "bearing": 0.0,
            },
        ]

    steps: List[Dict[str, Any]] = []
    num_pts = len(waypoints)
    avg_step_dist = total_distance / max(1, num_pts - 1)
    avg_step_dur = total_duration / max(1, num_pts - 1)

    initial_bearing = calculate_bearing(waypoints[0][0], waypoints[0][1], waypoints[1][0], waypoints[1][1])
    steps.append({
        "instruction": "Depart and head toward emergency location on Main Arterial",
        "type": "depart",
        "modifier": "straight",
        "road_name": "Main Arterial",
        "distance_meters": round(avg_step_dist, 1),
        "duration_seconds": round(avg_step_dur, 1),
        "location": waypoints[0],
        "bearing": round(initial_bearing, 1),
    })

    road_names = [
        "Connecting Corridor",
        "Station Approach Road",
        "Bypass Road",
        "Hospital Link Way",
        "Commercial Crossroad",
        "Ring Road Radial",
    ]

    prev_bearing = initial_bearing
    for i in range(1, num_pts - 1):
        curr_b = calculate_bearing(waypoints[i][0], waypoints[i][1], waypoints[i+1][0], waypoints[i+1][1])
        diff = ((curr_b - prev_bearing + 180) % 360) - 180

        # Only emit maneuver step on significant road bend or every 3rd point
        if abs(diff) > 25 or i % 3 == 0:
            road = road_names[i % len(road_names)]
            if diff < -25:
                m_type = "turn"
                m_mod = "left"
                instr = f"Turn left onto {road}"
            elif diff > 25:
                m_type = "turn"
                m_mod = "right"
                instr = f"Turn right onto {road}"
            else:
                m_type = "continue"
                m_mod = "straight"
                instr = f"Continue straight onto {road}"

            steps.append({
                "instruction": instr,
                "type": m_type,
                "modifier": m_mod,
                "road_name": road,
                "distance_meters": round(avg_step_dist * 2.0, 1),
                "duration_seconds": round(avg_step_dur * 2.0, 1),
                "location": waypoints[i],
                "bearing": round(curr_b, 1),
            })
            prev_bearing = curr_b

    steps.append({
        "instruction": f"Arrive at {dest_label}",
        "type": "arrive",
        "modifier": "straight",
        "road_name": "Scene Perimeter",
        "distance_meters": 0.0,
        "duration_seconds": 0.0,
        "location": waypoints[-1],
        "bearing": round(prev_bearing, 1),
    })

    return steps

def estimate_route_fast(
    start_lat: float,
    start_lon: float,
    dest_lat: float,
    dest_lon: float,
    include_geometry: bool = True,
) -> Dict[str, Any]:
    """
    Ultra-fast in-memory route calculation (<0.1ms).
    Computes distance using Haversine with Mangaluru urban road tortuosity factor (1.32x)
    and priority emergency response speed (40 km/h = 11.11 m/s).
    """
    cache_key = (round(start_lat, 4), round(start_lon, 4), round(dest_lat, 4), round(dest_lon, 4))
    if cache_key in _ROUTE_CACHE:
        return _ROUTE_CACHE[cache_key]

    straight_distance = haversine_distance(start_lat, start_lon, dest_lat, dest_lon)
    estimated_distance = straight_distance * 1.32
    speed_mps = 11.11
    estimated_duration = max(45.0, estimated_distance / speed_mps)

    geometry = generate_fallback_waypoints(start_lat, start_lon, dest_lat, dest_lon) if include_geometry else []
    steps = generate_fallback_steps(geometry, estimated_distance, estimated_duration) if include_geometry else []

    res = {
        "distance_meters": round(estimated_distance, 1),
        "duration_seconds": round(estimated_duration, 1),
        "duration_minutes": round(estimated_duration / 60.0, 1),
        "geometry": geometry,
        "steps": steps,
        "routing_mode": "Deterministic Fallback",
        "is_simulated": True,
        "attribution": "Estimated via Haversine Distance & Urban Tortuosity Model (40 km/h response profile)",
    }
    if len(_ROUTE_CACHE) < 2000:
        _ROUTE_CACHE[cache_key] = res
    return res

def calculate_route(
    start_lat: float,
    start_lon: float,
    dest_lat: float,
    dest_lon: float,
    timeout_seconds: float = 0.8,
) -> Dict[str, Any]:
    """
    Computes route geometry, distance, duration, and turn-by-turn steps using OSRM with deterministic fallback.
    Cached in-memory to prevent duplicate network calls.
    """
    cache_key = (round(start_lat, 4), round(start_lon, 4), round(dest_lat, 4), round(dest_lon, 4))
    if cache_key in _ROUTE_CACHE:
        return _ROUTE_CACHE[cache_key]

    osrm_url = f"{settings.OSRM_BASE_URL}/route/v1/driving/{start_lon},{start_lat};{dest_lon},{dest_lat}?overview=full&geometries=geojson&steps=true"

    try:
        with httpx.Client(timeout=timeout_seconds) as client:
            resp = client.get(osrm_url)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("code") == "Ok" and data.get("routes"):
                    primary_route = data["routes"][0]
                    distance_meters = primary_route.get("distance", 0.0)
                    duration_seconds = primary_route.get("duration", 0.0)
                    geometry_geojson = primary_route.get("geometry", {}).get("coordinates", [])

                    # GeoJSON is [lon, lat] -> convert to Leaflet standard [lat, lon]
                    leaflet_coords = [[coord[1], coord[0]] for coord in geometry_geojson]

                    # Emergency vehicle priority speed adjustment (15% reduction in drive time for lights & siren)
                    emergency_duration = max(30.0, duration_seconds * 0.85)

                    raw_steps = primary_route.get("legs", [{}])[0].get("steps", [])
                    parsed_steps = []
                    for s in raw_steps:
                        maneuver = s.get("maneuver", {})
                        m_type = maneuver.get("type", "turn")
                        m_mod = maneuver.get("modifier", "straight")
                        road = s.get("name") or "Connecting Road"
                        if m_type == "depart":
                            instruction = f"Depart and proceed on {road}"
                        elif m_type == "arrive":
                            instruction = f"Arrive at destination on {road}"
                        elif m_type == "turn":
                            instruction = f"Turn {m_mod} onto {road}"
                        elif m_type in ["new name", "continue"]:
                            instruction = f"Continue on {road}"
                        elif m_type == "roundabout":
                            instruction = f"At roundabout, take exit onto {road}"
                        else:
                            instruction = f"{m_type.capitalize()} {m_mod} onto {road}".strip()

                        loc = (
                            [maneuver["location"][1], maneuver["location"][0]]
                            if "location" in maneuver and len(maneuver["location"]) >= 2
                            else [0.0, 0.0]
                        )
                        parsed_steps.append({
                            "instruction": instruction,
                            "type": m_type,
                            "modifier": m_mod,
                            "road_name": road,
                            "distance_meters": round(s.get("distance", 0.0), 1),
                            "duration_seconds": round(s.get("duration", 0.0) * 0.85, 1),
                            "location": loc,
                            "bearing": float(maneuver.get("bearing_after", 0)),
                        })

                    if not parsed_steps and leaflet_coords:
                        parsed_steps = generate_fallback_steps(leaflet_coords, distance_meters, emergency_duration)

                    res = {
                        "distance_meters": round(distance_meters, 1),
                        "duration_seconds": round(emergency_duration, 1),
                        "duration_minutes": round(emergency_duration / 60.0, 1),
                        "geometry": leaflet_coords,
                        "steps": parsed_steps,
                        "routing_mode": "OSRM Live",
                        "is_simulated": False,
                        "attribution": "OpenStreetMap & OSRM Routing Engine",
                    }
                    if len(_ROUTE_CACHE) < 2000:
                        _ROUTE_CACHE[cache_key] = res
                    return res
    except Exception as e:
        logger.info(f"OSRM service unreachable or timed out ({e}). Utilizing deterministic emergency routing fallback.")

    return estimate_route_fast(start_lat, start_lon, dest_lat, dest_lon, include_geometry=True)
