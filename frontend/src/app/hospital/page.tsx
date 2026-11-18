"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Ambulance,
  CheckCircle2,
  Clock,
  MapPin,
  Phone,
  Radio,
  Shield,
  RefreshCw,
  LogOut,
  ChevronRight,
  User,
  Eye,
  FileText,
  Building2,
  Bed,
  Check,
  X,
  Plus,
  Minus,
  Sparkles,
  ShieldAlert,
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

  // Handover modal & clinician input
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
            if (data.event && data.event !== "PONG" && data.event !== "HANDSHAKE") {
              if (data.event === "DISPATCH_CREATED") {
                setFeedbackMsg({ text: "Incoming Provisional Bed Reservation from Regional Dispatch!", type: "info" });
              } else if (data.event === "HANDOVER_PACKET_GENERATED") {
                setFeedbackMsg({ text: "Pre-arrival Clinical Handover Packet received for inbound patient!", type: "success" });
              } else if (data.event === "HOSPITAL_CAPACITY_UPDATED") {
                setFeedbackMsg({ text: "Emergency bed capacity synchronized across regional network.", type: "info" });
              }
              fetchHospitalData();
            }
          } catch (_) {}
        };
      } catch (_) {}
    }

    connect();

    const pollInterval = setInterval(fetchHospitalData, 7000);

    return () => {
      clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [backendUrl, fetchHospitalData]);

  // Active provisional dispatch targeting this hospital
  const pendingDispatch = dispatches.find(
    (d) => d.coordination_status === "PENDING_CONFIRMATIONS" && d.hospital_confirmation_status === "PENDING"
  );

  // Inbound en-route dispatches
  const inboundDispatches = dispatches.filter(
    (d) => d.coordination_status === "CONFIRMED" && d.status !== "COMPLETED" && d.status !== "CANCELLED"
  );

  // Completed / Admitted dispatches
  const completedDispatches = dispatches.filter((d) => d.status === "COMPLETED");

  // Calculate live reservation countdown
  useEffect(() => {
    if (!pendingDispatch || !pendingDispatch.reservation_expires_at) {
      setRemainingSeconds(null);
      return;
    }

    const updateTimer = () => {
      const expiresMs = new Date(pendingDispatch.reservation_expires_at!).getTime();
      const diffSecs = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
      setRemainingSeconds(diffSecs);
    };

    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [pendingDispatch]);

  const handleConfirmBedReservation = async (dispatchId: number, decision: "ACCEPTED" | "REJECTED") => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    setFeedbackMsg(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm/hospital`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ decision }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to confirm bed reservation");
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

  const handleAdjustBeds = async (delta: number) => {
    if (!hospital?.id) return;
    const token = localStorage.getItem("lifelink_token");
    const currentBeds = hospital.available_emergency_beds || 0;
    const newBeds = Math.max(0, currentBeds + delta);

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/capacity`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ available_emergency_beds: newBeds }),
      });

      if (resp.ok) {
        setHospital(await resp.json());
        setFeedbackMsg({ text: `Available emergency bed capacity updated to ${newBeds}`, type: "success" });
      }
    } catch (_) {}
  };

  const handleToggleAccepting = async () => {
    if (!hospital?.id) return;
    const token = localStorage.getItem("lifelink_token");
    const newStatus = !hospital.accepting_emergencies;

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/capacity`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ accepting_emergencies: newStatus }),
      });

      if (resp.ok) {
        setHospital(await resp.json());
        setFeedbackMsg({
          text: `Facility emergency intake is now ${newStatus ? "ACTIVE / OPEN" : "ON DIVERT"}`,
          type: newStatus ? "success" : "info",
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

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex items-center gap-3 bg-white px-5 py-3 rounded-xl border border-slate-200 shadow-sm">
          <Building2 className="w-5 h-5 text-emerald-600 animate-pulse" />
          <span className="text-xs font-semibold text-slate-700">Connecting to Hospital ER Console...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-emerald-100 selection:text-emerald-900">
      {/* Top Application Bar */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur px-5 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40 shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-600/20">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black tracking-tight text-slate-900">LIFELINK</h1>
              <span className="text-xs font-semibold text-slate-400">/ Hospital ER Console</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold uppercase">
                {hospital?.facility_code || "HOSP-MNG"}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Facility: <strong className="text-slate-800">{hospital?.name}</strong> | Clinician: {user?.full_name}
            </p>
          </div>
        </div>

        {/* Live Status, Portal Switcher & Logout */}
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-medium ${
              wsConnected
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-emerald-500 animate-ping" : "bg-amber-500"}`} />
            <span>{wsConnected ? "Trauma Feed Live" : "Reconnecting..."}</span>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs font-semibold">
            <button
              onClick={() => router.push("/dispatcher")}
              className="px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Regional Dispatcher Command HQ"
            >
              Dispatcher HQ
            </button>
            <button
              onClick={() => router.push("/ambulance")}
              className="px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Paramedic In-Vehicle Terminal"
            >
              Ambulance
            </button>
            <button
              onClick={() => router.push("/citizen")}
              className="px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Citizen SOS Portal"
            >
              Citizen SOS
            </button>
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-bold transition cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 space-y-6">
        {/* Feedback message banner */}
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
        {/* FACILITY CAPACITY & EMERGENCY INTAKE MANAGEMENT BAR           */}
        {/* ============================================================== */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs grid grid-cols-1 sm:grid-cols-4 gap-4 items-center">
          {/* Bed Counter */}
          <div className="sm:col-span-2 flex items-center justify-between p-3.5 bg-slate-50 rounded-xl border border-slate-200">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold block">
                Available Emergency Bays
              </span>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="text-2xl font-black font-mono text-slate-900">
                  {hospital?.available_emergency_beds ?? 0}
                </span>
                <span className="text-xs text-slate-500 font-mono">
                  / {hospital?.total_emergency_beds ?? 15} total capacity
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                onClick={() => handleAdjustBeds(-1)}
                className="w-8 h-8 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition cursor-pointer"
                title="Decrement available bay"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleAdjustBeds(1)}
                className="w-8 h-8 rounded-lg bg-white hover:bg-slate-200 border border-slate-300 flex items-center justify-center text-slate-700 font-bold transition cursor-pointer"
                title="Increment available bay"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Reserved Beds Counter */}
          <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold block">
              Reserved / En Route
            </span>
            <div className="flex items-baseline gap-2 mt-0.5">
              <span className="text-2xl font-black font-mono text-blue-700">
                {hospital?.reserved_emergency_beds ?? 0}
              </span>
              <span className="text-xs text-slate-500">locked bays</span>
            </div>
          </div>

          {/* Intake Status Toggle */}
          <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold block">
                Intake Readiness
              </span>
              <span
                className={`text-xs font-bold font-mono ${
                  hospital?.accepting_emergencies ? "text-emerald-700" : "text-red-700"
                }`}
              >
                {hospital?.accepting_emergencies ? "OPEN / ACCEPTING" : "ON DIVERT"}
              </span>
            </div>
            <button
              onClick={handleToggleAccepting}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                hospital?.accepting_emergencies
                  ? "bg-emerald-100 hover:bg-emerald-200 text-emerald-800"
                  : "bg-red-100 hover:bg-red-200 text-red-800"
              }`}
            >
              {hospital?.accepting_emergencies ? "Set Divert" : "Reopen ER"}
            </button>
          </div>
        </div>

        {/* ============================================================== */}
        {/* INCOMING PROVISIONAL RESERVATION BANNER WITH 90s COUNTDOWN    */}
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
                <span className="text-[11px] font-mono text-slate-500 block">Dual Confirmation TTL Window</span>
                <div className="flex items-center gap-1.5 text-2xl font-black font-mono text-amber-900">
                  <Clock className="w-6 h-6 text-amber-600 animate-spin" />
                  <span>{remainingSeconds !== null ? `${remainingSeconds}s` : "90s"}</span>
                </div>
              </div>
            </div>

            {/* Mission Details Preview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-4 rounded-xl bg-white border border-amber-200 text-xs font-mono">
              <div>
                <span className="text-slate-400 block text-[10px]">Patient Chief Complaint:</span>
                <strong className="text-slate-900 text-sm">
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
                <span className="text-slate-400 block text-[10px]">Estimated Arrival:</span>
                <strong className="text-slate-800">
                  {pendingDispatch.estimated_eta_seconds
                    ? `~${Math.ceil(pendingDispatch.estimated_eta_seconds / 60)} mins`
                    : "Calculating..."}
                </strong>
              </div>
            </div>

            {/* Accept / Decline CTAs */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => handleConfirmBedReservation(pendingDispatch.id, "REJECTED")}
                disabled={actionLoading}
                className="px-5 py-2.5 rounded-xl bg-white hover:bg-red-50 text-red-700 border border-red-300 font-bold text-xs transition cursor-pointer"
              >
                Decline Bed / Divert
              </button>
              <button
                onClick={() => handleConfirmBedReservation(pendingDispatch.id, "ACCEPTED")}
                disabled={actionLoading}
                className="px-7 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-md shadow-emerald-600/30 transition cursor-pointer flex items-center gap-2"
              >
                <Check className="w-4 h-4" />
                <span>Confirm Emergency Bed ({remainingSeconds || 90}s)</span>
              </button>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* INBOUND AMBULANCE QUEUE & HANDOVER INSPECTION                  */}
        {/* ============================================================== */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Ambulance className="w-5 h-5 text-blue-600" />
              <div>
                <h3 className="text-sm font-bold text-slate-900">Inbound En-Route Ambulances ({inboundDispatches.length})</h3>
                <p className="text-xs text-slate-500">Live ETA tracking and pre-arrival digital handover briefs</p>
              </div>
            </div>
            <button
              onClick={fetchHospitalData}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>

          {inboundDispatches.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-400 font-mono space-y-1">
              <CheckCircle2 className="w-8 h-8 text-slate-300 mx-auto" />
              <p>No ambulances currently en route to this emergency department.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {inboundDispatches.map((disp) => (
                <div
                  key={disp.id}
                  className="p-4 rounded-xl border border-slate-200 bg-slate-50/70 hover:bg-slate-50 transition space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-blue-700">#{disp.ambulance_call_sign}</span>
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold">
                          {disp.status.replace(/_/g, " ")}
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-slate-900 mt-1">
                        {disp.incident?.chief_complaint || "Emergency Patient Intake"}
                      </h4>
                    </div>

                    <div className="text-right">
                      <span className="text-[10px] font-mono text-slate-400 block">Estimated ETA</span>
                      <strong className="text-sm font-black text-emerald-700 font-mono">
                        {disp.estimated_eta_seconds
                          ? `~${Math.ceil(disp.estimated_eta_seconds / 60)} mins`
                          : "En route"}
                      </strong>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-200 text-xs">
                    <span className="text-[11px] font-mono text-slate-500">
                      Handover:{" "}
                      <strong className={disp.handover_packet?.status === "ACKNOWLEDGED" ? "text-emerald-700" : "text-amber-700"}>
                        {disp.handover_packet?.status || "Generated"}
                      </strong>
                    </span>

                    <button
                      onClick={() => handleInspectHandover(disp.id)}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs transition flex items-center gap-1.5 cursor-pointer"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>Inspect Handover</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ============================================================== */}
        {/* ADMITTED / COMPLETED EMERGENCY CASES LOG                       */}
        {/* ============================================================== */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          <div className="pb-3 border-b border-slate-100">
            <h3 className="text-sm font-bold text-slate-900">Admitted Patients & Handover Archive</h3>
            <p className="text-xs text-slate-500">Record of emergency cases safely delivered and acknowledged</p>
          </div>

          {completedDispatches.length === 0 ? (
            <p className="text-center py-4 text-xs text-slate-400 font-mono">No historical admissions today.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-500 font-mono uppercase text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Dispatch</th>
                    <th className="py-2.5 px-3">Unit</th>
                    <th className="py-2.5 px-3">Complaint</th>
                    <th className="py-2.5 px-3">Triage</th>
                    <th className="py-2.5 px-3">Handover Officer</th>
                    <th className="py-2.5 px-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {completedDispatches.map((disp) => (
                    <tr key={disp.id} className="hover:bg-slate-50/80 transition">
                      <td className="py-3 px-3 font-mono font-bold text-slate-700">#DSP-{disp.id}</td>
                      <td className="py-3 px-3 font-mono font-bold text-blue-700">{disp.ambulance_call_sign}</td>
                      <td className="py-3 px-3 font-semibold text-slate-800">
                        {disp.incident?.chief_complaint || "Medical Case"}
                      </td>
                      <td className="py-3 px-3 font-mono text-[11px]">{disp.incident?.triage_level || "P1"}</td>
                      <td className="py-3 px-3 text-slate-700 font-mono text-[11px]">
                        {disp.handover_packet?.acknowledged_by || "ER Triage Desk"}
                      </td>
                      <td className="py-3 px-3">
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                          ADMITTED
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* Handover Packet Inspection Modal */}
      {activeHandoverPacket && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2 text-blue-600">
                <FileText className="w-5 h-5" />
                <h3 className="font-bold text-base text-slate-900">
                  Digital Pre-Arrival Handover Packet (SBAR)
                </h3>
              </div>
              <button
                onClick={() => setActiveHandoverPacket(null)}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            {/* SBAR Sections */}
            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="font-bold text-blue-900 font-mono uppercase text-[10px] block">
                  1. Situation & Triage Assessment
                </span>
                <p className="text-slate-800 font-semibold">{activeHandoverPacket.chief_complaint}</p>
                <div className="flex items-center gap-2 pt-1 font-mono text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 font-bold">
                    {activeHandoverPacket.triage_priority} ({activeHandoverPacket.triage_color})
                  </span>
                  <span className="text-slate-500">Triage Score: {activeHandoverPacket.triage_score}/100</span>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="font-bold text-blue-900 font-mono uppercase text-[10px] block">
                  2. Background & Symptoms
                </span>
                <p className="text-slate-700">
                  Patient Location: {activeHandoverPacket.incident_address || "Mangaluru Corridor"}
                </p>
                {activeHandoverPacket.reported_symptoms?.length > 0 && (
                  <p className="text-slate-600 font-mono text-[11px] pt-1">
                    Symptoms: {activeHandoverPacket.reported_symptoms.join(", ")}
                  </p>
                )}
              </div>

              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="font-bold text-blue-900 font-mono uppercase text-[10px] block">
                  3. Inbound Ambulance Transport
                </span>
                <p className="text-slate-800 font-mono">Unit: {activeHandoverPacket.ambulance_call_sign}</p>
                <p className="text-slate-600 font-mono text-[11px]">
                  Equipment: {(activeHandoverPacket.required_equipment || []).join(", ") || "Standard Trauma Kit"}
                </p>
              </div>

              {/* Acknowledgment Box */}
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-emerald-900 block text-xs">
                    Clinical Intake Acknowledgment Status:
                  </span>
                  <span className="font-mono text-[11px] font-bold text-emerald-800 uppercase">
                    {activeHandoverPacket.status || "PENDING"}
                  </span>
                </div>

                {activeHandoverPacket.status === "ACKNOWLEDGED" ? (
                  <div className="text-xs text-emerald-800 font-mono">
                    Acknowledged by: <strong>{activeHandoverPacket.acknowledged_by}</strong> on{" "}
                    {new Date(activeHandoverPacket.acknowledged_at).toLocaleTimeString()}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label className="block text-emerald-900 font-bold text-[11px]">
                      Clinician / Triage Officer Signature:
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={clinicianName}
                        onChange={(e) => setClinicianName(e.target.value)}
                        placeholder="e.g. Dr. A. Shenoy"
                        className="flex-1 px-3 py-1.5 rounded-lg border border-emerald-300 bg-white text-xs"
                      />
                      <button
                        onClick={handleAcknowledgeHandover}
                        disabled={actionLoading || !clinicianName.trim()}
                        className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition cursor-pointer flex items-center gap-1.5"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Acknowledge</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setActiveHandoverPacket(null)}
                className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
