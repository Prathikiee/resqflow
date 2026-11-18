"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Ambulance,
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  ExternalLink,
  Eye,
  FileText,
  Fuel,
  History,
  LayoutDashboard,
  LogOut,
  MapPin,
  Navigation,
  Phone,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  Sliders,
  User,
  Wrench,
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
  destination_hospital_address?: string;
  destination_hospital_latitude?: number;
  destination_hospital_longitude?: number;
  coordination_status: string;
  ambulance_confirmation_status: string;
  hospital_confirmation_status: string;
  status: string;
  attempt_number: number;
  reservation_expires_at?: string;
  estimated_eta_seconds?: number;
  route_distance_meters?: number;
  incident_latitude?: number;
  incident_longitude?: number;
  incident_address?: string;
  incident?: {
    id: number;
    caller_name: string;
    caller_phone: string;
    location_address: string;
    latitude?: number;
    longitude?: number;
    chief_complaint: string;
    triage_level: string;
    triage_color: string;
    status: string;
  };
  handover_packet?: any;
}

const NEXT_LIFECYCLE_ACTION: Record<string, { nextStatus: string; label: string; icon: React.ElementType }> = {
  ASSIGNED: { nextStatus: "EN_ROUTE_INCIDENT", label: "Confirm En Route to Incident Scene", icon: Navigation },
  EN_ROUTE_INCIDENT: { nextStatus: "ON_SCENE", label: "Confirm Arrived on Scene with Patient", icon: MapPin },
  ON_SCENE: { nextStatus: "EN_ROUTE_HOSPITAL", label: "Patient Onboard • Departing Scene towards Hospital ER", icon: Building2 },
  EN_ROUTE_HOSPITAL: { nextStatus: "COMPLETED", label: "Confirm Arrived at ER & Safe Handover", icon: CheckCircle2 },
};

export default function AmbulancePortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [ambulance, setAmbulance] = useState<any>(null);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [currentNav, setCurrentNav] = useState<string>("overview");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
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
      const meResp = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) throw new Error("Invalid session");
      const userData = await meResp.json();
      setUser(userData);

      if (userData.ambulance_id) {
        const ambResp = await fetch(`${backendUrl}/api/ambulances/${userData.ambulance_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (ambResp.ok) {
          setAmbulance(await ambResp.json());
        }
      }

      const dispResp = await fetch(`${backendUrl}/api/dispatch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (dispResp.ok) {
        const allDispatches: DispatchRecord[] = await dispResp.json();
        const myDispatches = allDispatches.filter((d) => d.ambulance_id === userData.ambulance_id);
        setDispatches(myDispatches);
      }
    } catch (err: any) {
      console.warn("Ambulance fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router]);

  // WebSocket Subscription
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

  const completedMissions = dispatches.filter((d) => d.status === "COMPLETED");

  const sidebarNavItems: NavItem[] = [
    { id: "overview", label: "Current Mission", icon: LayoutDashboard },
    { id: "history", label: "Mission History", icon: History, count: completedMissions.length },
    { id: "fleet", label: "Vehicle Status", icon: Ambulance },
    { id: "profile", label: "Crew Profile", icon: User },
  ];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
          <span className="text-xs font-bold text-slate-700">Connecting to Ambulance Telemetry...</span>
        </div>
      </div>
    );
  }

  // Navigation URLs
  const patientLat = activeMission?.incident_latitude ?? activeMission?.incident?.latitude ?? 12.8700;
  const patientLng = activeMission?.incident_longitude ?? activeMission?.incident?.longitude ?? 74.8400;
  const hospLat = activeMission?.destination_hospital_latitude ?? 12.8710;
  const hospLng = activeMission?.destination_hospital_longitude ?? 74.8450;

  const gmapsSceneUrl = `https://www.google.com/maps/dir/?api=1&destination=${patientLat},${patientLng}&travelmode=driving`;
  const osmSceneUrl = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${ambulance?.current_latitude || 12.9815},${ambulance?.current_longitude || 74.7950};${patientLat},${patientLng}`;

  const gmapsHospUrl = `https://www.google.com/maps/dir/?api=1&destination=${hospLat},${hospLng}&travelmode=driving`;

  const nextActionConfig = activeMission ? NEXT_LIFECYCLE_ACTION[activeMission.status] : null;
  const NextActionIcon = nextActionConfig ? nextActionConfig.icon : CheckCircle2;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex font-sans">
      {/* 1. LEFT SIDEBAR */}
      <Sidebar
        role="AMBULANCE"
        roleLabel="Ambulance Paramedic"
        user={user}
        currentNav={currentNav}
        onNavChange={setCurrentNav}
        navItems={sidebarNavItems}
        isOpenMobile={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
        onLogout={handleLogout}
        entityName={ambulance?.call_sign ? `Unit ${ambulance.call_sign}` : "ALS Paramedic Crew"}
      />

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0">
        {/* Top Minimal Navigation */}
        <TopNav
          title={ambulance?.call_sign ? `Unit ${ambulance.call_sign}` : "Ambulance Console"}
          subtitle={`${ambulance?.base_station || "Mangaluru Sector"} • ${ambulance?.vehicle_type || "ALS"}`}
          wsConnected={wsConnected}
          onMenuToggle={() => setIsMobileMenuOpen(true)}
          actions={
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-slate-500 hidden sm:inline">Duty:</span>
              <button
                type="button"
                onClick={() => handleToggleUnitStatus(ambulance?.status === "AVAILABLE" ? "MAINTENANCE" : "AVAILABLE")}
                className={`px-2.5 py-1 rounded-md text-xs font-bold border transition ${
                  ambulance?.status === "AVAILABLE"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                    : "bg-amber-50 text-amber-700 border-amber-300"
                }`}
              >
                {ambulance?.status || "AVAILABLE"}
              </button>
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
          {/* VIEW: OVERVIEW / CURRENT MISSION                               */}
          {/* ============================================================== */}
          {currentNav === "overview" && (
            <div className="space-y-6">
              {/* CASE 1: PROVISIONAL MISSION REQUEST REQUIRING CONFIRMATION */}
              {pendingDispatch && (
                <div className="bg-amber-50/60 border-2 border-amber-400 rounded-xl p-5 shadow-sm space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-amber-500 text-white flex items-center justify-center shadow-xs">
                        <AlertTriangle className="w-5 h-5 animate-pulse" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-200 text-amber-900">
                            DISPATCH #{pendingDispatch.id} • ATTEMPT #{pendingDispatch.attempt_number}
                          </span>
                          <span className="text-xs font-bold text-amber-900 uppercase">
                            Provisional Assignment Offered
                          </span>
                        </div>
                        <h2 className="text-base font-bold text-slate-900 mt-0.5">
                          Emergency Response Request for Unit {ambulance?.call_sign}
                        </h2>
                      </div>
                    </div>

                    {/* 90-Second Countdown */}
                    {remainingSeconds !== null && (
                      <div className="text-right">
                        <span className="text-[10px] font-mono text-slate-500 block uppercase">Dual Confirmation TTL</span>
                        <span className="text-xl font-black font-mono text-amber-900">
                          {remainingSeconds}s remaining
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Incident Details Card */}
                  <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">Chief Medical Complaint:</span>
                      <span className="font-mono text-slate-500">Incident #{pendingDispatch.incident_id}</span>
                    </div>
                    <p className="text-sm font-semibold text-slate-900 bg-slate-50 p-2.5 rounded border border-slate-200">
                      {pendingDispatch.incident?.chief_complaint || "Acute medical crisis requiring immediate ALS response"}
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 text-slate-600">
                      <div className="flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5 text-red-600 shrink-0" />
                        <span className="truncate">Scene: <strong>{pendingDispatch.incident?.location_address}</strong></span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span className="truncate">Assigned ER: <strong>{pendingDispatch.destination_hospital_name}</strong></span>
                      </div>
                    </div>
                  </div>

                  {/* Accept / Decline Action Buttons */}
                  <div className="flex items-center justify-end gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => handleConfirmMission(pendingDispatch.id, "REJECTED")}
                      disabled={actionLoading}
                      className="px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs transition"
                    >
                      Decline Mission
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmMission(pendingDispatch.id, "ACCEPTED")}
                      disabled={actionLoading}
                      className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5"
                    >
                      <Check className="w-4 h-4" />
                      <span>Accept Mission</span>
                    </button>
                  </div>
                </div>
              )}

              {/* CASE 2: ACTIVE MISSION IN PROGRESS */}
              {activeMission ? (
                <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-blue-600 text-white flex items-center justify-center">
                        <Radio className="w-5 h-5 animate-pulse" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                            DUAL CONFIRMED
                          </span>
                          <span className="text-xs font-bold text-slate-900">Dispatch #{activeMission.id}</span>
                        </div>
                        <h2 className="text-base font-bold text-slate-900 mt-0.5">
                          Active Operational Mission in Progress
                        </h2>
                      </div>
                    </div>

                    {/* External Navigation Links */}
                    <div className="flex items-center gap-2">
                      <a
                        href={gmapsSceneUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-blue-600 text-xs font-bold flex items-center gap-1 transition"
                      >
                        <Compass className="w-3.5 h-3.5" />
                        <span>Google Maps</span>
                        <ExternalLink className="w-3 h-3 text-slate-400" />
                      </a>
                      <a
                        href={osmSceneUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold flex items-center gap-1 transition"
                      >
                        <Navigation className="w-3.5 h-3.5 text-slate-500" />
                        <span>OpenStreetMap</span>
                      </a>
                    </div>
                  </div>

                  {/* Patient & Incident Info */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                        Patient / Pickup Waypoint
                      </span>
                      <p className="text-sm font-bold text-slate-900">
                        {activeMission.incident?.caller_name || "Emergency Caller"} ({activeMission.incident?.caller_phone})
                      </p>
                      <p className="text-slate-600 flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5 text-red-600 shrink-0" />
                        <span>{activeMission.incident_address || activeMission.incident?.location_address}</span>
                      </p>
                      <p className="text-slate-800 bg-white p-2 rounded border border-slate-200 mt-2">
                        {activeMission.incident?.chief_complaint}
                      </p>
                    </div>

                    <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
                      <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block">
                        Destination Hospital ER
                      </span>
                      <p className="text-sm font-bold text-slate-900">{activeMission.destination_hospital_name}</p>
                      <p className="text-slate-600 flex items-center gap-1">
                        <Building2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span>Trauma Emergency Ward Intake Reserved</span>
                      </p>
                      <a
                        href={gmapsHospUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-800 mt-2"
                      >
                        <Navigation className="w-3 h-3" />
                        <span>Navigate to Hospital ER</span>
                      </a>
                    </div>
                  </div>

                  {/* 4-STAGE LIFECYCLE STEPPER & CONTROL BUTTON */}
                  <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-900">
                      <span>Operational Mission Lifecycle</span>
                      <span className="font-mono text-blue-700">Stage: {activeMission.status}</span>
                    </div>

                    {/* Progress Track */}
                    <div className="grid grid-cols-4 gap-2 text-center text-xs">
                      {[
                        { id: "ASSIGNED", label: "1. Assigned" },
                        { id: "EN_ROUTE_INCIDENT", label: "2. En Route Scene" },
                        { id: "ON_SCENE", label: "3. On Scene" },
                        { id: "EN_ROUTE_HOSPITAL", label: "4. En Route ER" },
                      ].map((step, idx) => {
                        const isCurrent = activeMission.status === step.id;
                        return (
                          <div
                            key={step.id}
                            className={`p-2 rounded-lg border text-xs font-semibold ${
                              isCurrent
                                ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                                : "bg-white text-slate-600 border-slate-200"
                            }`}
                          >
                            {step.label}
                          </div>
                        );
                      })}
                    </div>

                    {/* Prominent Next Action Button */}
                    {nextActionConfig && (
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => handleStepLifecycle(activeMission.id)}
                          disabled={actionLoading}
                          className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-sm transition active:scale-[0.99]"
                        >
                          <NextActionIcon className="w-5 h-5" />
                          <span>{nextActionConfig.label}</span>
                          <ArrowRight className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {/* CASE 3: NO ACTIVE MISSION — STANDBY / READINESS STATE */}
              {!pendingDispatch && !activeMission && (
                <div className="bg-white border border-slate-200 rounded-xl p-8 shadow-2xs text-center space-y-4 max-w-xl mx-auto">
                  <div className="w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 mx-auto">
                    <Ambulance className="w-7 h-7" />
                  </div>
                  <div className="space-y-1">
                    <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 uppercase">
                      Duty Status: {ambulance?.status || "AVAILABLE"}
                    </span>
                    <h2 className="text-lg font-bold text-slate-900 mt-2">
                      Ambulance {ambulance?.call_sign} on Standby
                    </h2>
                    <p className="text-xs text-slate-500 max-w-md mx-auto">
                      Connected to Mangaluru Emergency Coordination Network. The console will alert immediately when a high-priority incident is assigned to this unit.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3 max-w-xs mx-auto text-left pt-2 text-xs">
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-500 font-medium">Base Station</span>
                      <p className="font-bold text-slate-900 truncate">{ambulance?.base_station || "Surathkal Sector"}</p>
                    </div>
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-500 font-medium">Fuel Level</span>
                      <p className="font-bold text-slate-900">{ambulance?.fuel_level_percent || 90}%</p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: MISSION HISTORY                                          */}
          {/* ============================================================== */}
          {currentNav === "history" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <h2 className="text-base font-bold text-slate-900">Unit Mission History</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase font-mono text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">Dispatch #</th>
                      <th className="py-2.5 px-3">Incident #</th>
                      <th className="py-2.5 px-3">Hospital Destination</th>
                      <th className="py-2.5 px-3">Confirmation Status</th>
                      <th className="py-2.5 px-3">Mission Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dispatches.map((disp) => (
                      <tr key={disp.id} className="hover:bg-slate-50 transition">
                        <td className="py-3 px-3 font-mono font-bold text-slate-900">#{disp.id}</td>
                        <td className="py-3 px-3 font-mono text-slate-600">#{disp.incident_id}</td>
                        <td className="py-3 px-3 font-semibold text-slate-800">{disp.destination_hospital_name}</td>
                        <td className="py-3 px-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                            {disp.coordination_status}
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          <span className="font-mono text-slate-700">{disp.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: FLEET / VEHICLE STATUS                                   */}
          {/* ============================================================== */}
          {currentNav === "fleet" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4 max-w-2xl">
              <h2 className="text-base font-bold text-slate-900">Vehicle Specifications & Telemetry</h2>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">Call Sign</span>
                  <p className="text-sm font-bold text-slate-900">{ambulance?.call_sign}</p>
                </div>
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">Vehicle Tier</span>
                  <p className="text-sm font-bold text-blue-700">{ambulance?.vehicle_type || "ALS"}</p>
                </div>
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">GPS Coordinates</span>
                  <p className="text-xs font-mono font-bold text-slate-800">
                    {ambulance?.current_latitude?.toFixed(4)}°N, {ambulance?.current_longitude?.toFixed(4)}°E
                  </p>
                </div>
                <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 uppercase font-medium">Paramedic Level</span>
                  <p className="text-sm font-bold text-slate-900">{ambulance?.paramedic_level || "ADVANCED"}</p>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: PROFILE                                                  */}
          {/* ============================================================== */}
          {currentNav === "profile" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4 max-w-md">
              <h2 className="text-base font-bold text-slate-900">Crew Account Profile</h2>
              <div className="space-y-2 text-xs">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 block">Name</span>
                  <p className="font-bold text-slate-900">{user?.full_name}</p>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 block">Email</span>
                  <p className="font-mono text-slate-800">{user?.email}</p>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-500 block">Assigned Unit ID</span>
                  <p className="font-mono font-bold text-blue-700">Ambulance #{user?.ambulance_id}</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
