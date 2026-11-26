"use client";

import React, { useEffect, useRef, useState } from "react";
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
import { Crosshair, Maximize2, RotateCcw } from "lucide-react";

interface IncidentItem {
  id: number;
  caller_name: string;
  caller_phone: string;
  location_address: string;
  latitude: number;
  longitude: number;
  chief_complaint: string;
  triage_level: string;
  triage_color: string;
  triage_score: number;
  required_ambulance_type: string;
  status: string;
  triage_justifications?: string[];
}

interface AmbulanceItem {
  id: number;
  call_sign: string;
  vehicle_type: string;
  paramedic_level: string;
  status: string;
  base_station: string;
  current_latitude: number;
  current_longitude: number;
  fuel_level_percent: number;
  equipment: string[];
}

interface HospitalItem {
  id: number;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  total_icu_beds: number;
  available_icu_beds: number;
  total_emergency_beds: number;
  available_emergency_beds: number;
  specialties: string[];
  contact_number: string;
}

interface MapProps {
  incidents: IncidentItem[];
  ambulances: AmbulanceItem[];
  hospitals: HospitalItem[];
  activeRouteGeometry?: number[][];
  selectedIncident?: IncidentItem | null;
  onSelectIncident?: (inc: IncidentItem) => void;
  center?: [number, number];
  zoom?: number;
}

// Custom Leaflet DivIcons with crisp styling for light theme
const createIncidentIcon = (color: string, isSelected: boolean) => {
  const bgClass =
    color === "RED"
      ? "bg-red-600 border-white text-white"
      : color === "YELLOW"
      ? "bg-amber-500 border-white text-white"
      : "bg-emerald-600 border-white text-white";

  const ringAnimation = isSelected ? "animate-ping opacity-80" : "animate-pulse opacity-40";

  return L.divIcon({
    className: "custom-incident-marker",
    html: `
      <div class="relative flex items-center justify-center w-8 h-8">
        <span class="absolute w-8 h-8 rounded-full ${bgClass} ${ringAnimation}"></span>
        <div class="relative w-6 h-6 rounded-full ${bgClass} border-2 shadow-md flex items-center justify-center text-[11px] font-black">
          !
        </div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
};

const createAmbulanceIcon = (type: string, status: string) => {
  const isAvailable = status === "AVAILABLE";
  const bg = isAvailable
    ? type === "ALS"
      ? "bg-blue-600 border-white"
      : "bg-cyan-600 border-white"
    : "bg-slate-500 border-slate-200 opacity-75";

  return L.divIcon({
    className: "custom-amb-marker",
    html: `
      <div class="w-7 h-7 rounded-lg ${bg} border-2 shadow-md flex items-center justify-center text-white font-mono text-[9px] font-black">
        ${type === "ALS" ? "ALS" : "BLS"}
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
};

const createHospitalIcon = () => {
  return L.divIcon({
    className: "custom-hospital-marker",
    html: `
      <div class="w-7 h-7 rounded-lg bg-emerald-600 border-2 border-white shadow-md flex items-center justify-center text-white text-xs font-black">
        +
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
};

// Component to handle auto-resize and view centering
function MapController({
  centerLat,
  centerLng,
  zoom,
  selectedIncident,
  recenterTrigger,
  fitAllTrigger,
  allCoordinates,
}: {
  centerLat: number;
  centerLng: number;
  zoom: number;
  selectedIncident?: IncidentItem | null;
  recenterTrigger: number;
  fitAllTrigger: number;
  allCoordinates: [number, number][];
}) {
  const map = useMap();
  const userInteractedRef = useRef(false);
  const lastSelectedIncidentIdRef = useRef<number | null>(null);

  useEffect(() => {
    // Invalidate map size after mount or container layout changes
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

  // Center once when selected incident changes
  useEffect(() => {
    if (selectedIncident && selectedIncident.id !== lastSelectedIncidentIdRef.current) {
      lastSelectedIncidentIdRef.current = selectedIncident.id;
      userInteractedRef.current = false;
      map.setView([selectedIncident.latitude, selectedIncident.longitude], 15, { animate: true });
    }
  }, [selectedIncident, map]);

  // Handle explicit Recenter button
  useEffect(() => {
    if (recenterTrigger > 0) {
      userInteractedRef.current = false;
      if (selectedIncident) {
        map.setView([selectedIncident.latitude, selectedIncident.longitude], 15, { animate: true });
      } else {
        map.setView([centerLat, centerLng], zoom, { animate: true });
      }
    }
  }, [recenterTrigger, centerLat, centerLng, zoom, selectedIncident, map]);

  // Handle explicit Fit All (Reset View) button
  useEffect(() => {
    if (fitAllTrigger > 0 && allCoordinates.length > 0) {
      userInteractedRef.current = false;
      const bounds = L.latLngBounds(allCoordinates);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
    }
  }, [fitAllTrigger, allCoordinates, map]);

  // Initial mount centering only (does not reset user pan on subsequent renders)
  const isMountedRef = useRef(false);
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      if (selectedIncident) {
        map.setView([selectedIncident.latitude, selectedIncident.longitude], 15, { animate: false });
      } else {
        map.setView([centerLat, centerLng], zoom, { animate: false });
      }
    }
  }, [centerLat, centerLng, zoom, selectedIncident, map]);

  return null;
}

export default function CommandCenterMap({
  incidents,
  ambulances,
  hospitals,
  activeRouteGeometry,
  selectedIncident,
  onSelectIncident,
  center = [12.891, 74.856], // Centered over Mangaluru
  zoom = 13,
}: MapProps) {
  const [recenterTrigger, setRecenterTrigger] = useState(0);
  const [fitAllTrigger, setFitAllTrigger] = useState(0);

  // Compute all active coordinates for Fit All
  const allCoordinates: [number, number][] = [
    ...incidents.map((i) => [i.latitude, i.longitude] as [number, number]),
    ...ambulances.map((a) => [a.current_latitude, a.current_longitude] as [number, number]),
    ...hospitals.map((h) => [h.latitude, h.longitude] as [number, number]),
  ];

  // Tile provider configuration:
  // 1. If custom tile URL specified, use it.
  // 2. If Carto API key is provided, use CartoDB Voyager with authorized key.
  // 3. Otherwise default to OpenStreetMap standard tiles (reliable, zero watermark, no key required).
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
    tileUrl = `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?api_key=${cartoApiKey}`;
    tileAttribution =
      '&copy; <a href="https://carto.com/">CARTO</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  } else {
    tileUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    tileAttribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  }

  return (
    <div className="w-full h-full min-h-[480px] relative rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shadow-sm">
      {/* Floating View Controls (Recenter & Reset View) */}
      <div className="absolute top-3 right-3 z-[1000] flex items-center gap-1.5 bg-white/95 backdrop-blur border border-slate-200 rounded-lg p-1 shadow-md">
        <button
          type="button"
          onClick={() => setRecenterTrigger((prev) => prev + 1)}
          className="px-2.5 py-1 text-xs font-semibold text-slate-700 hover:text-blue-600 hover:bg-slate-50 rounded flex items-center gap-1 transition"
          title="Recenter on selected emergency or regional center"
        >
          <Crosshair className="w-3.5 h-3.5" />
          <span>Recenter</span>
        </button>
        <span className="w-px h-4 bg-slate-200" />
        <button
          type="button"
          onClick={() => setFitAllTrigger((prev) => prev + 1)}
          className="px-2.5 py-1 text-xs font-semibold text-slate-700 hover:text-blue-600 hover:bg-slate-50 rounded flex items-center gap-1 transition"
          title="Reset map view to show all regional resources"
        >
          <Maximize2 className="w-3.5 h-3.5" />
          <span>Fit All</span>
        </button>
      </div>

      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: "100%", width: "100%", minHeight: "480px", background: "#f8fafc" }}
        attributionControl={true}
      >
        <MapController
          centerLat={center[0]}
          centerLng={center[1]}
          zoom={zoom}
          selectedIncident={selectedIncident}
          recenterTrigger={recenterTrigger}
          fitAllTrigger={fitAllTrigger}
          allCoordinates={allCoordinates}
        />

        {/* Dynamic Tile Layer (Configured with API key or OpenStreetMap fallback) */}
        <TileLayer
          attribution={tileAttribution}
          url={tileUrl}
          maxZoom={19}
        />

        {/* Hospital Markers */}
        {hospitals.map((h) => (
          <Marker
            key={`hosp-${h.id}`}
            position={[h.latitude, h.longitude]}
            icon={createHospitalIcon()}
          >
            <Popup>
              <div className="text-xs p-1 space-y-1 max-w-[210px]">
                <div className="font-bold text-emerald-700 text-[12px]">{h.name}</div>
                <div className="text-slate-600 text-[11px] leading-tight">{h.address}</div>
                <div className="flex gap-2 text-[10px] pt-1">
                  <span className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200 font-mono font-semibold">
                    ICU: {h.available_icu_beds}/{h.total_icu_beds}
                  </span>
                  <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200 font-mono font-semibold">
                    ER: {h.available_emergency_beds}/{h.total_emergency_beds}
                  </span>
                </div>
                <div className="text-[10px] text-slate-500 pt-0.5">
                  Dept: {h.specialties.slice(0, 2).join(", ")}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Ambulance Markers */}
        {ambulances.map((amb) => (
          <Marker
            key={`amb-${amb.id}`}
            position={[amb.current_latitude, amb.current_longitude]}
            icon={createAmbulanceIcon(amb.vehicle_type, amb.status)}
          >
            <Popup>
              <div className="text-xs p-1 space-y-1 max-w-[200px]">
                <div className="font-bold flex items-center justify-between gap-2">
                  <span className="text-blue-700 font-mono text-[12px]">{amb.call_sign}</span>
                  <span
                    className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold ${
                      amb.status === "AVAILABLE"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : "bg-slate-100 text-slate-600 border border-slate-200"
                    }`}
                  >
                    {amb.status}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600">Base: {amb.base_station}</div>
                <div className="flex gap-2 text-[10px] font-mono text-slate-700 pt-0.5">
                  <span>Type: {amb.vehicle_type}</span>
                  <span>Fuel: {amb.fuel_level_percent}%</span>
                  <span>Crew: {amb.paramedic_level}</span>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Emergency Incident Markers */}
        {incidents.map((inc) => (
          <Marker
            key={`inc-${inc.id}`}
            position={[inc.latitude, inc.longitude]}
            icon={createIncidentIcon(
              inc.triage_color,
              selectedIncident?.id === inc.id
            )}
            eventHandlers={{
              click: () => onSelectIncident && onSelectIncident(inc),
            }}
          >
            <Popup>
              <div className="text-xs p-1 space-y-1 max-w-[220px]">
                <div className="flex items-center justify-between gap-1">
                  <span
                    className={`text-[10px] font-black px-1.5 py-0.5 rounded uppercase font-mono ${
                      inc.triage_color === "RED"
                        ? "bg-red-50 text-red-700 border border-red-200"
                        : inc.triage_color === "YELLOW"
                        ? "bg-amber-50 text-amber-700 border border-amber-200"
                        : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                    }`}
                  >
                    {inc.triage_level}
                  </span>
                  <span className="text-[10px] text-slate-500 font-mono font-semibold">#{inc.id}</span>
                </div>
                <div className="font-bold text-slate-900 text-[11px] leading-snug">
                  {inc.chief_complaint}
                </div>
                <div className="text-slate-600 text-[10px]">{inc.location_address}</div>
                <div className="text-[10px] font-mono text-blue-700 pt-0.5 font-semibold">
                  Status: {inc.status} • Need: {inc.required_ambulance_type}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Active Emergency Dispatched Route Polyline */}
        {activeRouteGeometry && activeRouteGeometry.length > 0 && (
          <Polyline
            positions={activeRouteGeometry as [number, number][]}
            pathOptions={{
              color: "#2563eb",
              weight: 5,
              opacity: 0.85,
              dashArray: "2, 8",
              dashOffset: "0",
            }}
          />
        )}
      </MapContainer>

      {/* Floating Map Legend */}
      <div className="absolute bottom-3 left-3 z-[1000] bg-white/95 backdrop-blur border border-slate-200 rounded-lg p-2.5 text-[10px] space-y-1.5 shadow-md pointer-events-auto">
        <div className="font-bold uppercase tracking-wider text-slate-500 text-[9px] border-b border-slate-200 pb-1">
          Command Map Legend (Mangaluru)
        </div>
        <div className="flex items-center gap-2 text-slate-700">
          <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse border border-white shadow-xs" />
          <span>Priority 1 Incident (Red / Critical)</span>
        </div>
        <div className="flex items-center gap-2 text-slate-700">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 border border-white shadow-xs" />
          <span>Priority 2 Incident (Yellow / Urgent)</span>
        </div>
        <div className="flex items-center gap-2 text-slate-700">
          <span className="w-2.5 h-2.5 rounded-md bg-blue-600 text-white font-mono text-[7px] flex items-center justify-center font-bold">ALS</span>
          <span>ALS Ambulance (ICU Advanced)</span>
        </div>
        <div className="flex items-center gap-2 text-slate-700">
          <span className="w-2.5 h-2.5 rounded-md bg-cyan-600 text-white font-mono text-[7px] flex items-center justify-center font-bold">BLS</span>
          <span>BLS Ambulance (Basic Life Support)</span>
        </div>
        <div className="flex items-center gap-2 text-slate-700">
          <span className="w-2.5 h-2.5 rounded-md bg-emerald-600 text-white flex items-center justify-center font-black text-[9px]">
            +
          </span>
          <span>Emergency Receiving Hospital</span>
        </div>
        <div className="flex items-center gap-2 text-slate-700">
          <span className="w-4 h-0.5 bg-blue-600" />
          <span>OSRM Emergency Route</span>
        </div>
      </div>
    </div>
  );
}
