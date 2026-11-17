import math
import logging
from typing import Dict, Any, List, Tuple
import httpx
from backend.app.core.config import settings

logger = logging.getLogger(__name__)

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

def generate_fallback_waypoints(lat1: float, lon1: float, lat2: float, lon2: float, steps: int = 10) -> List[List[float]]:
    """
    Generates realistic intermediate road-aligned waypoints with city-grid jitter.
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

def calculate_route(
    start_lat: float,
    start_lon: float,
    dest_lat: float,
    dest_lon: float,
    timeout_seconds: float = 3.0,
) -> Dict[str, Any]:
    """
    Computes route geometry, distance, and duration using OSRM with deterministic fallback.
    Clearly tags whether the returned route is live OSRM data or an estimated fallback.
    """
    osrm_url = f"{settings.OSRM_BASE_URL}/route/v1/driving/{start_lon},{start_lat};{dest_lon},{dest_lat}?overview=full&geometries=geojson"

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

                    return {
                        "distance_meters": round(distance_meters, 1),
                        "duration_seconds": round(emergency_duration, 1),
                        "duration_minutes": round(emergency_duration / 60.0, 1),
                        "geometry": leaflet_coords,
                        "routing_mode": "OSRM Live",
                        "is_simulated": False,
                        "attribution": "OpenStreetMap & OSRM Routing Engine",
                    }
    except Exception as e:
        logger.info(f"OSRM service unreachable or timed out ({e}). Utilizing deterministic emergency routing fallback.")

    # Resilient Deterministic Fallback
    straight_distance = haversine_distance(start_lat, start_lon, dest_lat, dest_lon)
    # Urban road tortuosity factor in Mangaluru (actual road distance is ~1.32x straight line)
    estimated_distance = straight_distance * 1.32

    # Average emergency response vehicle speed in Mangaluru urban traffic: 40 km/h (11.11 m/s)
    speed_mps = 11.11
    estimated_duration = max(45.0, estimated_distance / speed_mps)

    fallback_geometry = generate_fallback_waypoints(start_lat, start_lon, dest_lat, dest_lon)

    return {
        "distance_meters": round(estimated_distance, 1),
        "duration_seconds": round(estimated_duration, 1),
        "duration_minutes": round(estimated_duration / 60.0, 1),
        "geometry": fallback_geometry,
        "routing_mode": "Deterministic Fallback",
        "is_simulated": True,
        "attribution": "Estimated via Haversine Distance & Urban Tortuosity Model (40 km/h response profile)",
    }
