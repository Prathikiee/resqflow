"use client";

import React, { useEffect, useState } from "react";
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
import { Navigation, Crosshair, MapPin, Radio } from "lucide-react";

export interface AmbulanceTrackingMapProps {
  ambulanceLat?: number;
  ambulanceLng?: number;
  ambulanceCallSign?: string;
  targetLat?: number;
  targetLng?: number;
  targetLabel?: string;
  targetType?: "incident" | "hospital";
  gpsStatus?: "CONNECTED" | "WEAK" | "LOST";
}

// Custom Leaflet DivIcons with crisp styling
const createAmbulanceIcon = (callSign?: string) =>
  L.divIcon({
    className: "custom-amb-vehicle-marker",
    html: `
      <div class="relative flex items-center justify-center w-10 h-10">
        <span class="absolute w-10 h-10 rounded-full bg-blue-500 animate-ping opacity-40"></span>
        <div class="relative w-8 h-8 rounded-full bg-blue-600 border-2 border-white shadow-lg flex items-center justify-center text-white font-extrabold text-[11px]">
          AMB
        </div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });

const createIncidentTargetIcon = () =>
  L.divIcon({
    className: "custom-amb-incident-marker",
    html: `
      <div class="relative flex items-center justify-center w-10 h-10">
        <span class="absolute w-10 h-10 rounded-full bg-red-500 animate-pulse opacity-50"></span>
        <div class="relative w-8 h-8 rounded-full bg-red-600 border-2 border-white shadow-lg flex items-center justify-center text-white font-black text-xs">
          SOS
        </div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });

const createHospitalTargetIcon = () =>
  L.divIcon({
    className: "custom-amb-hospital-marker",
    html: `
      <div class="relative flex items-center justify-center w-10 h-10">
        <div class="relative w-8 h-8 rounded-full bg-emerald-600 border-2 border-white shadow-lg flex items-center justify-center text-white font-black text-sm">
          +
        </div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });

function MapViewController({
  ambulanceLat,
  ambulanceLng,
  targetLat,
  targetLng,
  focusMode,
  focusTrigger,
}: {
  ambulanceLat?: number;
  ambulanceLng?: number;
  targetLat?: number;
  targetLng?: number;
  focusMode: "bounds" | "ambulance" | "target";
  focusTrigger: number;
}) {
  const map = useMap();
  const userInteractedRef = React.useRef(false);
  const initialMountedRef = React.useRef(false);

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

    // Reset user interaction flag when explicit focus action is triggered
    if (focusTrigger > 0) {
      userInteractedRef.current = false;
    }

    // Do not override view if user is actively panning/zooming, unless it is initial mount or explicit focusTrigger
    if (userInteractedRef.current && initialMountedRef.current && focusTrigger === 0) {
      return;
    }

    initialMountedRef.current = true;

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
    map,
  ]);

  return null;
}

export default function AmbulanceTrackingMap({
  ambulanceLat,
  ambulanceLng,
  ambulanceCallSign = "Ambulance Unit",
  targetLat,
  targetLng,
  targetLabel = "Target Destination",
  targetType = "incident",
  gpsStatus = "CONNECTED",
}: AmbulanceTrackingMapProps) {
  const [focusMode, setFocusMode] = useState<"bounds" | "ambulance" | "target">(
    "bounds"
  );
  const [focusTrigger, setFocusTrigger] = useState(0);

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

  const centerLat = hasAmb ? ambulanceLat! : hasTarget ? targetLat! : 12.9141;
  const centerLng = hasAmb ? ambulanceLng! : hasTarget ? targetLng! : 74.856;

  const handleRecenterAmb = () => {
    setFocusMode("ambulance");
    setFocusTrigger((p) => p + 1);
  };

  const handleRecenterTarget = () => {
    setFocusMode("target");
    setFocusTrigger((p) => p + 1);
  };

  const handleResetBounds = () => {
    setFocusMode("bounds");
    setFocusTrigger((p) => p + 1);
  };

  // Google Maps external navigation URL
  const navDestination = hasTarget
    ? `${targetLat},${targetLng}`
    : hasAmb
    ? `${ambulanceLat},${ambulanceLng}`
    : null;
  const googleMapsUrl = navDestination
    ? `https://www.google.com/maps/dir/?api=1&destination=${navDestination}`
    : null;

  return (
    <div className="relative w-full h-80 sm:h-96 rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-slate-50 flex flex-col">
      {/* Top Map Bar with GPS Indicator & Recenter Controls */}
      <div className="absolute top-3 left-3 right-3 z-20 flex items-center justify-between pointer-events-none">
        {/* GPS Status Badge */}
        <div className="pointer-events-auto flex items-center space-x-1.5 px-2.5 py-1.5 bg-white/95 backdrop-blur-md rounded-xl border border-slate-200/80 shadow-xs text-xs font-medium">
          {gpsStatus === "CONNECTED" && (
            <>
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-slate-800 font-semibold">GPS Connected</span>
            </>
          )}
          {gpsStatus === "WEAK" && (
            <>
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-amber-800 font-semibold">GPS Weak</span>
            </>
          )}
          {gpsStatus === "LOST" && (
            <>
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-red-700 font-semibold">GPS Lost</span>
            </>
          )}
        </div>

        {/* Map Quick Action Buttons */}
        <div className="pointer-events-auto flex items-center space-x-1.5">
          {hasAmb && (
            <button
              onClick={handleRecenterAmb}
              title="Recenter on Ambulance"
              className="px-2.5 py-1.5 bg-white/95 backdrop-blur-md hover:bg-slate-50 text-slate-700 text-xs font-medium rounded-xl border border-slate-200 shadow-xs flex items-center space-x-1 transition-colors"
            >
              <Crosshair className="w-3.5 h-3.5 text-blue-600" />
              <span className="hidden sm:inline">Vehicle</span>
            </button>
          )}
          {hasTarget && (
            <button
              onClick={handleRecenterTarget}
              title="Recenter on Target Destination"
              className="px-2.5 py-1.5 bg-white/95 backdrop-blur-md hover:bg-slate-50 text-slate-700 text-xs font-medium rounded-xl border border-slate-200 shadow-xs flex items-center space-x-1 transition-colors"
            >
              <MapPin className="w-3.5 h-3.5 text-red-600" />
              <span className="hidden sm:inline">Destination</span>
            </button>
          )}
          {hasAmb && hasTarget && (
            <button
              onClick={handleResetBounds}
              title="Show Full Route"
              className="px-2.5 py-1.5 bg-white/95 backdrop-blur-md hover:bg-slate-50 text-slate-700 text-xs font-medium rounded-xl border border-slate-200 shadow-xs flex items-center space-x-1 transition-colors"
            >
              <Radio className="w-3.5 h-3.5 text-slate-600" />
              <span className="hidden sm:inline">Fit Route</span>
            </button>
          )}
        </div>
      </div>

      {/* Leaflet Map Container */}
      <MapContainer
        center={[centerLat, centerLng]}
        zoom={14}
        scrollWheelZoom={false}
        className="w-full h-full z-0"
      >
        <MapViewController
          ambulanceLat={ambulanceLat}
          ambulanceLng={ambulanceLng}
          targetLat={targetLat}
          targetLng={targetLng}
          focusMode={focusMode}
          focusTrigger={focusTrigger}
        />

        <TileLayer attribution={tileAttribution} url={tileUrl} maxZoom={19} />

        {/* Route Line if both points exist */}
        {hasAmb && hasTarget && (
          <Polyline
            positions={[
              [ambulanceLat!, ambulanceLng!],
              [targetLat!, targetLng!],
            ]}
            color="#2563EB"
            weight={5}
            opacity={0.85}
          />
        )}

        {/* Ambulance Vehicle Marker */}
        {hasAmb && (
          <Marker
            position={[ambulanceLat!, ambulanceLng!]}
            icon={createAmbulanceIcon(ambulanceCallSign)}
          >
            <Popup>
              <div className="text-xs p-1 space-y-1">
                <span className="font-extrabold text-blue-600 uppercase tracking-wider text-[10px]">
                  Ambulance Location
                </span>
                <p className="font-semibold text-slate-800">{ambulanceCallSign}</p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {ambulanceLat?.toFixed(6)}, {ambulanceLng?.toFixed(6)}
                </p>
              </div>
            </Popup>
          </Marker>
        )}

        {/* Target Destination Marker */}
        {hasTarget && (
          <Marker
            position={[targetLat!, targetLng!]}
            icon={
              targetType === "hospital"
                ? createHospitalTargetIcon()
                : createIncidentTargetIcon()
            }
          >
            <Popup>
              <div className="text-xs p-1 space-y-1">
                <span
                  className={`font-extrabold uppercase tracking-wider text-[10px] ${
                    targetType === "hospital"
                      ? "text-emerald-600"
                      : "text-red-600"
                  }`}
                >
                  {targetType === "hospital"
                    ? "Receiving Hospital"
                    : "Incident Scene"}
                </span>
                <p className="font-semibold text-slate-800">{targetLabel}</p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {targetLat?.toFixed(6)}, {targetLng?.toFixed(6)}
                </p>
              </div>
            </Popup>
          </Marker>
        )}
      </MapContainer>

      {/* Bottom Floating Navigation Button */}
      {googleMapsUrl && (
        <div className="absolute bottom-3 right-3 z-20">
          <a
            href={googleMapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center space-x-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-md transition-colors"
          >
            <Navigation className="w-3.5 h-3.5 fill-current" />
            <span>Open in Google Maps</span>
          </a>
        </div>
      )}
    </div>
  );
}
