"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  Ambulance,
  ArrowRight,
  Building2,
  CheckCircle2,
  Clock,
  Compass,
  FilePlus2,
  Filter,
  Layers,
  MapPin,
  Phone,
  Radio,
  RotateCcw,
  Server,
  ShieldAlert,
  Sliders,
  Sparkles,
  User,
  Zap,
} from "lucide-react";
import DynamicCommandCenterMap from "@/components/MapWrapper";
import IncidentRegistrationModal from "@/components/IncidentRegistrationModal";
import AllocationModal from "@/components/AllocationModal";
import { formatDistance, formatDuration } from "@/lib/utils";

export default function CommandCenterDashboard() {
  const [incidents, setIncidents] = useState<any[]>([]);
  const [ambulances, setAmbulances] = useState<any[]>([]);
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [dispatches, setDispatches] = useState<any[]>([]);

  const [selectedIncident, setSelectedIncident] = useState<any | null>(null);
  const [recommendations, setRecommendations] = useState<any | null>(null);
  const [activeRouteGeometry, setActiveRouteGeometry] = useState<number[][]>([]);

  const [isRegistrationOpen, setIsRegistrationOpen] = useState(false);
  const [isAllocationOpen, setIsAllocationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Fetch all core operational data
  const fetchData = useCallback(async () => {
    try {
      const [incRes, ambRes, hospRes, dispRes] = await Promise.all([
        fetch(`${backendUrl}/api/incidents`),
        fetch(`${backendUrl}/api/ambulances`),
        fetch(`${backendUrl}/api/hospitals`),
        fetch(`${backendUrl}/api/dispatch`),
      ]);

      if (incRes.ok) setIncidents(await incRes.json());
      if (ambRes.ok) setAmbulances(await ambRes.json());
      if (hospRes.ok) setHospitals(await hospRes.json());
      if (dispRes.ok) setDispatches(await dispRes.json());
    } catch (err) {
      console.error("Failed to fetch operational data:", err);
    } finally {
      setLoading(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 8000);

    // Live WebSocket connection for instant event-driven synchronization
    const wsUrl = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000")
      .replace(/^http/, "ws") + "/ws/live";
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    function connectWs() {
      try {
        ws = new WebSocket(wsUrl);
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.event && msg.event !== "PONG" && msg.event !== "HANDSHAKE") {
              fetchData();
            }
          } catch (e) {}
        };
        ws.onclose = () => {
          reconnectTimer = setTimeout(connectWs, 3000);
        };
        ws.onerror = () => {
          ws?.close();
        };
      } catch (e) {}
    }

    connectWs();

    return () => {
      clearInterval(interval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [fetchData]);

  // Set default selected incident if none selected
  useEffect(() => {
    if (incidents.length > 0 && !selectedIncident) {
      setSelectedIncident(incidents[0]);
    }
  }, [incidents, selectedIncident]);

  // When selected incident changes, fetch dispatch recommendations and active route
  useEffect(() => {
    if (!selectedIncident) return;

    // Check if this incident has an active dispatch
    const existingDispatch = dispatches.find((d) => d.incident_id === selectedIncident.id);
    if (existingDispatch && existingDispatch.route_geometry?.length > 0) {
      setActiveRouteGeometry(existingDispatch.route_geometry);
    } else {
      setActiveRouteGeometry([]);
    }

    // Preload allocation recommendations for this incident
    fetch(`${backendUrl}/api/dispatch/recommend/${selectedIncident.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) {
          setRecommendations(data);
          // If no active dispatch route, preview recommended ambulance route
          if (!existingDispatch && data.ambulance_allocation?.recommended_ambulance?.route_geometry) {
            setActiveRouteGeometry(data.ambulance_allocation.recommended_ambulance.route_geometry);
          }
        }
      })
      .catch((err) => console.error("Error preloading recommendation:", err));
  }, [selectedIncident, dispatches, backendUrl]);

  const handleResetSeed = async () => {
    if (!confirm("Reset database with fresh Mangaluru fleet and incident seed data?")) return;
    try {
      const res = await fetch(`${backendUrl}/api/seed?force=true`, { method: "POST" });
      if (res.ok) {
        await fetchData();
        setSelectedIncident(null);
      }
    } catch (err) {
      alert("Failed to reset seed data");
    }
  };

  const handleStepLifecycle = async (dispatchId: number) => {
    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/step`, {
        method: "PATCH",
      });
      if (res.ok) {
        await fetchData();
        // Refresh selected incident
        const updatedIncRes = await fetch(`${backendUrl}/api/incidents/${selectedIncident.id}`);
        if (updatedIncRes.ok) {
          setSelectedIncident(await updatedIncRes.json());
        }
      }
    } catch (err) {
      console.error("Step error:", err);
    }
  };

  const handleConfirmAmbulance = async (dispatchId: number, decision: "ACCEPTED" | "REJECTED") => {
    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm/ambulance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Ambulance confirmation error: ${err.detail || "Failed"}`);
      }
      await fetchData();
    } catch (err: any) {
      console.error("Ambulance confirm failed:", err);
    }
  };

  const handleConfirmHospital = async (dispatchId: number, decision: "ACCEPTED" | "REJECTED") => {
    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm/hospital`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Hospital confirmation error: ${err.detail || "Failed"}`);
      }
      await fetchData();
    } catch (err: any) {
      console.error("Hospital confirm failed:", err);
    }
  };

  const handleReassignDispatch = async (dispatchId: number) => {
    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/reassign`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Reassignment failed: ${err.detail || "Could not reassign"}`);
      }
      await fetchData();
    } catch (err: any) {
      console.error("Reassignment error:", err);
    }
  };

  // 1-second interval to update reservation countdown tickers
  const [countdownTick, setCountdownTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setCountdownTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Find active dispatch for currently selected incident
  const currentDispatch = dispatches.find((d) => d.incident_id === selectedIncident?.id);
  const assignedAmbulance = ambulances.find((a) => a.id === currentDispatch?.ambulance_id);
  const assignedHospital = hospitals.find((h) => h.id === currentDispatch?.destination_hospital_id);
  const lastEscalation = currentDispatch?.escalation_history && currentDispatch.escalation_history.length > 0
    ? currentDispatch.escalation_history[currentDispatch.escalation_history.length - 1]
    : null;

  // Filtered incidents
  const filteredIncidents = incidents.filter((inc) => {
    if (statusFilter === "ALL") return true;
    if (statusFilter === "P1") return inc.triage_color === "RED";
    if (statusFilter === "ACTIVE") return inc.status !== "RESOLVED" && inc.status !== "CANCELLED";
    return true;
  });

  // Fleet stats
  const availableAmbs = ambulances.filter((a) => a.status === "AVAILABLE").length;
  const totalBeds = hospitals.reduce((acc, h) => acc + h.available_emergency_beds, 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Operations Header */}
      <header className="border-b border-slate-800 bg-slate-900/90 backdrop-blur px-5 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-lg bg-red-600/20 border border-red-500/40 flex items-center justify-center text-red-500">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-extrabold tracking-tight text-white">ResQFlow</h1>
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30 font-bold">
                Live Command Center
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Mangaluru Emergency Dispatch Corridor (12.9141° N, 74.8560° E)
            </p>
          </div>
        </div>

        {/* Real-Time Operational Counters */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs">
            <Ambulance className="w-4 h-4 text-blue-400" />
            <span className="text-slate-400">Available Fleet:</span>
            <span className="font-mono font-bold text-emerald-400">
              {availableAmbs} / {ambulances.length}
            </span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700 text-xs">
            <Building2 className="w-4 h-4 text-emerald-400" />
            <span className="text-slate-400">Vacant ER Bays:</span>
            <span className="font-mono font-bold text-slate-200">{totalBeds}</span>
          </div>

          <button
            onClick={() => setIsRegistrationOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold shadow-lg shadow-red-600/20 transition"
          >
            <FilePlus2 className="w-4 h-4" />
            <span>New Emergency</span>
          </button>

          <button
            onClick={handleResetSeed}
            title="Reset to fresh Mangaluru demonstration dataset"
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main 3-Column Command Center Workspace */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 p-3 overflow-hidden max-w-[1920px] mx-auto w-full">
        {/* Left Column: Live Incident Feed (3 Columns on large screens) */}
        <section className="lg:col-span-3 flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden max-h-[calc(100vh-80px)]">
          <div className="p-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/80">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-red-500" />
              <h2 className="text-xs font-bold text-slate-200 uppercase tracking-wider">
                Emergency Queue ({filteredIncidents.length})
              </h2>
            </div>

            {/* Filter buttons */}
            <div className="flex gap-1 text-[10px] font-mono">
              <button
                onClick={() => setStatusFilter("ALL")}
                className={`px-2 py-0.5 rounded ${
                  statusFilter === "ALL" ? "bg-blue-600 text-white font-bold" : "text-slate-400 hover:text-white"
                }`}
              >
                All
              </button>
              <button
                onClick={() => setStatusFilter("P1")}
                className={`px-2 py-0.5 rounded ${
                  statusFilter === "P1" ? "bg-red-600 text-white font-bold" : "text-slate-400 hover:text-white"
                }`}
              >
                P1 Red
              </button>
              <button
                onClick={() => setStatusFilter("ACTIVE")}
                className={`px-2 py-0.5 rounded ${
                  statusFilter === "ACTIVE" ? "bg-emerald-600 text-white font-bold" : "text-slate-400 hover:text-white"
                }`}
              >
                Active
              </button>
            </div>
          </div>

          {/* Incident Cards Scrollable List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {filteredIncidents.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500 font-mono">
                No incidents match filter.
              </div>
            ) : (
              filteredIncidents.map((inc) => {
                const isSelected = selectedIncident?.id === inc.id;
                const hasDispatch = dispatches.some((d) => d.incident_id === inc.id);

                return (
                  <div
                    key={inc.id}
                    onClick={() => setSelectedIncident(inc)}
                    className={`p-3 rounded-lg border transition cursor-pointer space-y-2 ${
                      isSelected
                        ? "bg-slate-800/90 border-blue-500 shadow-md"
                        : "bg-slate-950/60 border-slate-800/80 hover:border-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded font-mono ${
                          inc.triage_color === "RED"
                            ? "bg-red-950 text-red-400 border border-red-800"
                            : inc.triage_color === "YELLOW"
                            ? "bg-amber-950 text-amber-400 border border-amber-800"
                            : "bg-emerald-950 text-emerald-400 border border-emerald-800"
                        }`}
                      >
                        {inc.triage_level}
                      </span>
                      <span className="text-[10px] font-mono text-slate-400">
                        Score: {inc.triage_score}/100
                      </span>
                    </div>

                    <div className="text-xs font-semibold text-slate-100 line-clamp-2">
                      {inc.chief_complaint}
                    </div>

                    <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                      <MapPin className="w-3 h-3 text-red-400 shrink-0" />
                      <span className="truncate">{inc.location_address}</span>
                    </div>

                    <div className="flex items-center justify-between pt-1 border-t border-slate-800/80 text-[10px]">
                      <span className="text-slate-400 font-mono">
                        Status: <strong className="text-blue-400">{inc.status}</strong>
                      </span>
                      <span className="text-slate-500 font-mono">Need: {inc.required_ambulance_type}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Center Column: Interactive Leaflet Map (6 Columns on large screens) */}
        <section className="lg:col-span-6 flex flex-col rounded-xl overflow-hidden border border-slate-800 relative min-h-[450px]">
          <DynamicCommandCenterMap
            incidents={incidents}
            ambulances={ambulances}
            hospitals={hospitals}
            activeRouteGeometry={activeRouteGeometry}
            selectedIncident={selectedIncident}
            onSelectIncident={(inc) => setSelectedIncident(inc)}
            center={
              selectedIncident
                ? [selectedIncident.latitude, selectedIncident.longitude]
                : [12.891, 74.856]
            }
            zoom={selectedIncident ? 14 : 13}
          />
        </section>

        {/* Right Column: Incident HUD, Lifecycle Machine & Explainability Inspector (3 Columns) */}
        <section className="lg:col-span-3 flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 overflow-y-auto max-h-[calc(100vh-80px)] p-3 space-y-3">
          {selectedIncident ? (
            <>
              {/* Header Card */}
              <div className="p-3.5 rounded-lg border border-slate-800 bg-slate-950 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-400 uppercase font-mono">
                    Incident #{selectedIncident.id} Inspector
                  </span>
                  <span
                    className={`text-[9px] font-bold px-2 py-0.5 rounded font-mono ${
                      selectedIncident.triage_color === "RED"
                        ? "bg-red-950 text-red-400 border border-red-800"
                        : selectedIncident.triage_color === "YELLOW"
                        ? "bg-amber-950 text-amber-400 border border-amber-800"
                        : "bg-emerald-950 text-emerald-400 border border-emerald-800"
                    }`}
                  >
                    {selectedIncident.triage_level}
                  </span>
                </div>

                <div className="text-xs text-slate-200 font-medium">
                  {selectedIncident.chief_complaint}
                </div>

                <div className="text-[11px] text-slate-400 space-y-1 pt-1 border-t border-slate-800/80">
                  <div className="flex justify-between">
                    <span>Caller:</span>
                    <span className="text-slate-200">{selectedIncident.caller_name} ({selectedIncident.caller_phone})</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Location:</span>
                    <span className="text-slate-300 truncate max-w-[160px]">{selectedIncident.location_address}</span>
                  </div>
                  <div className="flex justify-between font-mono">
                    <span>Patient:</span>
                    <span className="text-slate-200">
                      {selectedIncident.patient_age ? `${selectedIncident.patient_age}y` : "Age N/A"} • {selectedIncident.patient_gender}
                    </span>
                  </div>
                </div>
              </div>

              {/* Triage Decision Justifications Card */}
              <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-bold text-slate-300">
                  <CheckCircle2 className="w-3.5 h-3.5 text-blue-400" />
                  <span>Clinical Decision Rationale</span>
                </div>
                <ul className="space-y-1 text-[10px] text-slate-300">
                  {selectedIncident.triage_justifications?.map((j: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-1.5 leading-snug">
                      <span className="text-blue-400 font-mono mt-0.5">•</span>
                      <span>{j}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Active Dispatch & Dual Confirmation Lifecycle Card */}
              {currentDispatch ? (
                <div className="p-3.5 rounded-lg border border-blue-900/60 bg-blue-950/20 space-y-3">
                  <div className="flex items-center justify-between border-b border-blue-900/50 pb-2">
                    <span className="text-xs font-bold text-blue-300 flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 animate-pulse text-blue-400" />
                      Dispatch Coordination
                    </span>
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold border ${
                        currentDispatch.coordination_status === "CONFIRMED"
                          ? "bg-emerald-950 text-emerald-400 border-emerald-800"
                          : currentDispatch.coordination_status === "PENDING_CONFIRMATIONS"
                          ? "bg-amber-950 text-amber-400 border-amber-800 animate-pulse"
                          : currentDispatch.coordination_status === "REJECTED"
                          ? "bg-red-950 text-red-400 border-red-800"
                          : currentDispatch.coordination_status === "EXPIRED"
                          ? "bg-orange-950 text-orange-400 border-orange-800"
                          : "bg-blue-900/40 text-blue-300 border-blue-800"
                      }`}
                    >
                      {currentDispatch.coordination_status || currentDispatch.status}
                    </span>
                  </div>

                  {/* Vehicle & Hospital Pairing */}
                  <div className="text-[11px] space-y-1 text-slate-300">
                    <div className="flex justify-between">
                      <span className="text-slate-400">Assigned Unit:</span>
                      <strong className="text-blue-400">{assignedAmbulance?.call_sign} ({assignedAmbulance?.vehicle_type})</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-400">Receiving Hospital:</span>
                      <strong className="text-emerald-400">{assignedHospital?.name || "TBD"}</strong>
                    </div>
                    <div className="flex justify-between font-mono text-[10px]">
                      <span className="text-slate-400">Response Distance:</span>
                      <span>{formatDistance(currentDispatch.route_distance_meters || 0)}</span>
                    </div>
                    <div className="flex justify-between font-mono text-[10px]">
                      <span className="text-slate-400">Est. Arrival ETA:</span>
                      <span className="text-emerald-400 font-bold">
                        {formatDuration(currentDispatch.estimated_eta_seconds || 0)}
                      </span>
                    </div>
                    {currentDispatch.attempt_number > 1 && (
                      <div className="flex justify-between font-mono text-[10px] text-amber-400">
                        <span>Dispatch Attempt:</span>
                        <span>#{currentDispatch.attempt_number} (Reassigned)</span>
                      </div>
                    )}
                  </div>

                  {/* Smart Escalation Alert Card */}
                  {currentDispatch.attempt_number > 1 && (
                    <div className="p-2.5 rounded-lg border border-amber-600/40 bg-amber-950/30 space-y-2">
                      <div className="flex items-center justify-between text-xs font-bold text-amber-400">
                        <span className="flex items-center gap-1.5">
                          <AlertTriangle className="w-4 h-4 text-amber-400 animate-pulse" />
                          Smart Escalation Active (Attempt #{currentDispatch.attempt_number})
                        </span>
                        <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-amber-900/50 text-amber-300 border border-amber-700">
                          Auto-Reassigned
                        </span>
                      </div>

                      {/* Escalation Failure Context */}
                      {lastEscalation && (
                        <div className="text-[10px] space-y-1 text-slate-300 bg-slate-950/70 p-2 rounded border border-amber-900/30">
                          <div className="text-amber-300 font-semibold">
                            Trigger: <span className="text-slate-200">{lastEscalation.failure_reason}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-slate-400 font-mono text-[9px] pt-0.5">
                            <span className="line-through text-red-400">{lastEscalation.failed_ambulance_call_sign || "Previous Unit"}</span>
                            <ArrowRight className="w-3 h-3 text-amber-400" />
                            <span className="text-emerald-400 font-bold">{lastEscalation.replacement_ambulance_call_sign || assignedAmbulance?.call_sign}</span>
                          </div>
                        </div>
                      )}

                      <div className="text-[9px] text-amber-200/90 font-mono">
                        {currentDispatch.coordination_status === "PENDING_CONFIRMATIONS"
                          ? "⏳ Awaiting dual confirmation for replacement unit..."
                          : "✓ Replacement unit confirmed and operational"}
                      </div>
                    </div>
                  )}

                  {/* No Alternatives Available Alert Card */}
                  {currentDispatch.coordination_status === "REASSIGNMENT_REQUIRED" && (
                    <div className="p-2.5 rounded-lg border border-red-600/60 bg-red-950/40 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-red-400">
                        <ShieldAlert className="w-4 h-4 text-red-500" />
                        <span>Escalation Alert: No Alternatives Available</span>
                      </div>
                      <p className="text-[10px] text-red-300 leading-snug">
                        All alternative fleet units are currently committed or incompatible with clinical triage needs. Incident preserved in queue for dispatcher manual intervention.
                      </p>
                      <button
                        onClick={() => handleReassignDispatch(currentDispatch.id)}
                        className="w-full py-1.5 px-3 rounded-lg bg-red-700 hover:bg-red-600 text-white text-xs font-bold shadow-md transition flex items-center justify-center gap-1.5"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Retry Fleet Availability Scan</span>
                      </button>
                    </div>
                  )}

                  {/* Dual Confirmation & Resource Reservation Box */}
                  <div className="p-2.5 rounded-lg border border-slate-800 bg-slate-950/80 space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-bold text-slate-200">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-blue-400" />
                        Dual Confirmation Status
                      </span>
                      {currentDispatch.coordination_status === "PENDING_CONFIRMATIONS" && currentDispatch.reservation_expires_at && (
                        <span className="font-mono text-[10px] text-amber-400 bg-amber-950/60 border border-amber-800 px-1.5 py-0.5 rounded">
                          TTL: {Math.max(0, Math.floor((new Date(currentDispatch.reservation_expires_at).getTime() - Date.now()) / 1000))}s
                        </span>
                      )}
                    </div>

                    {/* Ambulance Confirmation Row */}
                    <div className="flex items-center justify-between text-[10px] p-1.5 rounded bg-slate-900 border border-slate-800">
                      <div className="flex items-center gap-1.5">
                        <Ambulance className="w-3.5 h-3.5 text-blue-400" />
                        <span className="text-slate-300">Ambulance Crew:</span>
                      </div>
                      <span
                        className={`font-mono font-bold px-1.5 py-0.5 rounded text-[9px] uppercase ${
                          currentDispatch.ambulance_confirmation_status === "ACCEPTED"
                            ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                            : currentDispatch.ambulance_confirmation_status === "REJECTED"
                            ? "bg-red-950 text-red-400 border border-red-800"
                            : "bg-amber-950 text-amber-400 border border-amber-800"
                        }`}
                      >
                        {currentDispatch.ambulance_confirmation_status}
                      </span>
                    </div>

                    {/* Hospital Confirmation Row */}
                    <div className="flex items-center justify-between text-[10px] p-1.5 rounded bg-slate-900 border border-slate-800">
                      <div className="flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-slate-300">Hospital ER Bay:</span>
                      </div>
                      <span
                        className={`font-mono font-bold px-1.5 py-0.5 rounded text-[9px] uppercase ${
                          currentDispatch.hospital_confirmation_status === "ACCEPTED"
                            ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                            : currentDispatch.hospital_confirmation_status === "REJECTED"
                            ? "bg-red-950 text-red-400 border border-red-800"
                            : "bg-amber-950 text-amber-400 border border-amber-800"
                        }`}
                      >
                        {currentDispatch.hospital_confirmation_status}
                      </span>
                    </div>

                    {/* Demo Field Simulation Buttons (Clearly Labeled) */}
                    {currentDispatch.coordination_status === "PENDING_CONFIRMATIONS" && (
                      <div className="pt-2 border-t border-slate-800/80 space-y-1.5">
                        <div className="text-[9px] uppercase font-mono font-bold text-slate-400 flex items-center justify-between">
                          <span>Simulated Responses</span>
                          <span className="text-amber-400 text-[8px] font-semibold">[Demo Terminals]</span>
                        </div>

                        {/* Ambulance Simulation */}
                        {currentDispatch.ambulance_confirmation_status === "PENDING" && (
                          <div className="grid grid-cols-2 gap-1 text-[10px]">
                            <button
                              onClick={() => handleConfirmAmbulance(currentDispatch.id, "ACCEPTED")}
                              className="px-2 py-1 rounded bg-emerald-700/40 hover:bg-emerald-600/60 border border-emerald-600/50 text-emerald-300 font-semibold transition"
                            >
                              ✓ Amb Accept
                            </button>
                            <button
                              onClick={() => handleConfirmAmbulance(currentDispatch.id, "REJECTED")}
                              className="px-2 py-1 rounded bg-red-900/40 hover:bg-red-800/60 border border-red-700/50 text-red-300 font-semibold transition"
                            >
                              ✕ Amb Reject
                            </button>
                          </div>
                        )}

                        {/* Hospital Simulation */}
                        {currentDispatch.hospital_confirmation_status === "PENDING" && (
                          <div className="grid grid-cols-2 gap-1 text-[10px]">
                            <button
                              onClick={() => handleConfirmHospital(currentDispatch.id, "ACCEPTED")}
                              className="px-2 py-1 rounded bg-emerald-700/40 hover:bg-emerald-600/60 border border-emerald-600/50 text-emerald-300 font-semibold transition"
                            >
                              ✓ Hosp Accept
                            </button>
                            <button
                              onClick={() => handleConfirmHospital(currentDispatch.id, "REJECTED")}
                              className="px-2 py-1 rounded bg-red-900/40 hover:bg-red-800/60 border border-red-700/50 text-red-300 font-semibold transition"
                            >
                              ✕ Hosp Reject
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Reassignment Action Panel for Rejections & Expirations */}
                  {(currentDispatch.coordination_status === "REJECTED" ||
                    currentDispatch.coordination_status === "EXPIRED" ||
                    currentDispatch.coordination_status === "REASSIGNMENT_REQUIRED") && (
                    <div className="p-2.5 rounded-lg border border-red-800/50 bg-red-950/20 space-y-2">
                      <div className="text-[10px] text-red-300">
                        <strong>
                          {currentDispatch.coordination_status === "EXPIRED"
                            ? "Reservation Expired: "
                            : "Dispatch Rejected: "}
                        </strong>
                        {currentDispatch.rejection_reason || "Resource declined assignment"}
                      </div>
                      <button
                        onClick={() => handleReassignDispatch(currentDispatch.id)}
                        className="w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold shadow-md shadow-amber-600/30 transition flex items-center justify-center gap-2"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Reassign to Alternative Resource</span>
                      </button>
                    </div>
                  )}

                  {/* Lifecycle Step Action Button (Active ONLY when CONFIRMED) */}
                  {currentDispatch.coordination_status === "CONFIRMED" && currentDispatch.status !== "COMPLETED" && (
                    <button
                      onClick={() => handleStepLifecycle(currentDispatch.id)}
                      className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-md shadow-blue-600/30 transition flex items-center justify-center gap-2"
                    >
                      <span>
                        Advance Stage:{" "}
                        {currentDispatch.status === "ASSIGNED"
                          ? "Mark En Route"
                          : currentDispatch.status === "EN_ROUTE_INCIDENT"
                          ? "Mark Arrived Scene"
                          : currentDispatch.status === "ON_SCENE"
                          ? "Start Transport"
                          : "Complete Handover"}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                /* Unassigned: Open Allocation Engine Button */
                <div className="p-4 rounded-lg border border-slate-800 bg-slate-950 space-y-3 text-center">
                  <div className="text-xs text-slate-300">
                    No ambulance dispatched yet for this incident.
                  </div>
                  <button
                    onClick={() => setIsAllocationOpen(true)}
                    className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold shadow-lg shadow-blue-600/30 transition flex items-center justify-center gap-2"
                  >
                    <Sliders className="w-4 h-4" />
                    <span>Run Intelligent Allocation</span>
                  </button>
                </div>
              )}

              {/* Multi-Factor Allocation Explainability Snapshot */}
              {recommendations && (
                <div className="p-3 rounded-lg border border-slate-800 bg-slate-950/70 space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-300">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                      Top Recommended Unit
                    </span>
                    <span className="font-mono text-blue-400 text-[11px]">
                      {recommendations.ambulance_allocation?.recommended_ambulance?.call_sign}
                    </span>
                  </div>

                  {recommendations.ambulance_allocation?.recommended_ambulance && (
                    <div className="space-y-1.5 text-[10px] text-slate-300">
                      <div className="flex justify-between font-mono">
                        <span className="text-slate-400">Total Match Score:</span>
                        <span className="font-bold text-emerald-400">
                          {recommendations.ambulance_allocation.recommended_ambulance.total_score} / 100
                        </span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-slate-400">Estimated Drive ETA:</span>
                        <span>{recommendations.ambulance_allocation.recommended_ambulance.eta_minutes} mins</span>
                      </div>
                      <ul className="text-slate-400 space-y-0.5 pt-1 border-t border-slate-800/80">
                        {recommendations.ambulance_allocation.recommended_ambulance.match_reasons?.slice(0, 2).map((r: string, idx: number) => (
                          <li key={idx} className="truncate">• {r}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {!currentDispatch && (
                    <button
                      onClick={() => setIsAllocationOpen(true)}
                      className="w-full text-center text-[10px] text-blue-400 hover:underline pt-1 block"
                    >
                      View Full Multi-Factor Breakdown & Excluded Units →
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="p-6 text-center text-xs text-slate-500 font-mono">
              Select an incident from queue or map to inspect details.
            </div>
          )}
        </section>
      </main>

      {/* Emergency Registration Modal */}
      <IncidentRegistrationModal
        isOpen={isRegistrationOpen}
        onClose={() => setIsRegistrationOpen(false)}
        onIncidentCreated={(created) => {
          fetchData();
          setSelectedIncident(created);
          // Automatically prompt allocation for the newly registered incident
          setTimeout(() => setIsAllocationOpen(true), 300);
        }}
      />

      {/* Intelligent Allocation & Dispatch Modal */}
      <AllocationModal
        isOpen={isAllocationOpen}
        onClose={() => setIsAllocationOpen(false)}
        incident={selectedIncident}
        recommendations={recommendations}
        onDispatchConfirmed={(dispatch) => {
          fetchData();
        }}
      />
    </div>
  );
}
