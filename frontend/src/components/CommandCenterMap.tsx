"use client";

import React, { useEffect } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import L from "leaflet";

interface Location {
  latitude: number;
  longitude: number;
}

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
  triage_justifications: string[];
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

// Custom Leaflet DivIcons to ensure reliable rendering without external marker images
const createIncidentIcon = (color: string, isSelected: boolean) => {
  const bgClass =
    color === "RED"
      ? "bg-red-600 border-red-300"
      : color === "YELLOW"
      ? "bg-amber-500 border-amber-200"
      : "bg-emerald-600 border-emerald-200";

  const ringAnimation = isSelected ? "animate-ping opacity-75" : "animate-pulse";

  return L.divIcon({
    className: "custom-incident-marker",
    html: `
      <div class="relative flex items-center justify-center w-8 h-8">
        <span class="absolute w-8 h-8 rounded-full ${bgClass} ${ringAnimation} opacity-40"></span>
        <div class="relative w-6 h-6 rounded-full ${bgClass} border-2 shadow-lg flex items-center justify-center text-white text-[10px] font-bold">
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
      ? "bg-blue-600 border-blue-300"
      : "bg-cyan-600 border-cyan-300"
    : "bg-slate-600 border-slate-400 opacity-60";

  return L.divIcon({
    className: "custom-amb-marker",
    html: `
      <div class="w-7 h-7 rounded-lg ${bg} border-2 shadow-md flex items-center justify-center text-white font-mono text-[9px] font-bold">
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
      <div class="w-7 h-7 rounded-lg bg-emerald-700 border-2 border-emerald-300 shadow-md flex items-center justify-center text-white text-xs font-bold">
        +
      </div>
    `,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
};

// Component to recenter map when selected incident changes
function ChangeView({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom, { animate: true });
  }, [center, zoom, map]);
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
  return (
    <div className="w-full h-full relative rounded-xl overflow-hidden border border-slate-800 bg-slate-950">
      <MapContainer
        center={center}
        zoom={zoom}
        style={{ height: "100%", width: "100%", background: "#090d16" }}
        attributionControl={true}
      >
        <ChangeView center={center} zoom={zoom} />

        {/* Dark-styled OpenStreetMap tile layer (CartoDB Dark Matter) */}
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">CARTO</a> | &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />

        {/* Hospital Markers */}
        {hospitals.map((h) => (
          <Marker
            key={`hosp-${h.id}`}
            position={[h.latitude, h.longitude]}
            icon={createHospitalIcon()}
          >
            <Popup className="resqflow-popup">
              <div className="text-xs p-1 space-y-1">
                <div className="font-bold text-emerald-400">{h.name}</div>
                <div className="text-slate-300 text-[11px]">{h.address}</div>
                <div className="flex gap-2 text-[10px] pt-1">
                  <span className="bg-emerald-950 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-800 font-mono">
                    ICU: {h.available_icu_beds}/{h.total_icu_beds}
                  </span>
                  <span className="bg-blue-950 text-blue-300 px-1.5 py-0.5 rounded border border-blue-800 font-mono">
                    ER: {h.available_emergency_beds}/{h.total_emergency_beds}
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 pt-0.5">
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
            <Popup className="resqflow-popup">
              <div className="text-xs p-1 space-y-1">
                <div className="font-bold flex items-center justify-between gap-2">
                  <span className="text-blue-400">{amb.call_sign}</span>
                  <span
                    className={`text-[9px] px-1 py-0.2 rounded font-mono ${
                      amb.status === "AVAILABLE"
                        ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                        : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {amb.status}
                  </span>
                </div>
                <div className="text-[11px] text-slate-300">Base: {amb.base_station}</div>
                <div className="flex gap-2 text-[10px] font-mono">
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
            <Popup className="resqflow-popup">
              <div className="text-xs p-1 space-y-1 max-w-[220px]">
                <div className="flex items-center justify-between gap-1">
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase font-mono ${
                      inc.triage_color === "RED"
                        ? "bg-red-950 text-red-400 border border-red-800"
                        : inc.triage_color === "YELLOW"
                        ? "bg-amber-950 text-amber-400 border border-amber-800"
                        : "bg-emerald-950 text-emerald-400 border border-emerald-800"
                    }`}
                  >
                    {inc.triage_level}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">#{inc.id}</span>
                </div>
                <div className="font-semibold text-slate-100 text-[11px]">
                  {inc.chief_complaint}
                </div>
                <div className="text-slate-400 text-[10px]">{inc.location_address}</div>
                <div className="text-[10px] font-mono text-blue-400 pt-1">
                  Status: {inc.status} • Need: {inc.required_ambulance_type}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Dispatched Route Polyline */}
        {activeRouteGeometry && activeRouteGeometry.length > 0 && (
          <Polyline
            positions={activeRouteGeometry as [number, number][]}
            pathOptions={{
              color: "#3b82f6",
              weight: 5,
              opacity: 0.85,
              dashArray: "1, 8",
              dashOffset: "0",
            }}
          />
        )}
      </MapContainer>

      {/* Floating Map Legend */}
      <div className="absolute bottom-3 left-3 z-[1000] bg-slate-900/90 backdrop-blur border border-slate-800 rounded-lg p-2.5 text-[10px] space-y-1.5 shadow-xl pointer-events-auto">
        <div className="font-bold uppercase tracking-wider text-slate-400 text-[9px] border-b border-slate-800 pb-1">
          Command Map Legend (Mangaluru)
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse" />
          <span>Priority 1 Incident (Red / Critical)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
          <span>Priority 2 Incident (Yellow / Urgent)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-md bg-blue-600" />
          <span>ALS Ambulance (ICU Equipped)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-md bg-cyan-600" />
          <span>BLS Ambulance (Basic Life Support)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-md bg-emerald-700 text-white flex items-center justify-center font-bold text-[8px]">
            +
          </span>
          <span>Emergency Receiving Hospital</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-4 h-0.5 bg-blue-500" />
          <span>OSRM Emergency Route (Lights & Siren)</span>
        </div>
      </div>
    </div>
  );
}
