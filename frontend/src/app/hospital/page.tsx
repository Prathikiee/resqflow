"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Ambulance,
  CheckCircle2,
  Clock,
  Radio,
  RefreshCw,
  LogOut,
  Building2,
  Bed,
  Check,
  X,
  Plus,
  Minus,
  Sparkles,
  ShieldAlert,
  UserCheck,
  Stethoscope,
  Users,
  Eye,
  FileText,
} from "lucide-react";

interface DispatchRecord {
  id: number;
  incident_id: number;
  ambulance_id: number;
  ambulance_call_sign: string;
  destination_hospital_name: string;
  destination_hospital_id: number;
  coordination_status: string;
  ambulance_confirmation_status: string;
  hospital_confirmation_status: string;
  status: string;
  attempt_number: number;
  reservation_expires_at?: string;
  estimated_eta_seconds?: number;
  route_distance_meters?: number;
  incident?: {
    id: number;
    caller_name: string;
    caller_phone: string;
    location_address: string;
    chief_complaint: string;
    triage_level: string;
    triage_color: string;
    status: string;
    required_ambulance_type?: string;
  };
  handover_packet?: any;
}

export default function HospitalPortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [hospital, setHospital] = useState<any>(null);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

  // SBAR Handover modal & clinician input
  const [activeHandoverPacket, setActiveHandoverPacket] = useState<any | null>(null);
  const [clinicianName, setClinicianName] = useState("");

  // Reservation countdown state
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  const isActionInProgressRef = useRef(false);
  const processedEventsRef = useRef<Set<string>>(new Set());
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const fetchHospitalData = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) {
      router.push("/login");
      return;
    }

    try {
      // 1. Verify user profile & assigned facility
      const meResp = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) throw new Error("Invalid session");
      const userData = await meResp.json();
      setUser(userData);
      if (!clinicianName) setClinicianName(userData.full_name || "ER Triage Officer");

      // 2. Fetch assigned hospital facility profile & live bed counts
      if (userData.hospital_id) {
        const hospResp = await fetch(`${backendUrl}/api/hospitals/${userData.hospital_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (hospResp.ok) {
          setHospital(await hospResp.json());
        }
      }

      // 3. Fetch hospital's incoming & historical dispatches
      const dispResp = await fetch(`${backendUrl}/api/dispatch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (dispResp.ok) {
        const allDispatches: DispatchRecord[] = await dispResp.json();
        // Filter strictly to this facility
        const myFacilityDispatches = allDispatches.filter(
          (d) => d.destination_hospital_id === userData.hospital_id
        );
        setDispatches(myFacilityDispatches);
      }
    } catch (err: any) {
      console.warn("Hospital data fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router, clinicianName]);

  // Connect WebSocket with JWT & targeted facility delivery
  useEffect(() => {
    fetchHospitalData();

    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) return;

    const wsUrl = backendUrl.replace(/^http/, "ws") + `/ws/live?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    function connect() {
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => setWsConnected(true);
        ws.onclose = () => {
          setWsConnected(false);
          reconnectTimeout = setTimeout(connect, 3000);
        };
        ws.onerror = () => ws?.close();
        ws.onmessage = (evt) => {
          try {
            const data = JSON.parse(evt.data);
            if (data.event_id) {
              if (processedEventsRef.current.has(data.event_id)) return;
              processedEventsRef.current.add(data.event_id);
            }

            if (data.event === "DISPATCH_PROVISIONAL_RESERVATION") {
              setFeedbackMsg({ text: "URGENT: Inbound patient bed reservation request received!", type: "info" });
              fetchHospitalData();
            } else if (data.event === "HOSPITAL_CAPACITY_UPDATED") {
              setFeedbackMsg({ text: "Hospital capacity updated & synchronized across regional network.", type: "info" });
              fetchHospitalData();
            } else if (
              data.event === "DISPATCH_CONFIRMATION_UPDATED" ||
              data.event === "DISPATCH_CONFIRMED" ||
              data.event === "DISPATCH_LIFECYCLE_STEPPED" ||
              data.event === "DISPATCH_ESCALATED" ||
              data.event === "DISPATCH_EXPIRED"
            ) {
              fetchHospitalData();
            }
          } catch (_) {}
        };
      } catch (_) {}
    }

    connect();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [backendUrl, fetchHospitalData]);

  // Active incoming requests
  const pendingDispatch = dispatches.find(
    (d) => d.coordination_status === "PENDING_CONFIRMATIONS" && d.hospital_confirmation_status === "PENDING"
  );

  const activeInboundDispatches = dispatches.filter(
    (d) => d.coordination_status === "CONFIRMED" && d.status !== "COMPLETED" && d.status !== "CANCELLED"
  );

  const completedDispatches = dispatches.filter((d) => d.status === "COMPLETED");

  // Reservation countdown timer
  useEffect(() => {
    if (!pendingDispatch?.reservation_expires_at) {
      setRemainingSeconds(null);
      return;
    }

    const updateTimer = () => {
      const expMs = new Date(pendingDispatch.reservation_expires_at!).getTime();
      const nowMs = Date.now();
      const diffSec = Math.max(0, Math.floor((expMs - nowMs) / 1000));
      setRemainingSeconds(diffSec);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [pendingDispatch]);

  // Handle Accept or Reject Incoming Case
  const handleDecideReservation = async (dispatchId: number, decision: "ACCEPTED" | "REJECTED") => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm-hospital`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision,
          rejection_reason: decision === "REJECTED" ? "Emergency Department Divert / Capacity Exhausted" : undefined,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `Failed to record decision (${resp.status})`);
      }

      setFeedbackMsg({
        text: `Hospital bed reservation #${dispatchId} successfully ${decision.toLowerCase()}!`,
        type: decision === "ACCEPTED" ? "success" : "info",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Bed confirmation error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  // AVAILABILITY MANAGEMENT: Update Readiness (Ready / Busy / Divert)
  const handleSetReadiness = async (readiness: "READY" | "BUSY" | "DIVERT") => {
    if (!hospital?.id) return;
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/capacity`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          readiness_status: readiness,
          accepting_emergencies: readiness !== "DIVERT",
          updated_by_name: user?.full_name || clinicianName,
        }),
      });

      if (resp.ok) {
        setHospital(await resp.json());
        setFeedbackMsg({
          text: `Facility operational readiness updated to ${readiness}. Persisted to database.`,
          type: readiness === "READY" ? "success" : "info",
        });
      }
    } catch (_) {}
  };

  // AVAILABILITY MANAGEMENT: Adjust Bed Counters
  const handleAdjustBeds = async (type: "emergency" | "icu" | "ward", delta: number) => {
    if (!hospital?.id) return;
    const token = localStorage.getItem("lifelink_token");

    const payload: any = { updated_by_name: user?.full_name || clinicianName };
    if (type === "emergency") {
      payload.available_emergency_beds = Math.max(0, (hospital.available_emergency_beds || 0) + delta);
    } else if (type === "icu") {
      payload.available_icu_beds = Math.max(0, (hospital.available_icu_beds || 0) + delta);
    } else if (type === "ward") {
      payload.available_ward_beds = Math.max(0, (hospital.available_ward_beds || 0) + delta);
    }

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/capacity`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (resp.ok) {
        setHospital(await resp.json());
        setFeedbackMsg({ text: `Updated ${type} bed availability. Persisted to database.`, type: "success" });
      }
    } catch (_) {}
  };

  // AVAILABILITY MANAGEMENT: Toggle Doctor Availability Status
  const handleToggleDoctorStatus = async (doctorIndex: number) => {
    if (!hospital?.id || !hospital.doctors_availability) return;
    const token = localStorage.getItem("lifelink_token");

    const updatedDoctors = [...hospital.doctors_availability];
    const currentStatus = updatedDoctors[doctorIndex].status;
    updatedDoctors[doctorIndex].status = currentStatus === "AVAILABLE" ? "BUSY_IN_PROCEDURE" : "AVAILABLE";

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/capacity`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          doctors_availability: updatedDoctors,
          updated_by_name: user?.full_name || clinicianName,
        }),
      });

      if (resp.ok) {
        setHospital(await resp.json());
        setFeedbackMsg({
          text: `Updated on-shift doctor status for ${updatedDoctors[doctorIndex].name}.`,
          type: "success",
        });
      }
    } catch (_) {}
  };

  // Inspect SBAR Handover Packet
  const handleInspectHandover = async (dispatchId: number) => {
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/handover`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        setActiveHandoverPacket(await resp.json());
      }
    } catch (_) {}
  };

  // Clinician Formal Sign-Off on SBAR Handover
  const handleAcknowledgeHandover = async () => {
    if (!activeHandoverPacket?.dispatch_id) return;
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${activeHandoverPacket.dispatch_id}/handover/acknowledge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ acknowledged_by: clinicianName }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to acknowledge handover");
      }

      const updated = await resp.json();
      setActiveHandoverPacket(updated);
      setFeedbackMsg({
        text: `Clinical handover for Dispatch #${activeHandoverPacket.dispatch_id} acknowledged by ${clinicianName}!`,
        type: "success",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Acknowledgment error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("lifelink_token");
    localStorage.removeItem("lifelink_user");
    document.cookie = "lifelink_token=; path=/; max-age=0;";
    router.push("/login");
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3 text-slate-700">
          <RefreshCw className="w-8 h-8 animate-spin text-emerald-600" />
          <span className="text-sm font-semibold">Loading Hospital ER Intake Console...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* ============================================================== */}
      {/* HEADER                                                         */}
      {/* ============================================================== */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 sm:px-6 sticky top-0 z-40 shadow-2xs">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-600/20">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-black text-lg tracking-tight text-slate-900">
                  {hospital?.name || "Hospital Emergency Dept"}
                </h1>
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
                  {hospital?.facility_code || "HOSP-ER"}
                </span>
              </div>
              <span className="text-xs text-slate-500 block">
                Emergency Intake & Live Bed Availability Management
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-bold border ${
                wsConnected
                  ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                  : "bg-amber-50 text-amber-800 border-amber-200 animate-pulse"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-emerald-500 animate-ping" : "bg-amber-500"}`} />
              <span>{wsConnected ? "Network Online" : "Reconnecting..."}</span>
            </div>

            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Feedback Alert */}
        {feedbackMsg && (
          <div
            className={`p-3.5 rounded-xl border text-xs font-medium flex items-center justify-between ${
              feedbackMsg.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : feedbackMsg.type === "error"
                ? "bg-red-50 border-red-200 text-red-800"
                : "bg-blue-50 border-blue-200 text-blue-800"
            }`}
          >
            <span>{feedbackMsg.text}</span>
            <button onClick={() => setFeedbackMsg(null)} className="font-bold ml-2">✕</button>
          </div>
        )}

        {/* ============================================================== */}
        {/* 1. COMPACT AVAILABILITY-MANAGEMENT SECTION                     */}
        {/* ============================================================== */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono uppercase tracking-wider font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                  DEMO DATA
                </span>
                <h2 className="text-sm font-black text-slate-900 uppercase tracking-wide">
                  Operational Facility Availability & Readiness
                </h2>
              </div>
              <span className="text-[11px] text-slate-500">
                Hospital staff directly manage capacity. Live updates are persisted in database and read by allocation engine.
              </span>
            </div>

            <div className="text-left sm:text-right text-[11px] text-slate-400 font-mono">
              <span>Last updated: </span>
              <strong className="text-slate-700">
                {hospital?.last_updated ? new Date(hospital.last_updated).toLocaleTimeString() : "Just now"}
              </strong>
              <span> by </span>
              <strong className="text-slate-700">{hospital?.last_updated_by || clinicianName}</strong>
            </div>
          </div>

          {/* READINESS SELECTOR: READY / BUSY / DIVERT */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              {
                id: "READY",
                label: "Ready",
                desc: "Normal emergency intake. Fully operational.",
                activeColor: "bg-emerald-600 text-white border-emerald-600 shadow-md",
                idleColor: "bg-slate-50 text-slate-700 hover:bg-emerald-50/50 border-slate-200",
              },
              {
                id: "BUSY",
                label: "Busy",
                desc: "High volume. Extended triage wait times.",
                activeColor: "bg-amber-600 text-white border-amber-600 shadow-md",
                idleColor: "bg-slate-50 text-slate-700 hover:bg-amber-50/50 border-slate-200",
              },
              {
                id: "DIVERT",
                label: "Divert",
                desc: "Facility closed to incoming non-critical ambulances.",
                activeColor: "bg-rose-600 text-white border-rose-600 shadow-md",
                idleColor: "bg-slate-50 text-slate-700 hover:bg-rose-50/50 border-slate-200",
              },
            ].map((st) => {
              const isSelected = (hospital?.readiness_status || "READY") === st.id;
              return (
                <button
                  key={st.id}
                  onClick={() => handleSetReadiness(st.id as any)}
                  className={`p-3.5 rounded-xl border text-left transition flex flex-col justify-between ${
                    isSelected ? st.activeColor : st.idleColor
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-black text-sm uppercase tracking-wide">{st.label}</span>
                    {isSelected && <Check className="w-4 h-4" />}
                  </div>
                  <span className={`text-[11px] mt-1 ${isSelected ? "text-white/90" : "text-slate-500"}`}>
                    {st.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {/* BED CAPACITY COUNTERS (EMERGENCY, ICU, WARD, RESERVED) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* Emergency Beds */}
            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold block">
                  Available ER Bays
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-2xl font-black font-mono text-slate-900">
                    {hospital?.available_emergency_beds ?? 0}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">
                    / {hospital?.total_emergency_beds ?? 35}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 mt-2">
                <button
                  onClick={() => handleAdjustBeds("emergency", -1)}
                  className="w-7 h-7 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition"
                  title="Decrease available ER bed"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <button
                  onClick={() => handleAdjustBeds("emergency", 1)}
                  className="w-7 h-7 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition"
                  title="Increase available ER bed"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* ICU Beds */}
            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold block">
                  Available ICU Beds
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-2xl font-black font-mono text-purple-900">
                    {hospital?.available_icu_beds ?? 0}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">
                    / {hospital?.total_icu_beds ?? 22}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 mt-2">
                <button
                  onClick={() => handleAdjustBeds("icu", -1)}
                  className="w-7 h-7 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition"
                  title="Decrease available ICU bed"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <button
                  onClick={() => handleAdjustBeds("icu", 1)}
                  className="w-7 h-7 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition"
                  title="Increase available ICU bed"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Ward Beds */}
            <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 font-bold block">
                  Available Ward Beds
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-2xl font-black font-mono text-blue-900">
                    {hospital?.available_ward_beds ?? 0}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">
                    / {hospital?.total_ward_beds ?? 60}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1.5 mt-2">
                <button
                  onClick={() => handleAdjustBeds("ward", -1)}
                  className="w-7 h-7 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition"
                  title="Decrease available ward bed"
                >
                  <Minus className="w-3 h-3" />
                </button>
                <button
                  onClick={() => handleAdjustBeds("ward", 1)}
                  className="w-7 h-7 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition"
                  title="Increase available ward bed"
                >
                  <Plus className="w-3 h-3" />
                </button>
              </div>
            </div>

            {/* Reserved / Locked Bays */}
            <div className="p-3.5 bg-blue-50/60 rounded-xl border border-blue-200 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-mono uppercase tracking-wider text-blue-700 font-bold block">
                  Reserved / En Route
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className="text-2xl font-black font-mono text-blue-900">
                    {hospital?.reserved_emergency_beds ?? 0}
                  </span>
                  <span className="text-xs text-blue-600 font-semibold">bays locked</span>
                </div>
              </div>
              <span className="text-[10px] text-blue-600 mt-2 block">
                Held during provisional mission & active transit.
              </span>
            </div>
          </div>

          {/* DOCTORS AVAILABILITY BY SPECIALTY & CURRENT SHIFT */}
          <div className="space-y-2 pt-1">
            <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block">
              On-Shift Doctors & Clinical Specialists (Simulated Demo Availability)
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {(hospital?.doctors_availability || []).map((doc: any, idx: number) => {
                const isAvail = doc.status === "AVAILABLE";
                return (
                  <div
                    key={idx}
                    className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs"
                  >
                    <div className="space-y-0.5">
                      <span className="font-bold text-slate-900 block">{doc.name}</span>
                      <span className="text-[11px] text-slate-500 block">
                        {doc.specialty} • {doc.shift}
                      </span>
                    </div>

                    <button
                      onClick={() => handleToggleDoctorStatus(idx)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider transition ${
                        isAvail
                          ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                          : "bg-amber-100 text-amber-800 hover:bg-amber-200"
                      }`}
                    >
                      {isAvail ? "Available" : "In Procedure"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ============================================================== */}
        {/* 2. INCOMING PROVISIONAL RESERVATION (90s TTL)                  */}
        {/* ============================================================== */}
        {pendingDispatch && (
          <div className="bg-amber-500/10 border-2 border-amber-500 rounded-2xl p-6 shadow-md space-y-4 animate-pulse-slow">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-amber-500 text-white flex items-center justify-center shadow-md">
                  <AlertTriangle className="w-6 h-6 animate-bounce" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-900">
                      DISPATCH #{pendingDispatch.id} • ATTEMPT #{pendingDispatch.attempt_number}
                    </span>
                    <span className="text-xs font-bold text-amber-800 uppercase tracking-wide">
                      Provisional Bed Reservation Request
                    </span>
                  </div>
                  <h2 className="text-lg font-black text-slate-900 mt-1">
                    Incoming Inbound Unit: {pendingDispatch.ambulance_call_sign}
                  </h2>
                </div>
              </div>

              {/* Countdown Pill */}
              <div className="text-right">
                <span className="text-[11px] font-mono text-slate-500 block">Confirmation TTL Window</span>
                <div className="flex items-center gap-1.5 text-2xl font-black font-mono text-amber-900">
                  <Clock className="w-6 h-6 text-amber-600 animate-spin" />
                  <span>{remainingSeconds !== null ? `${remainingSeconds}s` : "90s"}</span>
                </div>
              </div>
            </div>

            {/* Mission Details Preview */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 p-4 rounded-xl bg-white border border-amber-200 text-xs font-mono">
              <div>
                <span className="text-slate-400 block text-[10px]">Chief Complaint:</span>
                <strong className="text-slate-900 text-xs">
                  {pendingDispatch.incident?.chief_complaint || "Emergency Patient Intake"}
                </strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Triage Priority:</span>
                <strong className="text-red-700">
                  {pendingDispatch.incident?.triage_level || "P1 Critical"}
                </strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Required Care Tier:</span>
                <strong className="text-blue-700">
                  {pendingDispatch.incident?.required_ambulance_type || "ALS (Trauma/Cardiac)"}
                </strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Estimated Arrival:</span>
                <strong className="text-slate-800">
                  {pendingDispatch.estimated_eta_seconds
                    ? `~${Math.ceil(pendingDispatch.estimated_eta_seconds / 60)} mins`
                    : "Calculating..."}
                </strong>
              </div>
            </div>

            {/* Accept / Reject Buttons */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => handleDecideReservation(pendingDispatch.id, "REJECTED")}
                disabled={actionLoading}
                className="px-5 py-2.5 rounded-xl bg-white hover:bg-red-50 text-red-700 border border-red-300 font-bold text-xs transition flex items-center gap-1.5 cursor-pointer"
              >
                <X className="w-4 h-4 text-red-600" />
                <span>Decline Intake (Divert to Alternative)</span>
              </button>

              <button
                onClick={() => handleDecideReservation(pendingDispatch.id, "ACCEPTED")}
                disabled={actionLoading}
                className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-md transition flex items-center gap-1.5 cursor-pointer transform active:scale-95"
              >
                <Check className="w-4 h-4" />
                <span>Confirm Bed & Accept Patient</span>
              </button>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 3. INBOUND EMERGENCY AMBULANCE QUEUE                           */}
        {/* ============================================================== */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Ambulance className="w-5 h-5 text-emerald-600" />
              <h2 className="text-base font-black text-slate-900">
                Inbound Active Emergency Ambulance Queue
              </h2>
            </div>
            <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
              {activeInboundDispatches.length} active
            </span>
          </div>

          {activeInboundDispatches.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
              No active ambulances currently en route to this facility.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {activeInboundDispatches.map((disp) => {
                return (
                  <div key={disp.id} className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-900">
                          {disp.ambulance_call_sign}
                        </span>
                        <span className="text-xs font-bold text-slate-800">
                          {disp.incident?.chief_complaint || "Emergency Patient"}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 font-mono">
                        <span>Status: <strong className="text-blue-700">{disp.status.replace(/_/g, " ")}</strong></span>
                        {disp.estimated_eta_seconds && (
                          <span>ETA: <strong className="text-amber-700">~{Math.ceil(disp.estimated_eta_seconds / 60)} mins</strong></span>
                        )}
                        <span>Triage: <strong className="text-red-700">{disp.incident?.triage_level}</strong></span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleInspectHandover(disp.id)}
                        className="px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer"
                      >
                        <FileText className="w-3.5 h-3.5 text-blue-600" />
                        <span>Inspect Digital SBAR Handover</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ============================================================== */}
        {/* SBAR HANDOVER PACKET INSPECTION & ACKNOWLEDGMENT MODAL        */}
        {/* ============================================================== */}
        {activeHandoverPacket && (
          <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white border border-slate-200 rounded-3xl max-w-2xl w-full p-6 shadow-2xl space-y-5 animate-fade-in max-h-[90vh] overflow-y-auto">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <Stethoscope className="w-5 h-5 text-emerald-600" />
                  <h3 className="font-black text-slate-900 text-base">
                    Pre-Arrival Digital SBAR Clinical Handover
                  </h3>
                </div>
                <button
                  onClick={() => setActiveHandoverPacket(null)}
                  className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center font-bold text-slate-600"
                >
                  ✕
                </button>
              </div>

              {/* SBAR Content Sections */}
              <div className="space-y-3 text-xs">
                {/* Situation */}
                <div className="p-3 bg-red-50/60 rounded-xl border border-red-200 space-y-1">
                  <span className="font-bold text-red-900 uppercase tracking-wider text-[10px] block">
                    S — Situation
                  </span>
                  <p className="text-slate-800 leading-relaxed">{activeHandoverPacket.situation_summary}</p>
                </div>

                {/* Background */}
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                  <span className="font-bold text-slate-700 uppercase tracking-wider text-[10px] block">
                    B — Background & Vitals
                  </span>
                  <p className="text-slate-800 leading-relaxed">{activeHandoverPacket.background_summary}</p>
                </div>

                {/* Assessment */}
                <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200 space-y-1">
                  <span className="font-bold text-amber-900 uppercase tracking-wider text-[10px] block">
                    A — Clinical Assessment
                  </span>
                  <p className="text-slate-800 leading-relaxed">{activeHandoverPacket.assessment_summary}</p>
                </div>

                {/* Recommendation */}
                <div className="p-3 bg-blue-50/60 rounded-xl border border-blue-200 space-y-1">
                  <span className="font-bold text-blue-900 uppercase tracking-wider text-[10px] block">
                    R — Recommendation & Resuscitation Directives
                  </span>
                  <p className="text-slate-800 leading-relaxed">{activeHandoverPacket.recommendation_summary}</p>
                </div>
              </div>

              {/* Clinician Sign-Off */}
              <div className="pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500 font-medium">Physician:</label>
                  <input
                    type="text"
                    value={clinicianName}
                    onChange={(e) => setClinicianName(e.target.value)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-300 rounded-lg text-xs font-bold text-slate-800"
                    placeholder="Enter clinician name"
                  />
                </div>

                <div className="flex items-center gap-2">
                  {activeHandoverPacket.status === "ACKNOWLEDGED" ? (
                    <span className="px-3 py-1.5 rounded-lg bg-emerald-100 text-emerald-800 text-xs font-bold flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>Acknowledged by {activeHandoverPacket.acknowledged_by}</span>
                    </span>
                  ) : (
                    <button
                      onClick={handleAcknowledgeHandover}
                      disabled={actionLoading}
                      className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition flex items-center gap-1.5 cursor-pointer"
                    >
                      <UserCheck className="w-4 h-4" />
                      <span>Clinician Sign-Off & Acknowledge</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
