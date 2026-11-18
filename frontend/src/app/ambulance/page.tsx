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
  Navigation,
  Check,
  X,
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

const NEXT_LIFECYCLE_ACTION: Record<string, { nextStatus: string; label: string; icon: string }> = {
  ASSIGNED: { nextStatus: "EN_ROUTE_INCIDENT", label: "Confirm En Route to Patient Scene", icon: "Navigation" },
  EN_ROUTE_INCIDENT: { nextStatus: "ON_SCENE", label: "Confirm Arrived on Scene with Patient", icon: "MapPin" },
  ON_SCENE: { nextStatus: "EN_ROUTE_HOSPITAL", label: "Departing Scene towards Hospital ER", icon: "Building2" },
  EN_ROUTE_HOSPITAL: { nextStatus: "COMPLETED", label: "Confirm Arrived at ER & Safe Handover", icon: "CheckCircle2" },
};

export default function AmbulancePortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [ambulance, setAmbulance] = useState<any>(null);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

  // Reservation countdown state
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  const isActionInProgressRef = useRef(false);
  const processedEventsRef = useRef<Set<string>>(new Set());
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const fetchAmbulanceData = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) {
      router.push("/login");
      return;
    }

    try {
      // 1. Verify user session & assigned unit
      const meResp = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) throw new Error("Invalid session");
      const userData = await meResp.json();
      setUser(userData);

      // 2. Fetch assigned ambulance telemetry & status
      if (userData.ambulance_id) {
        const ambResp = await fetch(`${backendUrl}/api/ambulances/${userData.ambulance_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (ambResp.ok) {
          setAmbulance(await ambResp.json());
        }
      }

      // 3. Fetch unit's assigned dispatches
      const dispResp = await fetch(`${backendUrl}/api/dispatch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (dispResp.ok) {
        const allDispatches: DispatchRecord[] = await dispResp.json();
        // Filter strictly to this unit's assignments
        const myDispatches = allDispatches.filter((d) => d.ambulance_id === userData.ambulance_id);
        setDispatches(myDispatches);
      }
    } catch (err: any) {
      console.warn("Ambulance fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router]);

  // Connect WebSocket with JWT & targeted event subscription
  useEffect(() => {
    fetchAmbulanceData();

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
                setFeedbackMsg({ text: "Incoming Emergency Mission Assignment received!", type: "info" });
              } else if (data.event === "DISPATCH_CONFIRMATION_UPDATED") {
                setFeedbackMsg({ text: "Mission confirmation status synchronized with receiving hospital.", type: "success" });
              } else if (data.event === "HANDOVER_ACKNOWLEDGED") {
                setFeedbackMsg({ text: "Receiving Hospital ER desk acknowledged digital handover packet!", type: "success" });
              }
              fetchAmbulanceData();
            }
          } catch (_) {}
        };
      } catch (_) {}
    }

    connect();

    const pollInterval = setInterval(fetchAmbulanceData, 7000);

    return () => {
      clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [backendUrl, fetchAmbulanceData]);

  // Active provisional dispatch requiring confirmation
  const pendingDispatch = dispatches.find(
    (d) => d.coordination_status === "PENDING_CONFIRMATIONS" && d.ambulance_confirmation_status === "PENDING"
  );

  // Active confirmed or in-progress mission
  const activeMission = dispatches.find(
    (d) => d.coordination_status === "CONFIRMED" && d.status !== "COMPLETED" && d.status !== "CANCELLED"
  );

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

  const handleConfirmMission = async (dispatchId: number, decision: "ACCEPTED" | "REJECTED") => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    setFeedbackMsg(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm/ambulance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ decision }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to confirm mission");
      }

      setFeedbackMsg({
        text: `Mission assignment #${dispatchId} successfully ${decision.toLowerCase()}!`,
        type: decision === "ACCEPTED" ? "success" : "info",
      });
      await fetchAmbulanceData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Confirmation error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  const handleStepLifecycle = async (dispatchId: number) => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    setFeedbackMsg(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/step`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to advance mission lifecycle");
      }

      const updated = await resp.json();
      setFeedbackMsg({
        text: `Mission #${dispatchId} advanced to stage: ${updated.status}`,
        type: "success",
      });
      await fetchAmbulanceData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Lifecycle error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  const handleToggleUnitStatus = async (newStatus: string) => {
    if (!ambulance?.id) return;
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/ambulances/${ambulance.id}/status?status=${newStatus}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        setAmbulance(await resp.json());
        setFeedbackMsg({ text: `Unit operational status updated to ${newStatus}`, type: "success" });
      }
    } catch (_) {}
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
          <Ambulance className="w-5 h-5 text-blue-600 animate-pulse" />
          <span className="text-xs font-semibold text-slate-700">Connecting to In-Vehicle Terminal...</span>
        </div>
      </div>
    );
  }

  const nextAction = activeMission ? NEXT_LIFECYCLE_ACTION[activeMission.status] : null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-blue-100 selection:text-blue-900">
      {/* Top Application Bar */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur px-5 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40 shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-600/20">
            <Ambulance className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black tracking-tight text-slate-900">LIFELINK</h1>
              <span className="text-xs font-semibold text-slate-400">/ Paramedic Terminal</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-bold uppercase">
                {ambulance?.call_sign || "ALS Unit"} • {ambulance?.vehicle_type || "ALS"}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Paramedic Crew: <strong className="text-slate-800">{user?.full_name}</strong> | Base Station: {ambulance?.base_station || "Mangaluru Central"}
            </p>
          </div>
        </div>

        {/* Readiness Switcher, WebSocket Badge & Quick Portals */}
        <div className="flex items-center gap-3">
          {/* Unit Status Selector */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs font-semibold">
            {(["AVAILABLE", "MAINTENANCE", "OFF_DUTY"] as const).map((st) => (
              <button
                key={st}
                onClick={() => handleToggleUnitStatus(st)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-mono transition ${
                  ambulance?.status === st
                    ? st === "AVAILABLE"
                      ? "bg-emerald-600 text-white shadow-2xs"
                      : "bg-slate-700 text-white shadow-2xs"
                    : "text-slate-600 hover:text-slate-900 hover:bg-white"
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-medium ${
              wsConnected
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-emerald-500 animate-ping" : "bg-amber-500"}`} />
            <span>{wsConnected ? "Radio Feed Online" : "Reconnecting..."}</span>
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
              onClick={() => router.push("/hospital")}
              className="px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Hospital ER Intake Console"
            >
              Hospital ER
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

      {/* Main Mission Workspace */}
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
        {/* 1. INCOMING PROVISIONAL RESERVATION BANNER WITH 90s COUNTDOWN  */}
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
                      Provisional Reservation Pending
                    </span>
                  </div>
                  <h2 className="text-lg font-black text-slate-900 mt-1">
                    Emergency Mission Assigned to Unit {ambulance?.call_sign}
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
                <span className="text-slate-400 block text-[10px]">Destination ER:</span>
                <strong className="text-slate-900 text-sm">{pendingDispatch.destination_hospital_name}</strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Hospital Bed Status:</span>
                <strong className="text-slate-800">{pendingDispatch.hospital_confirmation_status}</strong>
              </div>
              <div>
                <span className="text-slate-400 block text-[10px]">Estimated Transit:</span>
                <strong className="text-slate-800">
                  {pendingDispatch.estimated_eta_seconds
                    ? `~${Math.ceil(pendingDispatch.estimated_eta_seconds / 60)} mins`
                    : "Routing..."}
                </strong>
              </div>
            </div>

            {/* Accept / Decline CTAs */}
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => handleConfirmMission(pendingDispatch.id, "REJECTED")}
                disabled={actionLoading}
                className="px-5 py-2.5 rounded-xl bg-white hover:bg-red-50 text-red-700 border border-red-300 font-bold text-xs transition cursor-pointer"
              >
                Decline / Divert Mission
              </button>
              <button
                onClick={() => handleConfirmMission(pendingDispatch.id, "ACCEPTED")}
                disabled={actionLoading}
                className="px-7 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-md shadow-emerald-600/30 transition cursor-pointer flex items-center gap-2"
              >
                <Check className="w-4 h-4" />
                <span>Accept Mission Assignment ({remainingSeconds || 90}s)</span>
              </button>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 2. ACTIVE MISSION CONTROL CONSOLE                             */}
        {/* ============================================================== */}
        {activeMission ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold px-2 py-0.5 rounded-md bg-blue-100 text-blue-800">
                    Active Mission #DSP-{activeMission.id}
                  </span>
                  <span className="font-mono text-xs font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                    Incident #{activeMission.incident_id}
                  </span>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                    Dual Confirmed
                  </span>
                </div>
                <h3 className="text-xl font-black text-slate-900 mt-2">
                  Current Operational Stage: <span className="text-blue-700">{activeMission.status.replace(/_/g, " ")}</span>
                </h3>
                <p className="text-xs text-slate-500 mt-1 flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-emerald-600" />
                  <span>Receiving Trauma Facility: <strong>{activeMission.destination_hospital_name}</strong></span>
                </p>
              </div>

              {/* Primary Next-Stage Stepper Button */}
              {nextAction && (
                <button
                  onClick={() => handleStepLifecycle(activeMission.id)}
                  disabled={actionLoading}
                  className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md shadow-blue-600/20 transition cursor-pointer flex items-center gap-2"
                >
                  <Navigation className="w-4 h-4" />
                  <span>{actionLoading ? "Updating..." : nextAction.label} &rarr;</span>
                </button>
              )}
            </div>

            {/* SBAR Pre-Arrival Handover Packet Preview */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 font-mono">
                    Pre-Arrival Digital Handover Packet
                  </h4>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-bold">
                  SBAR PROTOCOL
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <span className="text-slate-400 block text-[10px] font-mono">Chief Complaint:</span>
                  <strong className="text-slate-900 text-xs">
                    {activeMission.incident?.chief_complaint || "Emergency Patient Intake"}
                  </strong>
                </div>
                <div className="p-3 bg-white rounded-lg border border-slate-200">
                  <span className="text-slate-400 block text-[10px] font-mono">Hospital Intake Acknowledgment:</span>
                  <strong className="text-emerald-700 text-xs">
                    {activeMission.handover_packet?.status === "ACKNOWLEDGED"
                      ? `Acknowledged (${activeMission.handover_packet?.acknowledged_by || "ER Desk"})`
                      : "Pending ER Triage Acknowledgment"}
                  </strong>
                </div>
              </div>
            </div>
          </div>
        ) : (
          !pendingDispatch && (
            <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-3">
              <CheckCircle2 className="w-10 h-10 text-emerald-600 mx-auto" />
              <h3 className="font-bold text-slate-800 text-sm">Unit {ambulance?.call_sign} on Standby</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                No active dispatches assigned to this vehicle. Radio telemetry is connected to Regional HQ. You will be alerted immediately upon provisional mission reservation.
              </p>
            </div>
          )
        )}

        {/* ============================================================== */}
        {/* 3. UNIT RECENT DISPATCH HISTORY                                */}
        {/* ============================================================== */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Unit Mission Log ({ambulance?.call_sign})</h3>
              <p className="text-xs text-slate-500">Record of dispatches and emergency transports for this vehicle</p>
            </div>
            <button
              onClick={fetchAmbulanceData}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>

          {dispatches.length === 0 ? (
            <p className="text-center py-6 text-xs text-slate-400 font-mono">No previous missions recorded for this unit.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-500 font-mono uppercase text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">Dispatch ID</th>
                    <th className="py-2.5 px-3">Incident</th>
                    <th className="py-2.5 px-3">Destination Hospital</th>
                    <th className="py-2.5 px-3">Coordination</th>
                    <th className="py-2.5 px-3">Stage</th>
                    <th className="py-2.5 px-3">Attempt</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dispatches.map((disp) => (
                    <tr key={disp.id} className="hover:bg-slate-50/80 transition">
                      <td className="py-3 px-3 font-mono font-bold text-slate-700">#DSP-{disp.id}</td>
                      <td className="py-3 px-3 font-mono font-bold text-blue-700">#{disp.incident_id}</td>
                      <td className="py-3 px-3 font-semibold text-slate-800">{disp.destination_hospital_name}</td>
                      <td className="py-3 px-3">
                        <span
                          className={`font-mono text-[10px] px-2 py-0.5 rounded-full font-bold ${
                            disp.coordination_status === "CONFIRMED"
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              : "bg-amber-50 text-amber-700 border border-amber-200"
                          }`}
                        >
                          {disp.coordination_status}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono font-bold text-slate-800">{disp.status}</td>
                      <td className="py-3 px-3 font-mono text-slate-600">#{disp.attempt_number}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
