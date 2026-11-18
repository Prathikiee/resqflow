"use client";

import React, { useState } from "react";
import {
  AlertCircle,
  Ambulance,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Compass,
  FileText,
  Fuel,
  Info,
  Layers,
  MapPin,
  Route,
  Shield,
  ShieldAlert,
  Sliders,
  Sparkles,
  UserCheck,
  X,
  XCircle,
} from "lucide-react";

interface AllocationModalProps {
  isOpen: boolean;
  onClose: () => void;
  incident: any;
  recommendations: any;
  onDispatchConfirmed: (dispatch: any) => void;
}

export default function AllocationModal({
  isOpen,
  onClose,
  incident,
  recommendations,
  onDispatchConfirmed,
}: AllocationModalProps) {
  const [selectedAmbId, setSelectedAmbId] = useState<number | null>(null);
  const [selectedHospId, setSelectedHospId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen || !incident || !recommendations) return null;

  const rankedAmbulances = recommendations?.ambulance_allocation?.ranked_ambulances || [];
  const excludedAmbulances = recommendations?.ambulance_allocation?.excluded_ambulances || [];
  const rankedHospitals = recommendations?.hospital_ranking?.ranked_hospitals || [];

  const defaultAmbId = selectedAmbId || (rankedAmbulances[0]?.ambulance_id ?? null);
  const defaultHospId = selectedHospId || (rankedHospitals[0]?.hospital_id ?? null);

  const selectedAmbulance = rankedAmbulances.find((a: any) => a.ambulance_id === defaultAmbId) || rankedAmbulances[0];
  const selectedHospital = rankedHospitals.find((h: any) => h.hospital_id === defaultHospId) || rankedHospitals[0];

  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const handleConfirmDispatch = async () => {
    if (!defaultAmbId) {
      alert("Please select an ambulance unit.");
      return;
    }
    setSubmitting(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${backendUrl}/api/dispatch`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          incident_id: incident.id,
          ambulance_id: defaultAmbId,
          destination_hospital_id: defaultHospId,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.detail || "Dispatch failed");
      }

      const dispatch = await res.json();
      onDispatchConfirmed(dispatch);
      onClose();
    } catch (err: any) {
      alert(`Dispatch error: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-5xl bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col my-6 max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">Intelligent Ambulance & Hospital Allocation</h2>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-semibold">
                  Multi-Factor Engine
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Incident #{incident.id}: {incident.chief_complaint?.slice(0, 75)}...
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Incident Context Strip */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="flex items-center gap-3">
              <span
                className={`font-bold px-2 py-0.5 rounded uppercase font-mono text-[11px] ${
                  incident.triage_color === "RED"
                    ? "bg-red-50 text-red-700 border border-red-200"
                    : incident.triage_color === "YELLOW"
                    ? "bg-amber-50 text-amber-700 border border-amber-200"
                    : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                }`}
              >
                {incident.triage_level}
              </span>
              <span className="text-slate-700">
                Mandatory Tier: <strong className="text-blue-600">{incident.required_ambulance_type}</strong>
              </span>
            </div>

            <div className="flex items-center gap-2 text-slate-500">
              <MapPin className="w-3.5 h-3.5 text-red-500" />
              <span>{incident.location_address}</span>
            </div>
          </div>

          {/* Section 1: Ambulance Ranking & Explainability */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Ambulance className="w-4 h-4 text-blue-600" />
                Ambulance Fleet Allocation (Multi-Factor Scoring)
              </h3>
              <span className="text-[11px] text-slate-500 font-mono">
                Weights: ETA 40% • Capability 25% • Equip 20% • Readiness 15%
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {rankedAmbulances.map((amb: any) => {
                const isSelected = (defaultAmbId === amb.ambulance_id);
                return (
                  <div
                    key={amb.ambulance_id}
                    onClick={() => setSelectedAmbId(amb.ambulance_id)}
                    className={`p-4 rounded-xl border transition cursor-pointer flex flex-col justify-between space-y-3 ${
                      isSelected
                        ? "bg-blue-50/70 border-blue-500 shadow-sm ring-1 ring-blue-500"
                        : "bg-white border-slate-200 hover:border-slate-300 shadow-2xs"
                    }`}
                  >
                    <div>
                      {/* Top Bar: Rank & Score */}
                      <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                              amb.rank === 1
                                ? "bg-amber-400 text-black font-extrabold"
                                : "bg-slate-100 text-slate-700 border border-slate-200"
                            }`}
                          >
                            #{amb.rank}
                          </span>
                          <span className="font-bold text-slate-800 text-xs">{amb.call_sign}</span>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-black text-blue-600 font-mono">
                            {amb.total_score} <span className="text-[10px] text-slate-400 font-normal">/100</span>
                          </div>
                        </div>
                      </div>

                      {/* Specs */}
                      <div className="pt-2 text-[11px] space-y-1 text-slate-600">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Type / Paramedic:</span>
                          <span className="font-semibold text-slate-800">
                            {amb.vehicle_type} ({amb.paramedic_level})
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Base Station:</span>
                          <span className="text-slate-700">{amb.base_station}</span>
                        </div>
                        <div className="flex justify-between font-mono">
                          <span className="text-slate-400">ETA / Distance:</span>
                          <span className="text-emerald-600 font-bold">
                            {amb.eta_minutes} mins ({(amb.distance_meters / 1000).toFixed(1)} km)
                          </span>
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400 pt-0.5">
                          <span>Routing Mode:</span>
                          <span className="font-medium text-slate-600">{amb.routing_mode}</span>
                        </div>
                      </div>

                      {/* Factor Breakdown Bars */}
                      <div className="pt-2 space-y-1 text-[10px]">
                        <div className="flex justify-between text-slate-500">
                          <span>ETA Proximity (40%):</span>
                          <span className="font-mono font-medium text-slate-800">{amb.score_breakdown.proximity_eta_score}</span>
                        </div>
                        <div className="w-full bg-slate-100 h-1 rounded-full overflow-hidden">
                          <div
                            className="bg-blue-600 h-full rounded-full"
                            style={{ width: `${amb.score_breakdown.proximity_eta_score}%` }}
                          />
                        </div>

                        <div className="flex justify-between text-slate-500 pt-1">
                          <span>Capability Fit (25%):</span>
                          <span className="font-mono font-medium text-slate-800">{amb.score_breakdown.capability_match_score}</span>
                        </div>
                        <div className="w-full bg-slate-100 h-1 rounded-full overflow-hidden">
                          <div
                            className="bg-emerald-500 h-full rounded-full"
                            style={{ width: `${amb.score_breakdown.capability_match_score}%` }}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Radio Select Button */}
                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-[10px] text-slate-400 font-mono">Fuel: {amb.fuel_level_percent}%</span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                          isSelected
                            ? "bg-blue-600 text-white font-bold"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {isSelected ? "Selected for Dispatch" : "Select Unit"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Excluded Ambulances Transparency Panel */}
          {excludedAmbulances.length > 0 && (
            <div className="p-3.5 rounded-xl border border-red-200 bg-red-50/50 space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-red-700">
                <XCircle className="w-4 h-4 text-red-600" />
                <span>Pre-Filtered Excluded Units ({excludedAmbulances.length})</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                {excludedAmbulances.map((ex: any) => (
                  <div key={ex.ambulance_id} className="p-2 rounded-lg bg-white border border-red-200 flex justify-between gap-2 shadow-2xs">
                    <div>
                      <span className="font-bold text-slate-800">{ex.call_sign}</span>{" "}
                      <span className="text-[10px] text-slate-500">({ex.vehicle_type})</span>
                      <p className="text-[10px] text-slate-600 mt-0.5">{ex.reasons.join(" • ")}</p>
                    </div>
                    <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-red-700 font-mono h-fit font-bold border border-slate-200">
                      {ex.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Section 2: Hospital Suitability Matching */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Building2 className="w-4 h-4 text-emerald-600" />
                Receiving Hospital Suitability Matching
              </h3>
              <span className="text-[11px] text-slate-500 font-mono">
                Weights: Specialty 35% • Proximity 30% • ICU 20% • ER 15%
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {rankedHospitals.map((hosp: any) => {
                const isSelected = (defaultHospId === hosp.hospital_id);
                return (
                  <div
                    key={hosp.hospital_id}
                    onClick={() => setSelectedHospId(hosp.hospital_id)}
                    className={`p-4 rounded-xl border transition cursor-pointer flex flex-col justify-between space-y-2 ${
                      isSelected
                        ? "bg-emerald-50/70 border-emerald-500 shadow-sm ring-1 ring-emerald-500"
                        : "bg-white border-slate-200 hover:border-slate-300 shadow-2xs"
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-5 h-5 rounded-full flex items-center justify-center font-bold text-[10px] ${
                              hosp.rank === 1
                                ? "bg-emerald-500 text-white font-black"
                                : "bg-slate-100 text-slate-700 border border-slate-200"
                            }`}
                          >
                            #{hosp.rank}
                          </span>
                          <span className="font-bold text-slate-900 text-xs">{hosp.name}</span>
                        </div>
                        <div className="text-xs font-mono font-black text-emerald-600">
                          {hosp.total_suitability_score} <span className="text-[9px] text-slate-400 font-normal">/100</span>
                        </div>
                      </div>

                      <div className="pt-2 text-[11px] space-y-1 text-slate-600">
                        <div className="flex justify-between">
                          <span className="text-slate-400">Transit ETA:</span>
                          <span className="font-mono text-emerald-600 font-bold">
                            ~{hosp.transit_minutes} mins ({(hosp.distance_meters / 1000).toFixed(1)} km)
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-slate-400">Beds Vacancy:</span>
                          <span className="font-mono text-slate-800">
                            ICU: {hosp.available_icu_beds}/{hosp.total_icu_beds} • ER: {hosp.available_emergency_beds}/{hosp.total_emergency_beds}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-500 pt-1">
                          Matched Specialties:{" "}
                          <strong className="text-blue-600">
                            {hosp.matched_specialties.length > 0 ? hosp.matched_specialties.join(", ") : "General Emergency"}
                          </strong>
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                      <span className="text-[10px] text-slate-400 font-mono">{hosp.contact_number}</span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                          isSelected
                            ? "bg-emerald-600 text-white font-bold"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {isSelected ? "Destination Set" : "Select Hospital"}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Modal Footer / Dispatch Action */}
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-4">
          <div className="text-xs text-slate-600">
            Assigned: <strong className="text-blue-600 font-bold">{selectedAmbulance?.call_sign}</strong> → Destination:{" "}
            <strong className="text-emerald-600 font-bold">{selectedHospital?.name}</strong>
            <span className="block text-[10px] text-slate-400 font-mono mt-0.5">
              Provisional reservation holds ambulance & ER bay for 90s until dual confirmation
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 text-xs font-semibold cursor-pointer transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmDispatch}
              disabled={submitting || !selectedAmbulance}
              className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-600/20 transition flex items-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {submitting ? "Initiating Dual-Reservation..." : "Confirm & Reserve Unit (Dual Confirmation)"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
