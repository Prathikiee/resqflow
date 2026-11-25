"use client";

import React, { useEffect } from "react";
import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";

interface CitizenTrackingMapProps {
  incidentLat: number;
  incidentLng: number;
  incidentAddress: string;
  ambulanceLat?: number;
  ambulanceLng?: number;
  ambulanceCallSign?: string;
  ambulanceType?: string;
  hospitalLat?: number;
  hospitalLng?: number;
  hospitalName?: string;
}

// Custom Leaflet DivIcons with clean light-theme styling
const createIncidentIcon = () =>
  L.divIcon({
    className: "custom-citizen-incident-marker",
    html: `
      <div class="relative flex items-center justify-center w-8 h-8">
        <span class="absolute w-8 h-8 rounded-full bg-red-500 animate-ping opacity-60"></span>
        <div class="relative w-7 h-7 rounded-full bg-red-600 border-2 border-white shadow-md flex items-center justify-center text-white font-black text-xs">
          SOS
        </div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

const createAmbulanceIcon = (callSign?: string) =>
  L.divIcon({
    className: "custom-citizen-ambulance-marker",
    html: `
      <div class="relative flex items-center justify-center w-8 h-8">
        <span class="absolute w-8 h-8 rounded-full bg-blue-500 animate-pulse opacity-40"></span>
        <div class="relative w-7 h-7 rounded-full bg-blue-600 border-2 border-white shadow-md flex items-center justify-center text-white font-bold text-[10px]">
          AMB
        </div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

const createHospitalIcon = () =>
  L.divIcon({
    className: "custom-citizen-hospital-marker",
    html: `
      <div class="relative flex items-center justify-center w-8 h-8">
        <div class="relative w-7 h-7 rounded-full bg-emerald-600 border-2 border-white shadow-md flex items-center justify-center text-white font-black text-xs">
          +
        </div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });

function MapViewController({
  incidentLat,
  incidentLng,
  ambulanceLat,
  ambulanceLng,
}: {
  incidentLat: number;
  incidentLng: number;
  ambulanceLat?: number;
  ambulanceLng?: number;
}) {
  const map = useMap();

  useEffect(() => {
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 150);

    const handleResize = () => map.invalidateSize();
    window.addEventListener("resize", handleResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", handleResize);
    };
  }, [map]);

  useEffect(() => {
    if (
      typeof ambulanceLat === "number" &&
      typeof ambulanceLng === "number" &&
      !isNaN(ambulanceLat) &&
      !isNaN(ambulanceLng) &&
      (ambulanceLat !== incidentLat || ambulanceLng !== incidentLng)
    ) {
      const bounds = L.latLngBounds(
        [incidentLat, incidentLng],
        [ambulanceLat, ambulanceLng]
      );
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    } else {
      map.setView([incidentLat, incidentLng], 15, { animate: true });
    }
  }, [incidentLat, incidentLng, ambulanceLat, ambulanceLng, map]);

  return null;
}

export default function CitizenTrackingMap({
  incidentLat,
  incidentLng,
  incidentAddress,
  ambulanceLat,
  ambulanceLng,
  ambulanceCallSign,
  ambulanceType,
  hospitalLat,
  hospitalLng,
  hospitalName,
}: CitizenTrackingMapProps) {
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

  const hasAmbulanceCoords =
    typeof ambulanceLat === "number" &&
    typeof ambulanceLng === "number" &&
    !isNaN(ambulanceLat) &&
    !isNaN(ambulanceLng) &&
    ambulanceLat !== 0 &&
    ambulanceLng !== 0;

  const hasHospitalCoords =
    typeof hospitalLat === "number" &&
    typeof hospitalLng === "number" &&
    !isNaN(hospitalLat) &&
    !isNaN(hospitalLng) &&
    hospitalLat !== 0 &&
    hospitalLng !== 0;

  return (
    <div className="relative w-full h-64 sm:h-72 rounded-2xl overflow-hidden border border-slate-200 shadow-2xs">
      <MapContainer
        center={[incidentLat, incidentLng]}
        zoom={15}
        scrollWheelZoom={false}
        className="w-full h-full z-0"
      >
        <MapViewController
          incidentLat={incidentLat}
          incidentLng={incidentLng}
          ambulanceLat={hasAmbulanceCoords ? ambulanceLat : undefined}
          ambulanceLng={hasAmbulanceCoords ? ambulanceLng : undefined}
        />

        <TileLayer attribution={tileAttribution} url={tileUrl} maxZoom={19} />

        {/* Incident Marker */}
        <Marker position={[incidentLat, incidentLng]} icon={createIncidentIcon()}>
          <Popup>
            <div className="text-xs p-1 space-y-1">
              <span className="font-extrabold text-red-600 uppercase tracking-wider text-[10px]">
                Your Location
              </span>
              <p className="font-semibold text-slate-800 text-xs">{incidentAddress}</p>
            </div>
          </Popup>
        </Marker>

        {/* Dispatched Ambulance Marker (Only if actual GPS coordinates present) */}
        {hasAmbulanceCoords && (
          <Marker
            position={[ambulanceLat!, ambulanceLng!]}
            icon={createAmbulanceIcon(ambulanceCallSign)}
          >
            <Popup>
              <div className="text-xs p-1 space-y-1">
                <span className="font-extrabold text-blue-600 uppercase tracking-wider text-[10px]">
                  En Route Ambulance
                </span>
                <p className="font-bold text-slate-900 text-xs">
                  {ambulanceCallSign || "Emergency Ambulance"} {ambulanceType ? `(${ambulanceType})` : ""}
                </p>
                <p className="text-[11px] text-slate-500 font-mono">
                  {ambulanceLat!.toFixed(4)}, {ambulanceLng!.toFixed(4)}
                </p>
              </div>
            </Popup>
          </Marker>
        )}

        {/* Destination Hospital Marker (Only if actual coordinates present) */}
        {hasHospitalCoords && (
          <Marker
            position={[hospitalLat!, hospitalLng!]}
            icon={createHospitalIcon()}
          >
            <Popup>
              <div className="text-xs p-1 space-y-1">
                <span className="font-extrabold text-emerald-600 uppercase tracking-wider text-[10px]">
                  Destination Hospital
                </span>
                <p className="font-bold text-slate-900 text-xs">
                  {hospitalName || "Emergency Facility"}
                </p>
              </div>
            </Popup>
          </Marker>
        )}
      </MapContainer>

      {/* Compact map status badge */}
      <div className="absolute top-2.5 right-2.5 z-[1000] bg-white/90 backdrop-blur-xs border border-slate-200/80 rounded-lg px-2 py-1 text-[10px] font-bold text-slate-700 shadow-2xs flex items-center gap-1.5 pointer-events-none">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        <span>Live Emergency Map</span>
      </div>
    </div>
  );
}
