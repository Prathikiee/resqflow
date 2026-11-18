"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Ambulance,
  Bed,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  Minus,
  Plus,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  User,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import Sidebar, { NavItem } from "@/components/layout/Sidebar";
import TopNav from "@/components/layout/TopNav";
import { formatDistance, formatDuration } from "@/lib/utils";

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
  const [currentNav, setCurrentNav] = useState<string>("overview");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
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
      const meResp = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) throw new Error("Invalid session");
      const userData = await meResp.json();
      setUser(userData);
      if (!clinicianName) setClinicianName(userData.full_name || "ER Triage Officer");

      if (userData.hospital_id) {
        const hospResp = await fetch(`${backendUrl}/api/hospitals/${userData.hospital_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (hospResp.ok) {
          setHospital(await hospResp.json());
        }
      }

      const dispResp = await fetch(`${backendUrl}/api/dispatch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (dispResp.ok) {
        const allDispatches: DispatchRecord[] = await dispResp.json();
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

  // WebSocket Subscription
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

  const sidebarNavItems: NavItem[] = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "availability", label: "Availability Management", icon: Bed },
    { id: "cases", label: "Incoming Cases", icon: Ambulance, count: activeInboundDispatches.length },
    { id: "history", label: "Handover History", icon: History, count: completedDispatches.length },
    { id: "profile", label: "Hospital Profile", icon: Building2 },
  ];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-emerald-600" />
          <span className="text-xs font-bold text-slate-700">Connecting to Hospital ER Console...</span>
        </div>
      </div>
    );
  }

  const currentReadiness = hospital?.readiness_status || "READY";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex font-sans">
      {/* 1. LEFT SIDEBAR */}
      <Sidebar
        role="HOSPITAL"
        roleLabel="Hospital ER Staff"
        user={user}
        currentNav={currentNav}
        onNavChange={setCurrentNav}
        navItems={sidebarNavItems}
        isOpenMobile={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
        onLogout={handleLogout}
        entityName={hospital?.name || "KMC Hospital Ambedkar Circle"}
      />

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0">
        {/* Top Minimal Navigation */}
        <TopNav
          title={hospital?.name || "Hospital ER Console"}
          subtitle={`Facility Code: ${hospital?.facility_code || "HOSP-MNG-001"} • ${hospital?.address || "Mangaluru"}`}
          wsConnected={wsConnected}
          onMenuToggle={() => setIsMobileMenuOpen(true)}
          actions={
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-slate-500 hidden sm:inline">Readiness:</span>
              <span
                className={`text-xs font-bold px-2 py-0.5 rounded uppercase border ${
                  currentReadiness === "READY"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                    : currentReadiness === "BUSY"
                    ? "bg-amber-50 text-amber-700 border-amber-300"
                    : "bg-red-50 text-red-700 border-red-300"
                }`}
              >
                {currentReadiness}
              </span>
            </div>
          }
        />

        {/* Feedback message banner */}
        {feedbackMsg && (
          <div
            className={`px-4 py-2 text-xs font-semibold flex items-center justify-between border-b ${
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

        {/* MAIN BODY WORKSPACE */}
        <main className="flex-1 p-4 sm:p-6 overflow-x-hidden space-y-6">
          {/* ============================================================== */}
          {/* URGENT: PROVISIONAL BED RESERVATION REQUEST WITH 90s COUNTDOWN */}
          {/* ============================================================== */}
          {pendingDispatch && (
            <div className="bg-amber-50/70 border-2 border-amber-400 rounded-xl p-5 shadow-sm space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-amber-500 text-white flex items-center justify-center shadow-xs">
                    <AlertTriangle className="w-5 h-5 animate-pulse" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-200 text-amber-900">
                        DISPATCH #{pendingDispatch.id} • INCIDENT #{pendingDispatch.incident_id}
                      </span>
                      <span className="text-xs font-bold text-amber-900 uppercase">
                        Provisional Bed Reservation Request
                      </span>
                    </div>
                    <h2 className="text-base font-bold text-slate-900 mt-0.5">
                      Incoming Patient Routed to {hospital?.name}
                    </h2>
                  </div>
                </div>

                {/* 90s Countdown */}
                {remainingSeconds !== null && (
                  <div className="text-right">
                    <span className="text-[10px] font-mono text-slate-500 block uppercase">Dual Confirmation TTL</span>
                    <span className="text-xl font-black font-mono text-amber-900">
                      {remainingSeconds}s remaining
                    </span>
                  </div>
                )}
              </div>

              {/* Case Details */}
              <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-900">Chief Medical Complaint:</span>
                  <span className="font-mono text-slate-500">Ambulance: {pendingDispatch.ambulance_call_sign}</span>
                </div>
                <p className="text-sm font-semibold text-slate-900 bg-slate-50 p-2.5 rounded border border-slate-200">
                  {pendingDispatch.incident?.chief_complaint || "Emergency medical case requiring rapid ER triage and bed reservation"}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-600 pt-1">
                  <div>
                    Caller / Patient: <strong>{pendingDispatch.incident?.caller_name}</strong> ({pendingDispatch.incident?.caller_phone})
                  </div>
                  <div>
                    Scene Pickup: <strong>{pendingDispatch.incident?.location_address}</strong>
                  </div>
                </div>
              </div>

              {/* Accept & Divert Buttons */}
              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => handleDecideReservation(pendingDispatch.id, "REJECTED")}
                  disabled={actionLoading}
                  className="px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition"
                >
                  Divert Intake
                </button>
                <button
                  type="button"
                  onClick={() => handleDecideReservation(pendingDispatch.id, "ACCEPTED")}
                  disabled={actionLoading}
                  className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>Accept Inbound Patient</span>
                </button>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* SECTION 1: HOSPITAL READINESS & AVAILABILITY MANAGEMENT         */}
          {/* ============================================================== */}
          {(currentNav === "overview" || currentNav === "availability") && (
            <div className="space-y-4">
              {/* Readiness Selector Card */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                    Emergency Department Operational Readiness
                  </h3>
                  <p className="text-xs text-slate-500">
                    Controls facility status in the regional auto-allocation engine.
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleSetReadiness("READY")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                      currentReadiness === "READY"
                        ? "bg-emerald-600 text-white border-emerald-600 shadow-xs"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    READY
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetReadiness("BUSY")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                      currentReadiness === "BUSY"
                        ? "bg-amber-500 text-white border-amber-500 shadow-xs"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    BUSY
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSetReadiness("DIVERT")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                      currentReadiness === "DIVERT"
                        ? "bg-red-600 text-white border-red-600 shadow-xs"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    DIVERT
                  </button>
                </div>
              </div>

              {/* Bed Counters Management (Emergency, ICU, Ward) */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Emergency Beds */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                      <Bed className="w-4 h-4 text-emerald-600" />
                      Emergency Bay Beds
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      Total: {hospital?.total_emergency_beds || 30}
                    </span>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div>
                      <span className="text-[10px] text-slate-500 font-medium">Available</span>
                      <p className="text-2xl font-black text-emerald-700 font-mono">
                        {hospital?.available_emergency_beds ?? 0}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleAdjustBeds("emergency", -1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center font-bold text-slate-700 transition"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAdjustBeds("emergency", 1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center font-bold text-slate-700 transition"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* ICU Beds */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                      <Activity className="w-4 h-4 text-blue-600" />
                      ICU Critical Beds
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      Total: {hospital?.total_icu_beds || 20}
                    </span>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div>
                      <span className="text-[10px] text-slate-500 font-medium">Available</span>
                      <p className="text-2xl font-black text-blue-700 font-mono">
                        {hospital?.available_icu_beds ?? 0}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleAdjustBeds("icu", -1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center font-bold text-slate-700 transition"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAdjustBeds("icu", 1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center font-bold text-slate-700 transition"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Ward Beds */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                      <Building2 className="w-4 h-4 text-slate-600" />
                      Inpatient Ward Beds
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      Total: {hospital?.total_ward_beds || 50}
                    </span>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50 border border-slate-200">
                    <div>
                      <span className="text-[10px] text-slate-500 font-medium">Available</span>
                      <p className="text-2xl font-black text-slate-800 font-mono">
                        {hospital?.available_ward_beds ?? 18}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleAdjustBeds("ward", -1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center font-bold text-slate-700 transition"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAdjustBeds("ward", 1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center font-bold text-slate-700 transition"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* On-Shift Doctor Availability Section */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                      <Stethoscope className="w-4 h-4 text-blue-600" />
                      On-Shift Doctor Availability
                    </h3>
                    <p className="text-xs text-slate-500">
                      Toggling status directly impacts multi-factor suitability scoring in dispatch auto-allocation.
                    </p>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400">
                    Last updated by: {hospital?.last_updated_by || "System Seed (DEMO DATA)"}
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {hospital?.doctors_availability && hospital.doctors_availability.length > 0 ? (
                    hospital.doctors_availability.map((doc: any, idx: number) => {
                      const isAvailable = doc.status === "AVAILABLE";
                      return (
                        <div
                          key={doc.name || idx}
                          className="p-3 rounded-lg border border-slate-200 bg-slate-50 flex flex-col justify-between space-y-2 text-xs"
                        >
                          <div>
                            <p className="font-bold text-slate-900">{doc.name}</p>
                            <p className="text-blue-700 font-medium text-[11px]">{doc.specialty}</p>
                            <p className="text-slate-500 text-[10px]">Shift: {doc.shift}</p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleToggleDoctorStatus(idx)}
                            className={`w-full py-1.5 rounded text-xs font-bold transition border ${
                              isAvailable
                                ? "bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100"
                                : "bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100"
                            }`}
                          >
                            {isAvailable ? "✓ AVAILABLE" : "⏱ BUSY IN PROCEDURE"}
                          </button>
                        </div>
                      );
                    })
                  ) : (
                    <div className="col-span-full text-center text-xs text-slate-400 p-4">
                      No on-shift roster configured for this facility.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* SECTION 2: INCOMING CASES / INBOUND STREAM                     */}
          {/* ============================================================== */}
          {(currentNav === "overview" || currentNav === "cases") && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <div>
                  <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <Ambulance className="w-5 h-5 text-blue-600" />
                    Inbound Ambulance Stream & Pre-Arrival Handover
                  </h3>
                  <p className="text-xs text-slate-500">
                    Dual-confirmed incoming patients approaching {hospital?.name} ER
                  </p>
                </div>
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                  {activeInboundDispatches.length} Inbound Active
                </span>
              </div>

              {activeInboundDispatches.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  No active inbound ambulances en route to this facility currently.
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {activeInboundDispatches.map((disp) => (
                    <div
                      key={disp.id}
                      className="py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200">
                            Unit {disp.ambulance_call_sign}
                          </span>
                          <span className="font-bold text-slate-900">Incident #{disp.incident_id}</span>
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 uppercase">
                            {disp.status}
                          </span>
                        </div>
                        <p className="text-slate-800 font-semibold truncate">
                          {disp.incident?.chief_complaint || "Acute emergency case"}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Patient: {disp.incident?.caller_name} • ETA: ~{disp.estimated_eta_seconds ? Math.round(disp.estimated_eta_seconds / 60) : 6} mins
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleInspectHandover(disp.id)}
                          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs flex items-center gap-1.5 shadow-2xs transition"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>Inspect SBAR Handover</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* SECTION 3: HANDOVER HISTORY                                    */}
          {/* ============================================================== */}
          {currentNav === "history" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <h2 className="text-base font-bold text-slate-900">Admitted Patient & Handover History</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase font-mono text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">Dispatch #</th>
                      <th className="py-2.5 px-3">Incident #</th>
                      <th className="py-2.5 px-3">Ambulance Unit</th>
                      <th className="py-2.5 px-3">Patient Complaint</th>
                      <th className="py-2.5 px-3">Intake Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {completedDispatches.map((disp) => (
                      <tr key={disp.id} className="hover:bg-slate-50 transition">
                        <td className="py-3 px-3 font-mono font-bold text-slate-900">#{disp.id}</td>
                        <td className="py-3 px-3 font-mono text-slate-600">#{disp.incident_id}</td>
                        <td className="py-3 px-3 font-semibold text-blue-700">{disp.ambulance_call_sign}</td>
                        <td className="py-3 px-3 text-slate-700 truncate max-w-xs">{disp.incident?.chief_complaint}</td>
                        <td className="py-3 px-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                            ADMITTED
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* SECTION 4: HOSPITAL PROFILE                                    */}
          {/* ============================================================== */}
          {currentNav === "profile" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4 max-w-2xl">
              <h2 className="text-base font-bold text-slate-900">Facility Profile & Specialties</h2>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">Facility Name</span>
                  <p className="text-sm font-bold text-slate-900">{hospital?.name}</p>
                </div>
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">Facility Code</span>
                  <p className="text-sm font-mono font-bold text-blue-700">{hospital?.facility_code}</p>
                </div>
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 col-span-2">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">Address</span>
                  <p className="text-xs font-semibold text-slate-800">{hospital?.address}</p>
                </div>
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 col-span-2">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">Clinical Specialties</span>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {hospital?.specialties?.map((s: string) => (
                      <span key={s} className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 text-[11px] font-medium">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* SBAR HANDOVER CLINICAL INSPECTION MODAL */}
      {activeHandoverPacket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-xl flex flex-col">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                  <FileText className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Digital SBAR Clinical Handover Packet
                  </h3>
                  <p className="text-[11px] text-slate-500 font-mono">
                    Dispatch #{activeHandoverPacket.dispatch_id} • Status: {activeHandoverPacket.status}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setActiveHandoverPacket(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              {/* Situation */}
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-blue-700 uppercase tracking-wider block">1. Situation</span>
                <p className="font-semibold text-slate-900">{activeHandoverPacket.situation}</p>
              </div>

              {/* Background */}
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider block">2. Background</span>
                <p className="text-slate-800">{activeHandoverPacket.background}</p>
              </div>

              {/* Assessment */}
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wider block">3. Assessment</span>
                <p className="text-slate-800">{activeHandoverPacket.assessment}</p>
              </div>

              {/* Recommendation */}
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider block">4. Recommendation</span>
                <p className="text-slate-800">{activeHandoverPacket.recommendation}</p>
              </div>

              {/* Clinician Sign-Off Input */}
              <div className="pt-2 border-t border-slate-200 space-y-2">
                <label className="text-xs font-bold text-slate-900 block">
                  Receiving ER Practitioner Formal Sign-Off:
                </label>
                <input
                  type="text"
                  value={clinicianName}
                  onChange={(e) => setClinicianName(e.target.value)}
                  placeholder="Doctor / ER Registrar Full Name"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Acknowledge Button */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveHandoverPacket(null)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={handleAcknowledgeHandover}
                  disabled={actionLoading || activeHandoverPacket.status === "ACKNOWLEDGED"}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {activeHandoverPacket.status === "ACKNOWLEDGED"
                      ? "✓ Handover Acknowledged"
                      : "Acknowledge & Confirm Bed Intake"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
