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
  Send,
  Plus,
  RefreshCw,
  LogOut,
  ChevronRight,
  User,
  Eye,
  FileText,
  Building2,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";

interface IncidentRecord {
  id: number;
  caller_name: string;
  caller_phone: string;
  location_address: string;
  chief_complaint: string;
  triage_level: string;
  triage_color: string;
  status: string;
  created_at: string;
  reporter_user_id?: number;
}

interface DispatchRecord {
  id: number;
  incident_id: number;
  ambulance_id: number;
  ambulance_call_sign: string;
  destination_hospital_name: string;
  coordination_status: string;
  status: string;
  estimated_eta_seconds?: number;
  route_distance_meters?: number;
}

const LIFECYCLE_STAGES = [
  { key: "DISPATCHED", label: "Dispatched", desc: "Unit assigned by Regional HQ" },
  { key: "EN_ROUTE_INCIDENT", label: "En Route to You", desc: "Ambulance travelling to your location" },
  { key: "ON_SCENE", label: "On Scene", desc: "Paramedics arrived and treating patient" },
  { key: "EN_ROUTE_HOSPITAL", label: "En Route to ER", desc: "Patient transit to destination hospital" },
  { key: "COMPLETED", label: "Safe Handover", desc: "Patient admitted to Emergency Dept" },
];

export default function CitizenPortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<IncidentRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [notifications, setNotifications] = useState<string[]>([]);

  // Modals
  const [showEmergencyModal, setShowEmergencyModal] = useState(false);
  const [showWitnessModal, setShowWitnessModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Emergency Form State
  const [callerName, setCallerName] = useState("");
  const [callerPhone, setCallerPhone] = useState("+91 ");
  const [address, setAddress] = useState("Kadri Park Road, Mangaluru");
  const [complaint, setComplaint] = useState("");
  const [chestPain, setChestPain] = useState(false);
  const [breathingStatus, setBreathingStatus] = useState("Normal");

  // Witness Report Form State
  const [witnessDesc, setWitnessDesc] = useState("");
  const [witnessType, setWitnessType] = useState("Road Traffic Accident");
  const [witnessLocation, setWitnessLocation] = useState("Bejai Junction, Mangaluru");

  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
  const processedEventsRef = useRef<Set<string>>(new Set());

  const addNotification = (msg: string) => {
    setNotifications((prev) => [msg, ...prev.slice(0, 4)]);
  };

  const fetchCitizenData = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) {
      router.push("/login");
      return;
    }

    try {
      // 1. Verify user session
      const meResp = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) throw new Error("Invalid session");
      const userData = await meResp.json();
      setUser(userData);
      if (!callerName) setCallerName(userData.full_name || "Rahul Alva");
      if (callerPhone === "+91 ") setCallerPhone(userData.phone_number || "+91 98451 99887");

      // 2. Fetch citizen's isolated incident records
      const incResp = await fetch(`${backendUrl}/api/incidents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (incResp.ok) {
        const incData: IncidentRecord[] = await incResp.json();
        setIncidents(incData);
        if (incData.length > 0 && !selectedIncident) {
          setSelectedIncident(incData[0]);
        }
      }

      // 3. Fetch active dispatches to match active emergencies
      const dispResp = await fetch(`${backendUrl}/api/dispatch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (dispResp.ok) {
        const dispData: DispatchRecord[] = await dispResp.json();
        setDispatches(dispData);
      }
    } catch (err: any) {
      console.warn("Citizen data fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router, callerName, callerPhone, selectedIncident]);

  // Connect WebSocket with JWT authentication & targeted delivery
  useEffect(() => {
    fetchCitizenData();

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
              if (data.event === "DISPATCH_STEPPED") {
                addNotification(`Ambulance mission updated to stage: ${data.payload?.status || "In transit"}`);
              } else if (data.event === "HANDOVER_ACKNOWLEDGED") {
                addNotification("Hospital Emergency Department acknowledged safe patient intake!");
              } else if (data.event === "DISPATCH_CONFIRMATION_UPDATED") {
                addNotification("Ambulance crew & receiving hospital confirmed emergency mission.");
              }
              fetchCitizenData();
            }
          } catch (_) {}
        };
      } catch (_) {}
    }

    connect();

    const pollInterval = setInterval(fetchCitizenData, 8000);

    return () => {
      clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [backendUrl, fetchCitizenData]);

  const handleReportEmergency = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!complaint.trim()) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/incidents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          caller_name: callerName,
          caller_phone: callerPhone,
          location_address: address,
          latitude: 12.8760,
          longitude: 74.8560,
          chief_complaint: complaint,
          chest_pain: chestPain,
          breathing_status: breathingStatus,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to log emergency incident");
      }

      const newInc = await resp.json();
      setComplaint("");
      setShowEmergencyModal(false);
      setSelectedIncident(newInc);
      addNotification(`Emergency Incident #${newInc.id} logged and dispatched to Regional HQ!`);
      await fetchCitizenData();
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitWitness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!witnessDesc.trim()) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/witness-reports`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reporter_identifier: user?.full_name || "Citizen Witness",
          incident_description: witnessDesc,
          incident_type: witnessType,
          latitude: 12.8780,
          longitude: 74.8580,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to submit witness report");
      }

      setWitnessDesc("");
      setShowWitnessModal(false);
      addNotification("Witness report submitted to Regional Dispatch for deduplication review.");
      await fetchCitizenData();
    } catch (err: any) {
      setErrorMessage(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("lifelink_token");
    localStorage.removeItem("lifelink_user");
    document.cookie = "lifelink_token=; path=/; max-age=0;";
    router.push("/login");
  };

  // Find active dispatch for the currently selected incident
  const activeDispatch = selectedIncident
    ? dispatches.find((d) => d.incident_id === selectedIncident.id && d.status !== "CANCELLED")
    : null;

  const currentStageIndex = activeDispatch
    ? LIFECYCLE_STAGES.findIndex((s) => s.key === activeDispatch.status)
    : -1;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex items-center gap-3 bg-white px-5 py-3 rounded-xl border border-slate-200 shadow-sm">
          <Activity className="w-5 h-5 text-red-600 animate-pulse" />
          <span className="text-xs font-semibold text-slate-700">Connecting to Citizen Portal...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-red-100 selection:text-red-900">
      {/* Top Application Bar */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur px-5 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40 shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center text-white shadow-md shadow-red-600/20">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black tracking-tight text-slate-900">LIFELINK</h1>
              <span className="text-xs font-semibold text-slate-400">/ Citizen SOS</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-bold uppercase">
                Emergency Reporter
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Authenticated Civilian: <strong className="text-slate-800">{user?.full_name}</strong> ({user?.email})
            </p>
          </div>
        </div>

        {/* Status Pill & Navigation Links */}
        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono font-medium ${
              wsConnected
                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-emerald-500 animate-ping" : "bg-amber-500"}`} />
            <span>{wsConnected ? "Live GPS & Fleet Sync" : "Reconnecting Feed..."}</span>
          </div>

          <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs font-semibold">
            <button
              onClick={() => router.push("/dispatcher")}
              className="px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Switch to Regional Dispatcher Command HQ"
            >
              Dispatcher HQ
            </button>
            <button
              onClick={() => router.push("/ambulance")}
              className="px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Switch to Paramedic In-Vehicle Terminal"
            >
              Ambulance
            </button>
            <button
              onClick={() => router.push("/hospital")}
              className="px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Switch to Hospital ER Console"
            >
              Hospital ER
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
        {/* Banner with Action Buttons */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="w-5 h-5 text-blue-600" />
              <h2 className="text-sm font-bold text-slate-900">Mangaluru Rapid Emergency Corridor (108 / ResQFlow)</h2>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-xl">
              Strictly isolated civilian session. All reported emergencies stream directly to regional dispatchers and emergency trauma units.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowWitnessModal(true)}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold transition border border-slate-200 cursor-pointer"
            >
              <Eye className="w-4 h-4 text-indigo-600" />
              <span>Report Secondary Witness Info</span>
            </button>

            <button
              onClick={() => setShowEmergencyModal(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-md shadow-red-600/20 transition cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>+ Request Immediate Medical Emergency SOS</span>
            </button>
          </div>
        </div>

        {/* Real-time Notifications Bar */}
        {notifications.length > 0 && (
          <div className="space-y-1.5">
            {notifications.map((msg, i) => (
              <div
                key={i}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-50 border border-blue-200 text-blue-800 text-xs font-medium animate-fadeIn"
              >
                <Activity className="w-4 h-4 text-blue-600 shrink-0" />
                <span>{msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* Active Emergency Status Stepper & Ambulance ETA Card */}
        {selectedIncident ? (
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold px-2 py-0.5 rounded-md bg-slate-100 text-slate-700">
                    Incident #{selectedIncident.id}
                  </span>
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                      selectedIncident.triage_color === "RED"
                        ? "bg-red-50 text-red-700 border-red-200"
                        : selectedIncident.triage_color === "YELLOW"
                        ? "bg-amber-50 text-amber-700 border-amber-200"
                        : "bg-emerald-50 text-emerald-700 border-emerald-200"
                    }`}
                  >
                    {selectedIncident.triage_level}
                  </span>
                  <span className="text-xs font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200">
                    {selectedIncident.status}
                  </span>
                </div>
                <h3 className="text-lg font-bold text-slate-900 mt-2">{selectedIncident.chief_complaint}</h3>
                <p className="text-xs text-slate-500 flex items-center gap-1.5 mt-1">
                  <MapPin className="w-3.5 h-3.5 text-slate-400" />
                  <span>{selectedIncident.location_address}</span>
                </p>
              </div>

              {/* Active Unit Telemetry Card */}
              {activeDispatch ? (
                <div className="p-3.5 rounded-xl bg-blue-50/70 border border-blue-200 text-xs space-y-1.5 min-w-[240px]">
                  <div className="flex items-center justify-between text-blue-900 font-bold">
                    <span className="flex items-center gap-1.5">
                      <Ambulance className="w-4 h-4 text-blue-600" />
                      <span>{activeDispatch.ambulance_call_sign}</span>
                    </span>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">
                      {activeDispatch.coordination_status}
                    </span>
                  </div>
                  <div className="text-slate-600 space-y-0.5 font-mono text-[11px]">
                    <p>ER: <strong>{activeDispatch.destination_hospital_name}</strong></p>
                    {activeDispatch.estimated_eta_seconds && (
                      <p className="text-emerald-700 font-bold">
                        Estimated Transit: ~{Math.ceil(activeDispatch.estimated_eta_seconds / 60)} mins
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-500 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600 animate-spin" />
                  <span>Dispatch coordination in progress with Regional Fleet...</span>
                </div>
              )}
            </div>

            {/* Visual Mission Lifecycle Stepper */}
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono mb-4">
                Emergency Response Progression
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
                {LIFECYCLE_STAGES.map((stg, idx) => {
                  const isCurrent = activeDispatch?.status === stg.key;
                  const isPast = currentStageIndex > idx;
                  const isPending = currentStageIndex < idx;

                  return (
                    <div
                      key={stg.key}
                      className={`p-3 rounded-xl border text-xs transition-all ${
                        isCurrent
                          ? "bg-blue-50 border-blue-300 ring-2 ring-blue-500/20 shadow-xs"
                          : isPast
                          ? "bg-emerald-50/50 border-emerald-200 text-slate-700"
                          : "bg-slate-50 border-slate-200 text-slate-400"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1.5">
                        {isPast ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                        ) : isCurrent ? (
                          <Activity className="w-4 h-4 text-blue-600 animate-pulse shrink-0" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-slate-300 flex items-center justify-center text-[10px] text-slate-400 shrink-0">
                            {idx + 1}
                          </div>
                        )}
                        <strong className={`truncate ${isCurrent ? "text-blue-900" : isPast ? "text-slate-800" : "text-slate-400"}`}>
                          {stg.label}
                        </strong>
                      </div>
                      <p className="text-[11px] leading-tight text-slate-500 line-clamp-2">{stg.desc}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center space-y-3">
            <ShieldAlert className="w-10 h-10 text-slate-300 mx-auto" />
            <h3 className="font-bold text-slate-700 text-sm">No Active Emergency Selected</h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              You currently have no active emergency cases. Click &quot;Request Immediate Medical Emergency SOS&quot; above to alert dispatchers.
            </p>
          </div>
        )}

        {/* My Emergencies History Table */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h3 className="text-sm font-bold text-slate-900">My Emergency Incident History</h3>
              <p className="text-xs text-slate-500">Records logged under your verified citizen account</p>
            </div>
            <button
              onClick={fetchCitizenData}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Refresh</span>
            </button>
          </div>

          {incidents.length === 0 ? (
            <p className="text-center py-6 text-xs text-slate-400 font-mono">No previous emergency incidents logged.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-50 text-slate-500 font-mono uppercase text-[10px] border-b border-slate-200">
                  <tr>
                    <th className="py-2.5 px-3">ID</th>
                    <th className="py-2.5 px-3">Triage</th>
                    <th className="py-2.5 px-3">Chief Complaint</th>
                    <th className="py-2.5 px-3">Location</th>
                    <th className="py-2.5 px-3">Status</th>
                    <th className="py-2.5 px-3">Date</th>
                    <th className="py-2.5 px-3">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {incidents.map((inc) => (
                    <tr
                      key={inc.id}
                      onClick={() => setSelectedIncident(inc)}
                      className={`hover:bg-slate-50/80 transition cursor-pointer ${
                        selectedIncident?.id === inc.id ? "bg-blue-50/50" : ""
                      }`}
                    >
                      <td className="py-3 px-3 font-mono font-bold text-slate-700">#{inc.id}</td>
                      <td className="py-3 px-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                            inc.triage_color === "RED"
                              ? "bg-red-50 text-red-700 border border-red-200"
                              : inc.triage_color === "YELLOW"
                              ? "bg-amber-50 text-amber-700 border border-amber-200"
                              : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          }`}
                        >
                          {inc.triage_level}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-semibold text-slate-900 max-w-[200px] truncate">
                        {inc.chief_complaint}
                      </td>
                      <td className="py-3 px-3 text-slate-600 max-w-[180px] truncate">{inc.location_address}</td>
                      <td className="py-3 px-3">
                        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-bold">
                          {inc.status}
                        </span>
                      </td>
                      <td className="py-3 px-3 font-mono text-[11px] text-slate-500">
                        {new Date(inc.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </td>
                      <td className="py-3 px-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedIncident(inc);
                          }}
                          className="px-2.5 py-1 rounded-md bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-bold transition"
                        >
                          Track
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* Emergency Request Modal */}
      {showEmergencyModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="w-5 h-5" />
                <h3 className="font-bold text-base text-slate-900">Request Emergency SOS</h3>
              </div>
              <button
                onClick={() => setShowEmergencyModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            {errorMessage && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 font-medium">
                {errorMessage}
              </div>
            )}

            <form onSubmit={handleReportEmergency} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">Chief Medical Complaint / Symptoms *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Severe crushing chest pain radiating to left arm, difficulty breathing"
                  value={complaint}
                  onChange={(e) => setComplaint(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-red-500 text-xs"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-700 font-bold mb-1">Caller Contact Name *</label>
                  <input
                    type="text"
                    required
                    value={callerName}
                    onChange={(e) => setCallerName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                  />
                </div>
                <div>
                  <label className="block text-slate-700 font-bold mb-1">Callback Phone Number *</label>
                  <input
                    type="text"
                    required
                    value={callerPhone}
                    onChange={(e) => setCallerPhone(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">Emergency Scene Address (Mangaluru) *</label>
                <input
                  type="text"
                  required
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                />
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <span className="font-bold text-slate-700 block">Critical Triage Questions</span>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={chestPain}
                    onChange={(e) => setChestPain(e.target.checked)}
                    className="rounded border-slate-300 text-red-600"
                  />
                  <span>Patient is experiencing active chest pain or cardiac pressure</span>
                </label>

                <div>
                  <label className="block text-slate-600 text-[11px] mb-1">Breathing Condition:</label>
                  <select
                    value={breathingStatus}
                    onChange={(e) => setBreathingStatus(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs"
                  >
                    <option value="Normal">Normal breathing</option>
                    <option value="Compromised">Compromised / Shortness of breath</option>
                    <option value="Severely Compromised">Severely Compromised / Gasping</option>
                    <option value="Apnea">Not breathing / Respiratory arrest</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setShowEmergencyModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 font-bold hover:bg-slate-200 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold shadow-md shadow-red-600/20 transition flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{isSubmitting ? "Dispatching..." : "Transmit Emergency Alert"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Witness Report Modal */}
      {showWitnessModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2 text-indigo-600">
                <Eye className="w-5 h-5" />
                <h3 className="font-bold text-base text-slate-900">Submit Eyewitness Report</h3>
              </div>
              <button
                onClick={() => setShowWitnessModal(false)}
                className="text-slate-400 hover:text-slate-600 font-bold text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-500">
              Provide additional eyewitness observations on a nearby incident to assist Regional Dispatch in verifying severity.
            </p>

            <form onSubmit={handleSubmitWitness} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 font-bold mb-1">Incident Type</label>
                <select
                  value={witnessType}
                  onChange={(e) => setWitnessType(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs"
                >
                  <option value="Road Traffic Accident">Road Traffic Accident</option>
                  <option value="Cardiac Arrest">Cardiac Arrest / Collapse</option>
                  <option value="Building Fire">Building Fire / Smoke Inhalation</option>
                  <option value="Fall / Industrial Injury">Fall / Industrial Injury</option>
                  <option value="Other Medical">Other Medical</option>
                </select>
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">Location Details</label>
                <input
                  type="text"
                  required
                  value={witnessLocation}
                  onChange={(e) => setWitnessLocation(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs"
                />
              </div>

              <div>
                <label className="block text-slate-700 font-bold mb-1">What did you observe? *</label>
                <textarea
                  rows={3}
                  required
                  placeholder="Describe number of victims, vehicles involved, bleeding, hazard level..."
                  value={witnessDesc}
                  onChange={(e) => setWitnessDesc(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-xs"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setShowWitnessModal(false)}
                  className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 font-bold hover:bg-slate-200 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold transition flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{isSubmitting ? "Submitting..." : "Submit Witness Intelligence"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
