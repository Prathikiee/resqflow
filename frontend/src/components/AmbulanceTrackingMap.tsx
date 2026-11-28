"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import "leaflet/dist/leaflet.css";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import {
  Navigation,
  Crosshair,
  MapPin,
  Radio,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Play,
  Pause,
  FastForward,
  CircleCheck,
  CircleAlert,
  Gauge,
  Compass,
  Route as RouteIcon,
  X,
  LocateFixed,
  Layers,
} from "lucide-react";
import {
  fetchNavigationRoute,
  calculateBearing,
  haversineDistance,
  minDistanceToRoute,
  NavigationRoute,
  NavigationStep,
} from "@/lib/navigation";
import { formatDistance, formatDuration } from "@/lib/utils";

export interface AmbulanceTrackingMapProps {
  ambulanceLat?: number;
  ambulanceLng?: number;
  ambulanceCallSign?: string;
  ambulanceId?: number;
  targetLat?: number;
  targetLng?: number;
  targetLabel?: string;
  targetType?: "incident" | "hospital";
  gpsStatus?: "CONNECTED" | "WEAK" | "LOST";
  isNavigating?: boolean;
  onToggleNavigation?: (navigating: boolean) => void;
  onLocationUpdate?: (coords: {
    latitude: number;
    longitude: number;
    heading?: number;
    speed?: number;
    accuracy?: number;
    isSimulated?: boolean;
  }) => void;
  onStepAdvance?: () => void;
  onExitNavigation?: () => void;
  dispatchId?: number;
  attemptNumber?: number;
  incidentId?: number;
  missionStatus?: string;
  backendUrl?: string;
}

// -------------------------------------------------------------
// Dynamic Leaflet Custom DivIcons
// -------------------------------------------------------------
const createAmbulanceIcon = (
  callSign = "AMB",
  heading = 0,
  isSimulated = false
) =>
  L.divIcon({
    className: "custom-amb-vehicle-marker",
    html: `
      <div style="position: relative; width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;">
        <span style="position: absolute; width: 44px; height: 44px; border-radius: 9999px; background: ${
          isSimulated ? "rgba(6, 182, 212, 0.4)" : "rgba(37, 99, 235, 0.45)"
        }; animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;"></span>
        <div style="position: relative; width: 38px; height: 38px; border-radius: 9999px; background: ${
          isSimulated ? "#0891b2" : "#2563eb"
        }; border: 2.5px solid #ffffff; box-shadow: 0 4px 14px rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; transform: rotate(${heading}deg); transition: transform 0.25s ease-out;">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 19 21 12 17 5 21 12 2" fill="#ffffff" />
          </svg>
        </div>
        <span style="position: absolute; bottom: -8px; background: #0f172a; color: #ffffff; font-size: 9px; font-weight: 800; padding: 1px 4px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.4); white-space: nowrap; pointer-events: none;">
          ${callSign}
        </span>
      </div>
    `,
    iconSize: [48, 48],
    iconAnchor: [24, 24],
  });

const createIncidentTargetIcon = (label = "Incident Scene") =>
  L.divIcon({
    className: "custom-amb-incident-marker",
    html: `
      <div style="position: relative; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;">
        <span style="position: absolute; width: 44px; height: 44px; border-radius: 9999px; background: rgba(239, 68, 68, 0.4); animation: pulse 1.8s infinite;"></span>
        <div style="position: relative; width: 34px; height: 34px; border-radius: 9999px; background: #dc2626; border: 2.5px solid #ffffff; box-shadow: 0 4px 12px rgba(220,38,38,0.4); display: flex; align-items: center; justify-content: center; color: #ffffff; font-weight: 900; font-size: 11px;">
          SOS
        </div>
      </div>
    `,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });

const createHospitalTargetIcon = (label = "Receiving Hospital") =>
  L.divIcon({
    className: "custom-amb-hospital-marker",
    html: `
      <div style="position: relative; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;">
        <span style="position: absolute; width: 44px; height: 44px; border-radius: 9999px; background: rgba(16, 185, 129, 0.35); animation: pulse 2s infinite;"></span>
        <div style="position: relative; width: 34px; height: 34px; border-radius: 9999px; background: #059669; border: 2.5px solid #ffffff; box-shadow: 0 4px 12px rgba(5,150,105,0.4); display: flex; align-items: center; justify-content: center; color: #ffffff; font-weight: 900; font-size: 15px;">
          +
        </div>
      </div>
    `,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });

// -------------------------------------------------------------
// Map Camera & Focus Controller
// -------------------------------------------------------------
function MapViewController({
  ambulanceLat,
  ambulanceLng,
  targetLat,
  targetLng,
  focusMode,
  focusTrigger,
  isNavigating,
}: {
  ambulanceLat?: number;
  ambulanceLng?: number;
  targetLat?: number;
  targetLng?: number;
  focusMode: "bounds" | "ambulance" | "target";
  focusTrigger: number;
  isNavigating: boolean;
}) {
  const map = useMap();
  const userInteractedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 150);

    const handleResize = () => map.invalidateSize();
    window.addEventListener("resize", handleResize);

    const handleUserInteraction = () => {
      userInteractedRef.current = true;
    };

    map.on("dragstart", handleUserInteraction);
    map.on("zoomstart", handleUserInteraction);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
      map.off("dragstart", handleUserInteraction);
      map.off("zoomstart", handleUserInteraction);
    };
  }, [map]);

  useEffect(() => {
    const hasAmb =
      typeof ambulanceLat === "number" &&
      typeof ambulanceLng === "number" &&
      !isNaN(ambulanceLat) &&
      !isNaN(ambulanceLng) &&
      ambulanceLat !== 0;

    const hasTarget =
      typeof targetLat === "number" &&
      typeof targetLng === "number" &&
      !isNaN(targetLat) &&
      !isNaN(targetLng) &&
      targetLat !== 0;

    if (focusTrigger > 0) {
      userInteractedRef.current = false;
    }

    if (isNavigating && hasAmb && (!userInteractedRef.current || focusTrigger > 0)) {
      map.setView([ambulanceLat!, ambulanceLng!], 17, { animate: true });
      return;
    }

    if (userInteractedRef.current && focusTrigger === 0) {
      return;
    }

    if (focusMode === "ambulance" && hasAmb) {
      map.setView([ambulanceLat!, ambulanceLng!], 16, { animate: true });
    } else if (focusMode === "target" && hasTarget) {
      map.setView([targetLat!, targetLng!], 16, { animate: true });
    } else if (hasAmb && hasTarget) {
      const bounds = L.latLngBounds(
        [ambulanceLat!, ambulanceLng!],
        [targetLat!, targetLng!]
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
    } else if (hasAmb) {
      map.setView([ambulanceLat!, ambulanceLng!], 15, { animate: true });
    } else if (hasTarget) {
      map.setView([targetLat!, targetLng!], 15, { animate: true });
    }
  }, [
    ambulanceLat,
    ambulanceLng,
    targetLat,
    targetLng,
    focusMode,
    focusTrigger,
    isNavigating,
    map,
  ]);

  return null;
}

// -------------------------------------------------------------
// Helper Icon for Maneuvers
// -------------------------------------------------------------
function ManeuverIcon({
  type,
  modifier,
  className = "w-6 h-6",
}: {
  type: string;
  modifier: string;
  className?: string;
}) {
  const modLower = (modifier || "").toLowerCase();
  const typeLower = (type || "").toLowerCase();

  if (typeLower === "arrive") {
    return <MapPin className={className} />;
  }
  if (modLower.includes("uturn")) {
    return <RotateCcw className={className} />;
  }
  if (modLower.includes("slight left")) {
    return <ArrowUpLeft className={className} />;
  }
  if (modLower.includes("slight right")) {
    return <ArrowUpRight className={className} />;
  }
  if (modLower.includes("left")) {
    return <ArrowLeft className={className} />;
  }
  if (modLower.includes("right")) {
    return <ArrowRight className={className} />;
  }
  return <ArrowUp className={className} />;
}

// -------------------------------------------------------------
// Main Turn-by-Turn Ambulance Tracking & Navigation Map
// -------------------------------------------------------------
export default function AmbulanceTrackingMap({
  ambulanceLat: initialAmbLat,
  ambulanceLng: initialAmbLng,
  ambulanceCallSign = "Ambulance Unit",
  ambulanceId,
  targetLat,
  targetLng,
  targetLabel = "Target Destination",
  targetType = "incident",
  gpsStatus: initialGpsStatus = "CONNECTED",
  isNavigating: controlledNavigating,
  onToggleNavigation,
  onLocationUpdate,
  onStepAdvance,
  onExitNavigation,
  dispatchId,
  attemptNumber = 1,
  incidentId,
  missionStatus = "ASSIGNED",
  backendUrl = "http://localhost:8000",
}: AmbulanceTrackingMapProps) {
  // Navigation active state
  const [internalNavigating, setInternalNavigating] = useState(false);
  const isNavigating = controlledNavigating !== undefined ? controlledNavigating : internalNavigating;

  // Tracking Mode: LIVE GPS vs SIMULATION (Strict separation)
  const [trackingMode, setTrackingMode] = useState<"LIVE_GPS" | "SIMULATION">("LIVE_GPS");
  const [simSpeedMultiplier, setSimSpeedMultiplier] = useState<number>(1); // 1x = 40 km/h, 2x = 80 km/h
  const [isSimPaused, setIsSimPaused] = useState(false);

  // Position state (interpolated and smooth)
  const [currentLat, setCurrentLat] = useState<number>(initialAmbLat || 12.875);
  const [currentLng, setCurrentLng] = useState<number>(initialAmbLng || 74.845);
  const [heading, setHeading] = useState<number>(0);
  const [currentSpeedKmh, setCurrentSpeedKmh] = useState<number>(0);
  const [gpsAccuracyMeters, setGpsAccuracyMeters] = useState<number | null>(null);
  const [gpsStatus, setGpsStatus] = useState<"CONNECTED" | "WEAK" | "LOST">(initialGpsStatus);
  const [gpsErrorMessage, setGpsErrorMessage] = useState<string | null>(null);

  // Route & Navigation Guidance State
  const [route, setRoute] = useState<NavigationRoute | null>(null);
  const [isLoadingRoute, setIsLoadingRoute] = useState<boolean>(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [remainingDistanceMeters, setRemainingDistanceMeters] = useState<number>(0);
  const [remainingDurationSeconds, setRemainingDurationSeconds] = useState<number>(0);

  // Map Camera Controls
  const [focusMode, setFocusMode] = useState<"bounds" | "ambulance" | "target">("bounds");
  const [focusTrigger, setFocusTrigger] = useState(0);

  // Simulation loop references
  const simIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const simProgressIndexRef = useRef<number>(0);
  const lastTelemetrySendRef = useRef<number>(0);

  // GPS Watcher reference
  const gpsWatchIdRef = useRef<number | null>(null);

  // Synchronize initial prop coordinates
  useEffect(() => {
    if (typeof initialAmbLat === "number" && !isNaN(initialAmbLat) && initialAmbLat !== 0) {
      if (trackingMode === "LIVE_GPS" && !isNavigating) {
        setCurrentLat(initialAmbLat);
      }
    }
    if (typeof initialAmbLng === "number" && !isNaN(initialAmbLng) && initialAmbLng !== 0) {
      if (trackingMode === "LIVE_GPS" && !isNavigating) {
        setCurrentLng(initialAmbLng);
      }
    }
  }, [initialAmbLat, initialAmbLng, trackingMode, isNavigating]);

  // -------------------------------------------------------------
  // 1. Road Route Calculation & Recalculation
  // -------------------------------------------------------------
  const loadRoadRoute = useCallback(
    async (startL: number, startG: number, destL: number, destG: number) => {
      if (!destL || !destG) return;
      setIsLoadingRoute(true);
      setRouteError(null);

      try {
        const fetched = await fetchNavigationRoute(
          startL,
          startG,
          destL,
          destG,
          backendUrl,
          targetLabel
        );
        setRoute(fetched);
        setRemainingDistanceMeters(fetched.distance_meters);
        setRemainingDurationSeconds(fetched.duration_seconds);
        setCurrentStepIndex(0);
        simProgressIndexRef.current = 0;
      } catch (err: any) {
        console.warn("Route calculation fallback activated:", err);
        setRouteError("Road route recalculation fallback engaged.");
      } finally {
        setIsLoadingRoute(false);
      }
    },
    [backendUrl, targetLabel]
  );

  // Calculate route whenever origin or target changes
  useEffect(() => {
    if (targetLat && targetLng && currentLat && currentLng) {
      loadRoadRoute(currentLat, currentLng, targetLat, targetLng);
    }
  }, [targetLat, targetLng]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------
  // 2. Real-Time Telemetry Transmission to Backend
  // -------------------------------------------------------------
  const transmitTelemetry = useCallback(
    async (
      lat: number,
      lon: number,
      hdg: number,
      spd: number,
      acc?: number,
      isSim = false
    ) => {
      // Throttle telemetry to at most once per 2.5 seconds to prevent network thrashing
      const now = Date.now();
      if (now - lastTelemetrySendRef.current < 2500) {
        return;
      }
      lastTelemetrySendRef.current = now;

      // Notify parent hook/component
      if (onLocationUpdate) {
        onLocationUpdate({
          latitude: lat,
          longitude: lon,
          heading: hdg,
          speed: spd,
          accuracy: acc,
          isSimulated: isSim,
        });
      }

      if (!ambulanceId) return;
      const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
      if (!token) return;

      try {
        await fetch(`${backendUrl}/api/ambulances/${ambulanceId}/telemetry`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            latitude: lat,
            longitude: lon,
            status: missionStatus === "EN_ROUTE_HOSPITAL" ? "TRANSPORTING" : "EN_ROUTE",
            heading: hdg,
            speed: spd,
            accuracy: acc || (isSim ? 3.0 : 10.0),
            timestamp: now / 1000,
            dispatch_id: dispatchId,
            attempt_number: attemptNumber,
            is_simulated: isSim,
          }),
        });
      } catch (_) {
        // Non-blocking telemetry delivery
      }
    },
    [ambulanceId, backendUrl, dispatchId, attemptNumber, missionStatus, onLocationUpdate]
  );

  // -------------------------------------------------------------
  // 3. LIVE GPS ENGINE (Device Geolocation)
  // -------------------------------------------------------------
  useEffect(() => {
    if (trackingMode !== "LIVE_GPS") return;

    if (typeof window === "undefined" || !navigator.geolocation) {
      setGpsStatus("LOST");
      setGpsErrorMessage("Browser geolocation is not supported on this device.");
      return;
    }

    let prevLat = currentLat;
    let prevLng = currentLng;
    let offRouteConsecutiveCount = 0;

    const handleSuccess = (pos: GeolocationPosition) => {
      const { latitude, longitude, accuracy, heading: gpsHeading, speed } = pos.coords;

      setGpsStatus(accuracy && accuracy > 35 ? "WEAK" : "CONNECTED");
      setGpsAccuracyMeters(accuracy ? Math.round(accuracy) : null);
      setGpsErrorMessage(null);

      // Smooth heading calculation: prefer device heading; fallback to bearing between coordinates
      let computedHeading = heading;
      if (typeof gpsHeading === "number" && !isNaN(gpsHeading) && gpsHeading >= 0) {
        computedHeading = Math.round(gpsHeading);
      } else if (haversineDistance(prevLat, prevLng, latitude, longitude) > 4) {
        computedHeading = Math.round(calculateBearing(prevLat, prevLng, latitude, longitude));
      }

      const spdKmh = typeof speed === "number" && !isNaN(speed) && speed >= 0 ? Math.round(speed * 3.6) : 0;
      setCurrentSpeedKmh(spdKmh);
      setHeading(computedHeading);
      setCurrentLat(latitude);
      setCurrentLng(longitude);

      // Transmit to backend & portals
      transmitTelemetry(latitude, longitude, computedHeading, spdKmh, accuracy, false);

      // Check route deviation
      if (route && route.geometry && route.geometry.length > 1) {
        const devDist = minDistanceToRoute(latitude, longitude, route.geometry);
        if (devDist > 85) {
          offRouteConsecutiveCount++;
          if (offRouteConsecutiveCount >= 2 && targetLat && targetLng) {
            offRouteConsecutiveCount = 0;
            loadRoadRoute(latitude, longitude, targetLat, targetLng);
          }
        } else {
          offRouteConsecutiveCount = 0;
        }

        // Advance turn step
        if (route.steps && route.steps.length > 0 && currentStepIndex < route.steps.length - 1) {
          const nextStepLoc = route.steps[currentStepIndex + 1].location;
          if (nextStepLoc) {
            const distToStep = haversineDistance(latitude, longitude, nextStepLoc[0], nextStepLoc[1]);
            if (distToStep < 40) {
              setCurrentStepIndex((prev) => Math.min(prev + 1, route.steps.length - 1));
            }
          }
        }
      }

      prevLat = latitude;
      prevLng = longitude;
    };

    const handleError = (err: GeolocationPositionError) => {
      setGpsStatus("LOST");
      if (err.code === 1) {
        setGpsErrorMessage("GPS Location permission denied. Please allow location access in your browser.");
      } else if (err.code === 2) {
        setGpsErrorMessage("GPS position unavailable. Searching for satellite fix...");
      } else if (err.code === 3) {
        setGpsErrorMessage("GPS signal request timed out. Retrying...");
      }
    };

    gpsWatchIdRef.current = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      maximumAge: 1500,
      timeout: 10000,
    });

    return () => {
      if (gpsWatchIdRef.current !== null) {
        navigator.geolocation.clearWatch(gpsWatchIdRef.current);
        gpsWatchIdRef.current = null;
      }
    };
  }, [
    trackingMode,
    isNavigating,
    route,
    targetLat,
    targetLng,
    currentStepIndex,
    loadRoadRoute,
    transmitTelemetry,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------
  // 4. SIMULATION ENGINE (Tested Road-Route Stepping)
  // -------------------------------------------------------------
  useEffect(() => {
    if (trackingMode !== "SIMULATION" || !isNavigating || isSimPaused) {
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
        simIntervalRef.current = null;
      }
      return;
    }

    if (!route || !route.geometry || route.geometry.length < 2) {
      return;
    }

    const geometry = route.geometry;
    const intervalMs = Math.round(1000 / simSpeedMultiplier);

    simIntervalRef.current = setInterval(() => {
      const idx = simProgressIndexRef.current;
      if (idx >= geometry.length - 1) {
        // Reached destination
        setCurrentSpeedKmh(0);
        if (simIntervalRef.current) {
          clearInterval(simIntervalRef.current);
          simIntervalRef.current = null;
        }
        return;
      }

      const p1 = geometry[idx];
      const p2 = geometry[idx + 1];
      const nextHdg = Math.round(calculateBearing(p1[0], p1[1], p2[0], p2[1]));
      const simKmh = 45 * simSpeedMultiplier;

      setCurrentLat(p2[0]);
      setCurrentLng(p2[1]);
      setHeading(nextHdg);
      setCurrentSpeedKmh(simKmh);
      setGpsStatus("CONNECTED");
      setGpsAccuracyMeters(3);

      simProgressIndexRef.current = idx + 1;

      // Compute remaining distance from this waypoint to end
      let remDist = 0;
      for (let j = idx + 1; j < geometry.length - 1; j++) {
        remDist += haversineDistance(
          geometry[j][0],
          geometry[j][1],
          geometry[j + 1][0],
          geometry[j + 1][1]
        );
      }
      setRemainingDistanceMeters(Math.round(remDist));
      setRemainingDurationSeconds(Math.max(10, Math.round(remDist / 12.5)));

      // Advance turn step
      if (route.steps && currentStepIndex < route.steps.length - 1) {
        const nextStep = route.steps[currentStepIndex + 1];
        if (nextStep && nextStep.location) {
          const distToNext = haversineDistance(
            p2[0],
            p2[1],
            nextStep.location[0],
            nextStep.location[1]
          );
          if (distToNext < 45) {
            setCurrentStepIndex((prev) => Math.min(prev + 1, route.steps.length - 1));
          }
        }
      }

      // Transmit simulated telemetry to backend
      transmitTelemetry(p2[0], p2[1], nextHdg, simKmh, 3.0, true);
    }, intervalMs);

    return () => {
      if (simIntervalRef.current) {
        clearInterval(simIntervalRef.current);
        simIntervalRef.current = null;
      }
    };
  }, [
    trackingMode,
    isNavigating,
    isSimPaused,
    simSpeedMultiplier,
    route,
    currentStepIndex,
    transmitTelemetry,
  ]);

  // -------------------------------------------------------------
  // 5. Navigation Control Handlers
  // -------------------------------------------------------------
  const handleStartNavigation = () => {
    if (onToggleNavigation) {
      onToggleNavigation(true);
    } else {
      setInternalNavigating(true);
    }
    setFocusMode("ambulance");
    setFocusTrigger((p) => p + 1);
  };

  const handleExitNavigation = () => {
    if (onExitNavigation) {
      onExitNavigation();
    }
    if (onToggleNavigation) {
      onToggleNavigation(false);
    } else {
      setInternalNavigating(false);
    }
    setFocusMode("bounds");
    setFocusTrigger((p) => p + 1);
  };

  const handleRecenterAmbulance = () => {
    setFocusMode("ambulance");
    setFocusTrigger((p) => p + 1);
  };

  const handleFitRouteBounds = () => {
    setFocusMode("bounds");
    setFocusTrigger((p) => p + 1);
  };

  const handleToggleTrackingMode = (newMode: "LIVE_GPS" | "SIMULATION") => {
    setTrackingMode(newMode);
    if (newMode === "SIMULATION") {
      simProgressIndexRef.current = 0;
      setIsSimPaused(false);
      setGpsErrorMessage(null);
    }
  };

  // -------------------------------------------------------------
  // Map Tile Configuration
  // -------------------------------------------------------------
  const cartoApiKey = process.env.NEXT_PUBLIC_CARTO_API_KEY;
  const customTileUrl = process.env.NEXT_PUBLIC_MAP_TILE_URL;
  const customAttribution = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION;

  let tileUrl: string;
  let tileAttribution: string;

  if (customTileUrl) {
    tileUrl = customTileUrl;
    tileAttribution =
      customAttribution ||
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  } else if (cartoApiKey) {
    tileUrl = `https://cartodb-basemaps-a.global.ssl.fastly.net/rastertiles/voyager/{z}/{x}/{y}.png?api_key=${cartoApiKey}`;
    tileAttribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
  } else {
    tileUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    tileAttribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  }

  const hasAmb =
    typeof currentLat === "number" &&
    typeof currentLng === "number" &&
    !isNaN(currentLat) &&
    !isNaN(currentLng) &&
    currentLat !== 0;

  const hasTarget =
    typeof targetLat === "number" &&
    typeof targetLng === "number" &&
    !isNaN(targetLat) &&
    !isNaN(targetLng) &&
    targetLat !== 0;

  const centerLat = hasAmb ? currentLat : hasTarget ? targetLat! : 12.9141;
  const centerLng = hasAmb ? currentLng : hasTarget ? targetLng! : 74.856;

  // Active step & progress
  const activeStep = route?.steps?.[currentStepIndex];
  const nextUpcomingStep = route?.steps?.[currentStepIndex + 1];

  const distToNextManeuver =
    activeStep && hasAmb && activeStep.location
      ? haversineDistance(currentLat, currentLng, activeStep.location[0], activeStep.location[1])
      : 150;

  const totalDistance = route?.distance_meters || 1;
  const progressPercent = Math.min(
    100,
    Math.max(
      0,
      Math.round(((totalDistance - remainingDistanceMeters) / totalDistance) * 100)
    )
  );

  return (
    <div className={`relative w-full rounded-3xl overflow-hidden border border-slate-200 shadow-md bg-slate-900 flex flex-col ${
      isNavigating ? "h-[540px] sm:h-[620px]" : "h-80 sm:h-96"
    } transition-all duration-300`}>
      {/* ------------------------------------------------------------- */}
      {/* 1. TOP TURN-BY-TURN MANEUVER HUD (WHEN NAVIGATING)           */}
      {/* ------------------------------------------------------------- */}
      {isNavigating && activeStep && (
        <div className="absolute top-3 left-3 right-3 z-30 pointer-events-auto">
          <div className="bg-slate-950/95 backdrop-blur-md border border-slate-700/80 rounded-2xl p-3.5 shadow-2xl text-white flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {/* Large Maneuver Icon */}
              <div className="w-12 h-12 rounded-2xl bg-blue-600 border border-blue-400 flex items-center justify-center text-white shrink-0 shadow-md">
                <ManeuverIcon
                  type={activeStep.type}
                  modifier={activeStep.modifier}
                  className="w-7 h-7 stroke-[2.5]"
                />
              </div>

              {/* Instructions & Next Turn Countdown */}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-emerald-400 font-extrabold text-sm sm:text-base tracking-tight font-mono">
                    In {formatDistance(distToNextManeuver)}
                  </span>
                  {activeStep.road_name && (
                    <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 text-[10px] font-bold uppercase truncate max-w-[120px] sm:max-w-[180px]">
                      {activeStep.road_name}
                    </span>
                  )}
                </div>
                <h4 className="text-xs sm:text-sm font-bold text-white truncate mt-0.5">
                  {activeStep.instruction}
                </h4>
                {nextUpcomingStep && (
                  <p className="text-[11px] text-slate-400 truncate mt-0.5 flex items-center gap-1">
                    <span className="text-slate-500 font-semibold">Then:</span>
                    <span>{nextUpcomingStep.instruction}</span>
                  </p>
                )}
              </div>
            </div>

            {/* Recenter & Exit buttons */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleRecenterAmbulance}
                title="Recenter on Ambulance"
                className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-600 text-white flex items-center justify-center transition shadow-xs"
              >
                <LocateFixed className="w-4 h-4 text-blue-400" />
              </button>
              <button
                type="button"
                onClick={handleExitNavigation}
                title="Exit Navigation"
                className="w-9 h-9 rounded-xl bg-slate-800 hover:bg-red-950/80 border border-slate-600 hover:border-red-500 text-slate-300 hover:text-red-400 flex items-center justify-center transition shadow-xs"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 2. PERSISTENT MODE / GPS BADGES                               */}
      {/* ------------------------------------------------------------- */}
      <div className={`absolute ${
        isNavigating ? "top-24 sm:top-24" : "top-3"
      } left-3 right-3 z-20 flex items-center justify-between pointer-events-none transition-all`}>
        {/* Tracking Mode & Status Pill */}
        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          {trackingMode === "SIMULATION" ? (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-950/90 backdrop-blur-md rounded-xl border border-cyan-500/80 shadow-md text-xs">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping" />
              <span className="text-cyan-300 font-extrabold tracking-wide uppercase text-[10px]">
                🎮 SIMULATION MODE
              </span>
              <span className="text-cyan-200/70 text-[10px]">
                · {simSpeedMultiplier}x Speed
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900/90 backdrop-blur-md rounded-xl border border-slate-700 shadow-md text-xs">
              <span
                className={`w-2 h-2 rounded-full ${
                  gpsStatus === "CONNECTED"
                    ? "bg-emerald-500 animate-pulse"
                    : gpsStatus === "WEAK"
                    ? "bg-amber-500"
                    : "bg-red-500"
                }`}
              />
              <span className="text-slate-200 font-bold text-[11px]">
                {gpsStatus === "CONNECTED"
                  ? "🛰️ LIVE GPS"
                  : gpsStatus === "WEAK"
                  ? "GPS WEAK"
                  : "GPS LOST"}
              </span>
              {gpsAccuracyMeters && (
                <span className="text-slate-400 text-[10px]">
                  (±{gpsAccuracyMeters}m)
                </span>
              )}
            </div>
          )}

          {/* Mode Switcher Toggle Pill */}
          <div className="flex items-center bg-slate-900/90 backdrop-blur-md rounded-xl border border-slate-700 p-0.5 shadow-md">
            <button
              type="button"
              onClick={() => handleToggleTrackingMode("LIVE_GPS")}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition flex items-center gap-1 ${
                trackingMode === "LIVE_GPS"
                  ? "bg-blue-600 text-white shadow-xs"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Compass className="w-3 h-3" />
              <span>Live GPS</span>
            </button>
            <button
              type="button"
              onClick={() => handleToggleTrackingMode("SIMULATION")}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition flex items-center gap-1 ${
                trackingMode === "SIMULATION"
                  ? "bg-cyan-600 text-white shadow-xs"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Play className="w-3 h-3 fill-current" />
              <span>Simulation</span>
            </button>
          </div>
        </div>

        {/* Quick Map Action Controls (Fit route, Recenter) */}
        {!isNavigating && (
          <div className="pointer-events-auto flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleRecenterAmbulance}
              title="Recenter on Vehicle"
              className="px-2.5 py-1.5 bg-white/95 hover:bg-slate-50 text-slate-800 text-xs font-bold rounded-xl border border-slate-200 shadow-sm flex items-center gap-1 transition"
            >
              <Crosshair className="w-3.5 h-3.5 text-blue-600" />
              <span className="hidden sm:inline">Vehicle</span>
            </button>
            <button
              type="button"
              onClick={handleFitRouteBounds}
              title="Show Complete Road Route"
              className="px-2.5 py-1.5 bg-white/95 hover:bg-slate-50 text-slate-800 text-xs font-bold rounded-xl border border-slate-200 shadow-sm flex items-center gap-1 transition"
            >
              <RouteIcon className="w-3.5 h-3.5 text-slate-700" />
              <span className="hidden sm:inline">Fit Route</span>
            </button>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      {/* 3. GPS ERROR ALERT BANNER                                     */}
      {/* ------------------------------------------------------------- */}
      {gpsErrorMessage && trackingMode === "LIVE_GPS" && (
        <div className="absolute top-16 left-3 right-3 z-30 p-2.5 bg-amber-950/90 border border-amber-500/80 rounded-xl flex items-center gap-2 text-amber-200 text-xs font-semibold shadow-lg backdrop-blur-md">
          <CircleAlert className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="truncate">{gpsErrorMessage}</span>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 4. LEAFLET MAP VIEWPORT                                       */}
      {/* ------------------------------------------------------------- */}
      <MapContainer
        center={[centerLat, centerLng]}
        zoom={15}
        scrollWheelZoom={false}
        className="w-full h-full z-0"
      >
        <MapViewController
          ambulanceLat={currentLat}
          ambulanceLng={currentLng}
          targetLat={targetLat}
          targetLng={targetLng}
          focusMode={focusMode}
          focusTrigger={focusTrigger}
          isNavigating={isNavigating}
        />

        <TileLayer attribution={tileAttribution} url={tileUrl} maxZoom={19} />

        {/* ROAD-FOLLOWING POLYLINE */}
        {route?.geometry && route.geometry.length > 1 && (
          <>
            {/* Outer polyline glow */}
            <Polyline
              positions={route.geometry}
              color="#1E40AF"
              weight={9}
              opacity={0.4}
            />
            {/* Inner primary road line */}
            <Polyline
              positions={route.geometry}
              color="#2563EB"
              weight={5}
              opacity={0.95}
            />
          </>
        )}

        {/* AMBULANCE VEHICLE MARKER WITH COMPASS HEADING */}
        {hasAmb && (
          <Marker
            position={[currentLat, currentLng]}
            icon={createAmbulanceIcon(
              ambulanceCallSign,
              heading,
              trackingMode === "SIMULATION"
            )}
          >
            <Popup>
              <div className="text-xs p-1 space-y-1">
                <span className="font-extrabold text-blue-600 uppercase tracking-wider text-[10px]">
                  Ambulance Telemetry
                </span>
                <p className="font-bold text-slate-900">{ambulanceCallSign}</p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {currentLat.toFixed(6)}, {currentLng.toFixed(6)}
                </p>
                <p className="text-[11px] text-slate-600">
                  Heading: {heading}° · Speed: {currentSpeedKmh} km/h
                </p>
              </div>
            </Popup>
          </Marker>
        )}

        {/* TARGET DESTINATION MARKER */}
        {hasTarget && (
          <Marker
            position={[targetLat!, targetLng!]}
            icon={
              targetType === "hospital"
                ? createHospitalTargetIcon(targetLabel)
                : createIncidentTargetIcon(targetLabel)
            }
          >
            <Popup>
              <div className="text-xs p-1 space-y-1">
                <span
                  className={`font-extrabold uppercase tracking-wider text-[10px] ${
                    targetType === "hospital" ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {targetType === "hospital" ? "Receiving Hospital ER" : "Emergency Patient Location"}
                </span>
                <p className="font-bold text-slate-900">{targetLabel}</p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {targetLat?.toFixed(6)}, {targetLng?.toFixed(6)}
                </p>
              </div>
            </Popup>
          </Marker>
        )}
      </MapContainer>

      {/* ------------------------------------------------------------- */}
      {/* 5. BOTTOM NAVIGATION DASHBOARD / CONTROLS                      */}
      {/* ------------------------------------------------------------- */}
      {isNavigating ? (
        <div className="absolute bottom-3 left-3 right-3 z-30 pointer-events-auto">
          <div className="bg-slate-950/95 backdrop-blur-md border border-slate-700/80 rounded-2xl p-4 shadow-2xl text-white space-y-3">
            {/* Top row: Metrics & Simulation Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-4">
                {/* Speedometer */}
                <div className="flex items-center gap-1.5">
                  <Gauge className="w-4 h-4 text-emerald-400" />
                  <div>
                    <span className="font-black text-lg text-emerald-400 leading-none">
                      {currentSpeedKmh}
                    </span>
                    <span className="text-[10px] text-slate-400 uppercase font-bold ml-1">
                      km/h
                    </span>
                  </div>
                </div>

                {/* Distance Remaining */}
                <div>
                  <span className="text-[10px] text-slate-400 uppercase font-bold block">
                    Remaining
                  </span>
                  <span className="font-extrabold text-sm text-white">
                    {formatDistance(remainingDistanceMeters)}
                  </span>
                </div>

                {/* Estimated Time / ETA */}
                <div>
                  <span className="text-[10px] text-slate-400 uppercase font-bold block">
                    ETA
                  </span>
                  <span className="font-extrabold text-sm text-blue-400">
                    {formatDuration(remainingDurationSeconds)}
                  </span>
                </div>
              </div>

              {/* Simulation Specific Controls */}
              {trackingMode === "SIMULATION" && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setIsSimPaused(!isSimPaused)}
                    className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-bold text-white border border-slate-600 flex items-center gap-1 transition"
                  >
                    {isSimPaused ? (
                      <>
                        <Play className="w-3 h-3 fill-current text-emerald-400" />
                        <span>Resume</span>
                      </>
                    ) : (
                      <>
                        <Pause className="w-3 h-3 fill-current text-amber-400" />
                        <span>Pause</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSimSpeedMultiplier(simSpeedMultiplier === 1 ? 2 : 1)
                    }
                    className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[10px] font-bold text-cyan-300 border border-slate-600 flex items-center gap-1 transition"
                  >
                    <FastForward className="w-3 h-3" />
                    <span>{simSpeedMultiplier}x</span>
                  </button>
                </div>
              )}
            </div>

            {/* Route Progress Bar */}
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] font-bold text-slate-400">
                <span>Route Progress</span>
                <span className="text-white">{progressPercent}%</span>
              </div>
              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Primary Action Button (Arrived / Advance Stage) */}
            <div className="flex items-center gap-2">
              {onStepAdvance && (
                <button
                  type="button"
                  onClick={onStepAdvance}
                  className="flex-1 py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs sm:text-sm shadow-md transition flex items-center justify-center gap-2"
                >
                  <CircleCheck className="w-4 h-4" />
                  <span>
                    {targetType === "hospital"
                      ? "Mark Arrived at Hospital ER"
                      : "Mark Arrived at Patient (On Scene)"}
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={handleExitNavigation}
                className="py-3 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-bold text-xs transition border border-slate-700"
              >
                Exit
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Standalone / Resting View Action Button */
        <div className="absolute bottom-3 right-3 z-20 flex items-center gap-2 pointer-events-auto">
          <button
            type="button"
            onClick={handleStartNavigation}
            className="inline-flex items-center space-x-1.5 px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-extrabold shadow-lg transition-colors border border-blue-400"
          >
            <Navigation className="w-4 h-4 fill-current" />
            <span>Start Live Navigation</span>
          </button>
        </div>
      )}
    </div>
  );
}
