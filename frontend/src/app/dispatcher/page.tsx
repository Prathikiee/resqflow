"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
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
  Users,
  Link2,
  Split,
  ChevronRight,
  Shield,
  History,
  LayoutDashboard,
  Search,
  Check,
  X,
  LogOut,
  RefreshCw,
  ExternalLink,
  Navigation,
} from "lucide-react";
import DynamicCommandCenterMap from "@/components/MapWrapper";
import IncidentRegistrationModal from "@/components/IncidentRegistrationModal";
import AllocationModal from "@/components/AllocationModal";
import UnifiedTimelinePanel from "@/components/UnifiedTimelinePanel";
import { formatDistance, formatDuration } from "@/lib/utils";

type InspectorTab = "overview" | "dispatch" | "escalation" | "witness" | "timeline";

export default function DispatcherCommandCenterPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");

  // Core Operational State
  const [incidents, setIncidents] = useState<any[]>([]);
  const [ambulances, setAmbulances] = useState<any[]>([]);
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [dispatches, setDispatches] = useState<any[]>([]);
  const [witnessReports, setWitnessReports] = useState<any[]>([]);

  const [selectedIncident, setSelectedIncident] = useState<any | null>(null);
  const [recommendations, setRecommendations] = useState<any | null>(null);
  const [activeRouteGeometry, setActiveRouteGeometry] = useState<number[][]>([]);

  // Modals & UI Controls
  const [isRegistrationOpen, setIsRegistrationOpen] = useState(false);
  const [isAllocationOpen, setIsAllocationOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [wsConnected, setWsConnected] = useState(false);
  const [notifications, setNotifications] = useState<string[]>([]);

  // In-flight guard for lifecycle stepping
  const isSteppingLifecycleRef = useRef(false);
  const [isSteppingLifecycle, setIsSteppingLifecycle] = useState(false);

  // Reservation countdown tracking
  const [reservationRemainingSeconds, setReservationRemainingSeconds] = useState<number | null>(null);
  const latestServerDateRef = useRef<string | null>(null);
  const serverClockOffsetRef = useRef<number>(0);
  const processedEventsRef = useRef<Set<string>>(new Set());

  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const addNotification = (msg: string) => {
    setNotifications((prev) => [msg, ...prev.slice(0, 4)]);
  };

  // Calculate remaining reservation TTL based on server timestamps
  const calculateRemainingSeconds = useCallback((disp: any, serverDateStr?: string | null): number => {
    if (!disp?.reservation_expires_at) return 0;
    const expiresMs = new Date(disp.reservation_expires_at).getTime();
    if (isNaN(expiresMs)) return 0;

    if (serverDateStr) {
      const serverNowMs = new Date(serverDateStr).getTime();
      if (!isNaN(serverNowMs)) {
        return Math.max(0, Math.floor((expiresMs - serverNowMs) / 1000));
      }
    }

    if (serverClockOffsetRef.current !== 0) {
      const estimatedServerNow = Date.now() + serverClockOffsetRef.current;
      return Math.max(0, Math.floor((expiresMs - estimatedServerNow) / 1000));
    }

    if (disp.dispatched_at) {
      const dispatchedMs = new Date(disp.dispatched_at).getTime();
      if (!isNaN(dispatchedMs) && expiresMs > dispatchedMs) {
        const totalTtl = Math.floor((expiresMs - dispatchedMs) / 1000);
        return Math.max(0, totalTtl);
      }
    }

    return Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
  }, []);

  // Fetch all core operational data
  const fetchData = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) {
      router.push("/login");
      return;
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

    try {
      // 1. Verify user profile & role
      if (!user) {
        const meRes = await fetch(`${backendUrl}/api/auth/me`, { headers });
        if (meRes.ok) {
          const u = await meRes.json();
          setUser(u);
          if (u.role === "CITIZEN") {
            router.push("/citizen");
            return;
          } else if (u.role === "AMBULANCE_CREW") {
            router.push("/ambulance");
            return;
          } else if (u.role === "HOSPITAL_STAFF") {
            router.push("/hospital");
            return;
          }
        } else {
          router.push("/login");
          return;
        }
      }

      // 2. Fetch active operational collections
      const [incRes, ambRes, hospRes, dispRes, witRes] = await Promise.all([
        fetch(`${backendUrl}/api/incidents`, { headers }),
        fetch(`${backendUrl}/api/ambulances`, { headers }),
        fetch(`${backendUrl}/api/hospitals`, { headers }),
        fetch(`${backendUrl}/api/dispatch`, { headers }),
        fetch(`${backendUrl}/api/witness-reports`, { headers }),
      ]);

      const serverDateHeader = dispRes.headers.get("date");
      if (serverDateHeader) {
        latestServerDateRef.current = serverDateHeader;
        const parsedServerMs = new Date(serverDateHeader).getTime();
        if (!isNaN(parsedServerMs)) {
          serverClockOffsetRef.current = parsedServerMs - Date.now();
        }
      }

      if (incRes.ok) {
        const incData = await incRes.json();
        setIncidents(incData);
        if (!selectedIncident && incData.length > 0) {
          setSelectedIncident(incData[0]);
        }
      }
      if (ambRes.ok) setAmbulances(await ambRes.json());
      if (hospRes.ok) setHospitals(await hospRes.json());
      if (dispRes.ok) setDispatches(await dispRes.json());
      if (witRes.ok) setWitnessReports(await witRes.json());
    } catch (err) {
      console.error("Dispatcher data fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [backendUrl, router, user, selectedIncident]);

  // Initial mount & WebSocket subscription
  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 6000);

    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) return;

    const wsUrl = backendUrl.replace(/^http/, "ws") + `/ws/live?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    function connectWs() {
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => setWsConnected(true);
        ws.onclose = () => {
          setWsConnected(false);
          reconnectTimer = setTimeout(connectWs, 3000);
        };
        ws.onerror = () => ws?.close();
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.event_id) {
              if (processedEventsRef.current.has(data.event_id)) return;
              processedEventsRef.current.add(data.event_id);
            }
            if (data.event && data.event !== "PONG" && data.event !== "HANDSHAKE") {
              if (data.event === "INCIDENT_CREATED") {
                addNotification(`🚨 New Civilian Emergency Reported #${data.payload?.id || "SOS"}`);
              } else if (data.event === "DISPATCH_CONFIRMED") {
                addNotification(`Dual Confirmation Active for Dispatch #${data.payload?.id}`);
              } else if (data.event === "DISPATCH_CONFIRMATION_UPDATED") {
                addNotification(`Resource Confirmation: ${data.payload?.type || "Crew/Hospital"} confirmed`);
              } else if (data.event === "DISPATCH_STEPPED") {
                addNotification(`Mission Stage Updated: ${data.payload?.status}`);
              } else if (data.event === "HANDOVER_ACKNOWLEDGED") {
                addNotification(`Clinical Handover Acknowledged at Hospital ER`);
              }
              fetchData();
            }
          } catch (_) {}
        };
      } catch (_) {}
    }

    connectWs();

    return () => {
      clearInterval(interval);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [backendUrl, fetchData]);

  // Fetch allocation recommendations when selected incident changes
  useEffect(() => {
    if (!selectedIncident?.id) {
      setRecommendations(null);
      setActiveRouteGeometry([]);
      return;
    }

    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    fetch(`${backendUrl}/api/dispatch/recommendations/${selectedIncident.id}`, { headers })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setRecommendations(data);
        if (data?.route_geometry && Array.isArray(data.route_geometry)) {
          setActiveRouteGeometry(data.route_geometry);
        } else {
          setActiveRouteGeometry([]);
        }
      })
      .catch(() => {
        setRecommendations(null);
        setActiveRouteGeometry([]);
      });
  }, [selectedIncident, backendUrl]);

  // Match active dispatch for selected incident
  const currentDispatch = selectedIncident
    ? dispatches.find((d) => d.incident_id === selectedIncident.id && d.status !== "CANCELLED")
    : null;

  // Manage reservation countdown timer
  useEffect(() => {
    if (
      !currentDispatch ||
      currentDispatch.coordination_status !== "PENDING_CONFIRMATIONS" ||
      !currentDispatch.reservation_expires_at
    ) {
      setReservationRemainingSeconds(null);
      return;
    }

    const initialSecs = calculateRemainingSeconds(currentDispatch, latestServerDateRef.current);
    setReservationRemainingSeconds(initialSecs);

    const timer = setInterval(() => {
      const secs = calculateRemainingSeconds(currentDispatch, latestServerDateRef.current);
      setReservationRemainingSeconds(secs);
    }, 1000);

    return () => clearInterval(timer);
  }, [currentDispatch, calculateRemainingSeconds]);

  // Advance lifecycle stage handler
  const handleStepLifecycle = async (dispatchId: number) => {
    if (isSteppingLifecycleRef.current) return;
    isSteppingLifecycleRef.current = true;
    setIsSteppingLifecycle(true);

    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/step`, {
        method: "PATCH",
        headers,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to advance lifecycle");
      }
      await fetchData();
    } catch (err: any) {
      alert(`Lifecycle error: ${err.message}`);
    } finally {
      isSteppingLifecycleRef.current = false;
      setIsSteppingLifecycle(false);
    }
  };

  // Reassignment trigger handler
  const handleTriggerReassignment = async (dispatchId: number) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/reassign`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Reassignment failed");
      }
      addNotification(`Smart Escalation Reassignment triggered for Dispatch #${dispatchId}`);
      await fetchData();
    } catch (err: any) {
      alert(`Reassignment error: ${err.message}`);
    }
  };

  // Auto-allocate handler
  const handleAutoAllocate = async () => {
    if (!selectedIncident?.id) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/auto-allocate/${selectedIncident.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Auto-allocation failed");
      }
      addNotification(`Auto-allocated best ambulance & hospital for Incident #${selectedIncident.id}`);
      await fetchData();
    } catch (err: any) {
      alert(`Auto-allocation error: ${err.message}`);
    }
  };

  // Witness link/reject actions
  const handleLinkWitness = async (witnessReportId: number) => {
    if (!selectedIncident?.id) return;
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      const res = await fetch(
        `${backendUrl}/api/witness-reports/${witnessReportId}/link?incident_id=${selectedIncident.id}`,
        { method: "POST", headers }
      );
      if (res.ok) {
        addNotification(`Witness report #${witnessReportId} linked to Incident #${selectedIncident.id}`);
        await fetchData();
      }
    } catch (_) {}
  };

  const handleLogout = () => {
    localStorage.removeItem("lifelink_token");
    localStorage.removeItem("lifelink_user");
    document.cookie = "lifelink_token=; path=/; max-age=0;";
    router.push("/login");
  };

  // Filtered emergency list
  const filteredIncidents = incidents.filter((inc) => {
    if (statusFilter === "P1" && inc.triage_color !== "RED") return false;
    if (statusFilter === "ACTIVE" && (inc.status === "RESOLVED" || inc.status === "CLOSED")) return false;
    if (statusFilter === "UNASSIGNED" && inc.status !== "TRIAGED") return false;

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchComplaint = inc.chief_complaint?.toLowerCase().includes(q);
      const matchAddress = inc.location_address?.toLowerCase().includes(q);
      const matchId = String(inc.id).includes(q);
      return matchComplaint || matchAddress || matchId;
    }
    return true;
  });

  // Resource aggregates
  const availableAmbulances = ambulances.filter((a) => a.status === "AVAILABLE");
  const availableBeds = hospitals.reduce((sum, h) => sum + (h.available_emergency_beds || 0), 0);
  const reservedBeds = hospitals.reduce((sum, h) => sum + (h.reserved_emergency_beds || 0), 0);
  const pendingWitnessCount = witnessReports.filter((w) => !w.is_duplicate_verified && !w.linked_incident_id).length;

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex items-center gap-3 bg-white px-5 py-3 rounded-xl border border-slate-200 shadow-sm">
          <Activity className="w-5 h-5 text-red-600 animate-pulse" />
          <span className="text-xs font-semibold text-slate-700">Connecting to Regional Command HQ...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900 flex flex-col font-sans selection:bg-red-100 selection:text-red-900">
      {/* ============================================================== */}
      {/* 1. TOP OPERATIONAL COMMAND HEADER                              */}
      {/* ============================================================== */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur px-5 py-2.5 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-40 shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-red-600 flex items-center justify-center text-white shadow-md shadow-red-600/20">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black tracking-tight text-slate-900">LIFELINK</h1>
              <span className="text-xs font-semibold text-slate-400">/ Regional Command HQ</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 font-bold uppercase">
                Dispatcher Console
              </span>
            </div>
            <p className="text-[11px] text-slate-500 font-mono">
              Officer: <strong className="text-slate-800">{user?.full_name || "Regional Dispatcher"}</strong> • Corridor: Mangaluru Metro
            </p>
          </div>
        </div>

        {/* Live Resource Counters & System Actions */}
        <div className="flex items-center gap-2.5">
          {/* Active ALS Available Pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-xs font-mono">
            <Ambulance className="w-3.5 h-3.5 text-blue-600" />
            <span className="text-slate-500 text-[11px]">ALS Ready:</span>
            <strong className="text-blue-900 font-bold">{availableAmbulances.length}</strong>
          </div>

          {/* Emergency Beds Pill */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-mono">
            <Building2 className="w-3.5 h-3.5 text-emerald-600" />
            <span className="text-slate-500 text-[11px]">Vacant ER Bays:</span>
            <strong className="text-emerald-900 font-bold">{availableBeds}</strong>
            <span className="text-slate-400 text-[10px]">({reservedBeds} res)</span>
          </div>

          {/* Pending Witness Alert */}
          {pendingWitnessCount > 0 && (
            <button
              onClick={() => setInspectorTab("witness")}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-xs font-mono font-bold animate-pulse cursor-pointer shadow-2xs"
              title="Unreviewed witness reports detected"
            >
              <Users className="w-3.5 h-3.5 text-amber-600" />
              <span>{pendingWitnessCount} Witness Alert{pendingWitnessCount > 1 ? "s" : ""}</span>
            </button>
          )}

          {/* WebSocket Feed Pill */}
          <div
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono font-medium ${
              wsConnected ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200"
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${wsConnected ? "bg-emerald-500 animate-ping" : "bg-amber-500"}`} />
            <span className="text-[11px]">{wsConnected ? "GIS Feed Online" : "Reconnecting..."}</span>
          </div>

          {/* New Emergency Manual Intake Button */}
          <button
            onClick={() => setIsRegistrationOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-md shadow-red-600/20 transition cursor-pointer"
          >
            <FilePlus2 className="w-3.5 h-3.5" />
            <span>+ Manual SOS</span>
          </button>

          {/* Role Navigation Switcher */}
          <div className="hidden xl:flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs font-semibold">
            <button
              onClick={() => router.push("/ambulance")}
              className="px-2 py-0.5 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
            >
              Ambulance
            </button>
            <button
              onClick={() => router.push("/hospital")}
              className="px-2 py-0.5 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
            >
              Hospital
            </button>
            <button
              onClick={() => router.push("/citizen")}
              className="px-2 py-0.5 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
            >
              Citizen
            </button>
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-bold transition cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      {/* Real-Time Notification Ticker */}
      {notifications.length > 0 && (
        <div className="bg-slate-900 text-slate-200 px-5 py-1.5 text-xs font-mono flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center gap-2 truncate">
            <Activity className="w-3.5 h-3.5 text-emerald-400 animate-pulse shrink-0" />
            <span className="text-slate-400 font-bold uppercase text-[10px]">Real-time Telemetry:</span>
            <span className="truncate text-slate-100">{notifications[0]}</span>
          </div>
          <button onClick={() => setNotifications([])} className="text-slate-400 hover:text-white ml-2 text-[10px]">
            Dismiss
          </button>
        </div>
      )}

      {/* ============================================================== */}
      {/* 2. MAIN 3-COLUMN DISPATCHER COMMAND WORKSPACE                  */}
      {/* ============================================================== */}
      <div className="flex-1 p-3 grid grid-cols-1 lg:grid-cols-12 gap-3 overflow-hidden">
        {/* LEFT COLUMN: ACTIVE EMERGENCY QUEUE (3 Cols) */}
        <section className="lg:col-span-3 flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden shadow-2xs">
          {/* Queue Header & Filters */}
          <div className="p-3 border-b border-slate-200 bg-slate-50 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Radio className="w-4 h-4 text-red-600" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-800 font-mono">
                  Emergency Queue ({filteredIncidents.length})
                </h3>
              </div>
              <button
                onClick={fetchData}
                className="text-slate-400 hover:text-slate-700 transition"
                title="Refresh emergency data"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1 text-[11px] font-mono">
              {(["ALL", "P1", "ACTIVE", "UNASSIGNED"] as const).map((filterKey) => (
                <button
                  key={filterKey}
                  onClick={() => setStatusFilter(filterKey)}
                  className={`px-2 py-0.5 rounded transition ${
                    statusFilter === filterKey
                      ? "bg-slate-900 text-white font-bold"
                      : "bg-slate-200/70 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {filterKey}
                </button>
              ))}
            </div>

            {/* Search Input */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
              <input
                type="text"
                placeholder="Search complaint, address..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white border border-slate-200 rounded-lg pl-8 pr-2.5 py-1 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Scrollable Incident List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-2 max-h-[calc(100vh-180px)]">
            {filteredIncidents.length === 0 ? (
              <div className="text-center py-8 text-xs text-slate-400 font-mono">
                No emergencies match criteria.
              </div>
            ) : (
              filteredIncidents.map((inc) => {
                const isSelected = selectedIncident?.id === inc.id;
                const incDispatch = dispatches.find((d) => d.incident_id === inc.id && d.status !== "CANCELLED");

                return (
                  <div
                    key={inc.id}
                    onClick={() => setSelectedIncident(inc)}
                    className={`p-3 rounded-xl border transition cursor-pointer space-y-1.5 ${
                      isSelected
                        ? "bg-red-50/60 border-red-500 shadow-sm ring-1 ring-red-500"
                        : "bg-white border-slate-200 hover:border-slate-300 shadow-2xs"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs font-bold text-slate-900">#{inc.id}</span>
                        <span
                          className={`text-[9px] font-black uppercase px-1.5 py-0.2 rounded font-mono ${
                            inc.triage_color === "RED"
                              ? "bg-red-100 text-red-800"
                              : inc.triage_color === "YELLOW"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-emerald-100 text-emerald-800"
                          }`}
                        >
                          {inc.triage_level}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono font-bold text-blue-700 bg-blue-50 px-1.5 py-0.2 rounded">
                        {inc.status}
                      </span>
                    </div>

                    <p className="text-xs font-semibold text-slate-800 line-clamp-2 leading-snug">
                      {inc.chief_complaint}
                    </p>

                    <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono pt-1 border-t border-slate-100">
                      <span className="truncate max-w-[160px]">{inc.location_address}</span>
                      {incDispatch && (
                        <span className="text-blue-600 font-bold">
                          {incDispatch.ambulance_call_sign || "Dispatched"}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* CENTER COLUMN: INTERACTIVE GIS MAP (5 Cols) */}
        <section className="lg:col-span-5 flex flex-col rounded-xl overflow-hidden border border-slate-200 bg-white shadow-2xs min-h-[450px]">
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

        {/* RIGHT COLUMN: SELECTED INCIDENT DETAILS & DUAL CONFIRMATION CONTROLS (4 Cols) */}
        <section className="lg:col-span-4 flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden shadow-2xs max-h-[calc(100vh-120px)]">
          {selectedIncident ? (
            <>
              {/* Incident Header Banner */}
              <div className="p-3.5 border-b border-slate-200 bg-slate-50 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-slate-800 uppercase font-mono">
                      Incident #{selectedIncident.id}
                    </span>
                    <span
                      className={`text-[9px] font-black px-2 py-0.5 rounded font-mono ${
                        selectedIncident.triage_color === "RED"
                          ? "bg-red-100 text-red-800"
                          : selectedIncident.triage_color === "YELLOW"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-emerald-100 text-emerald-800"
                      }`}
                    >
                      {selectedIncident.triage_level}
                    </span>
                  </div>
                  <span className="text-xs font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                    {selectedIncident.status}
                  </span>
                </div>

                <h4 className="text-xs font-bold text-slate-900 leading-snug">
                  {selectedIncident.chief_complaint}
                </h4>

                <div className="flex items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                  <MapPin className="w-3.5 h-3.5 text-red-500 shrink-0" />
                  <span className="truncate">{selectedIncident.location_address}</span>
                </div>
              </div>

              {/* Inspector Tab Switcher */}
              <div className="flex items-center border-b border-slate-200 bg-white px-2 overflow-x-auto text-xs font-semibold text-slate-600">
                {(["overview", "dispatch", "escalation", "witness", "timeline"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setInspectorTab(tab)}
                    className={`px-3 py-2 border-b-2 transition capitalize whitespace-nowrap cursor-pointer ${
                      inspectorTab === tab
                        ? "border-red-600 text-red-600 font-bold"
                        : "border-transparent hover:text-slate-900"
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {/* Tab Contents Scrollable Body */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
                {/* 1. OVERVIEW TAB */}
                {inspectorTab === "overview" && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-2 text-slate-700">
                      <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                        <span className="text-[10px] text-slate-400 block font-mono">Caller Name</span>
                        <strong className="text-slate-900 font-medium">{selectedIncident.caller_name}</strong>
                      </div>
                      <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                        <span className="text-[10px] text-slate-400 block font-mono">Callback Phone</span>
                        <strong className="text-slate-900 font-mono">{selectedIncident.caller_phone}</strong>
                      </div>
                      <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                        <span className="text-[10px] text-slate-400 block font-mono">Patient Demographics</span>
                        <strong className="text-slate-900">
                          {selectedIncident.patient_age ? `${selectedIncident.patient_age}y` : "Age N/A"} •{" "}
                          {selectedIncident.patient_gender || "Unknown"}
                        </strong>
                      </div>
                      <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                        <span className="text-[10px] text-slate-400 block font-mono">Required Vehicle</span>
                        <strong className="text-red-700 font-mono font-bold">
                          {selectedIncident.required_ambulance_type || "ALS"}
                        </strong>
                      </div>
                    </div>

                    {/* Triage Justifications */}
                    {selectedIncident.triage_justifications && selectedIncident.triage_justifications.length > 0 && (
                      <div className="p-3 bg-red-50/50 rounded-xl border border-red-200 space-y-1.5">
                        <span className="text-[10px] font-mono font-bold text-red-800 uppercase block">
                          Triage Assessment Rationale
                        </span>
                        <ul className="space-y-1 text-slate-700 text-[11px]">
                          {selectedIncident.triage_justifications.map((j: string, idx: number) => (
                            <li key={idx} className="flex items-start gap-1.5">
                              <span className="text-red-600 font-bold">•</span>
                              <span>{j}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* 2. DISPATCH & DUAL CONFIRMATION TAB */}
                {inspectorTab === "dispatch" && (
                  <div className="space-y-4">
                    {currentDispatch ? (
                      <div className="space-y-3.5">
                        {/* Dual Confirmation Status Banner */}
                        <div
                          className={`p-3.5 rounded-xl border space-y-2 ${
                            currentDispatch.coordination_status === "CONFIRMED"
                              ? "bg-emerald-50 border-emerald-300 text-emerald-950"
                              : "bg-amber-50 border-amber-300 text-amber-950"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
                              Dispatch #{currentDispatch.id} (Attempt #{currentDispatch.attempt_number})
                            </span>
                            <span
                              className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold ${
                                currentDispatch.coordination_status === "CONFIRMED"
                                  ? "bg-emerald-200 text-emerald-900"
                                  : "bg-amber-200 text-amber-900"
                              }`}
                            >
                              {currentDispatch.coordination_status}
                            </span>
                          </div>

                          {/* Dual Accept / Reject Progress */}
                          <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                            <div className="p-2 bg-white rounded-lg border border-slate-200 space-y-1">
                              <span className="text-[10px] text-slate-400 block font-mono">Ambulance Crew:</span>
                              <strong className="text-slate-900 block truncate">
                                {currentDispatch.ambulance_call_sign || "Assigned Unit"}
                              </strong>
                              <span
                                className={`text-[10px] font-mono font-bold ${
                                  currentDispatch.ambulance_confirmation_status === "ACCEPTED"
                                    ? "text-emerald-700"
                                    : currentDispatch.ambulance_confirmation_status === "REJECTED"
                                    ? "text-red-700"
                                    : "text-amber-700"
                                }`}
                              >
                                {currentDispatch.ambulance_confirmation_status}
                              </span>
                            </div>

                            <div className="p-2 bg-white rounded-lg border border-slate-200 space-y-1">
                              <span className="text-[10px] text-slate-400 block font-mono">Hospital ER:</span>
                              <strong className="text-slate-900 block truncate">
                                {currentDispatch.destination_hospital_name}
                              </strong>
                              <span
                                className={`text-[10px] font-mono font-bold ${
                                  currentDispatch.hospital_confirmation_status === "ACCEPTED"
                                    ? "text-emerald-700"
                                    : currentDispatch.hospital_confirmation_status === "REJECTED"
                                    ? "text-red-700"
                                    : "text-amber-700"
                                }`}
                              >
                                {currentDispatch.hospital_confirmation_status}
                              </span>
                            </div>
                          </div>

                          {/* 90s Reservation TTL Countdown */}
                          {reservationRemainingSeconds !== null && (
                            <div className="flex items-center justify-between pt-1 text-xs font-mono">
                              <span className="text-slate-600">Dual Confirmation TTL Window:</span>
                              <strong className="text-amber-900 font-bold">
                                {reservationRemainingSeconds}s remaining
                              </strong>
                            </div>
                          )}
                        </div>

                        {/* Lifecycle Stepper for Dispatcher Oversight */}
                        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono font-bold text-slate-700 uppercase">
                              Mission Operational Stage:
                            </span>
                            <span className="font-mono text-xs font-bold text-blue-700">
                              {currentDispatch.status}
                            </span>
                          </div>

                          {currentDispatch.status !== "COMPLETED" && (
                            <button
                              onClick={() => handleStepLifecycle(currentDispatch.id)}
                              disabled={isSteppingLifecycle}
                              className="w-full py-2 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs transition cursor-pointer flex items-center justify-center gap-1.5 shadow-xs"
                            >
                              <Navigation className="w-3.5 h-3.5" />
                              <span>{isSteppingLifecycle ? "Advancing..." : `Advance Mission Stage &rarr;`}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-6 space-y-3">
                        <p className="text-xs text-slate-500">
                          No active resource allocation. Click below to auto-assign optimal resources or open manual allocation.
                        </p>
                        <div className="flex flex-wrap items-center justify-center gap-2">
                          <button
                            onClick={handleAutoAllocate}
                            className="px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-md transition cursor-pointer flex items-center gap-1.5"
                          >
                            <Zap className="w-4 h-4" />
                            <span>⚡ Auto-Allocate Best Resources</span>
                          </button>
                          <button
                            onClick={() => setIsAllocationOpen(true)}
                            className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-xs shadow-md shadow-red-600/20 transition cursor-pointer flex items-center gap-2"
                          >
                            <Sliders className="w-4 h-4" />
                            <span>Manual Allocation</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 3. ESCALATION TAB */}
                {inspectorTab === "escalation" && (
                  <div className="space-y-3.5">
                    <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                      <span className="text-[10px] font-mono font-bold text-slate-700 uppercase block">
                        Smart Escalation & Failover State
                      </span>
                      <p className="text-slate-600 text-[11px] leading-relaxed">
                        Automatic timeout sweeps occur every 90 seconds. If an assigned paramedic unit or hospital declines or fails to confirm, ResQFlow releases the reservation and promotes the next optimal candidate.
                      </p>

                      {currentDispatch && (
                        <div className="pt-2">
                          <button
                            onClick={() => handleTriggerReassignment(currentDispatch.id)}
                            className="w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs transition flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Trigger Immediate Smart Reassignment</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 4. WITNESS REPORT LINKING TAB */}
                {inspectorTab === "witness" && (
                  <div className="space-y-3">
                    <span className="text-[10px] font-mono font-bold text-slate-700 uppercase block">
                      Eyewitness Deduplication Feed
                    </span>

                    {witnessReports.length === 0 ? (
                      <p className="text-center py-6 text-slate-400 font-mono">No witness reports registered.</p>
                    ) : (
                      <div className="space-y-2">
                        {witnessReports.map((wit) => {
                          const isLinked = wit.linked_incident_id === selectedIncident.id;

                          return (
                            <div
                              key={wit.id}
                              className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                                isLinked ? "bg-emerald-50 border-emerald-300" : "bg-slate-50 border-slate-200"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-mono text-[10px] font-bold text-slate-800">
                                  Witness #{wit.id} • {wit.reporter_identifier}
                                </span>
                                {isLinked ? (
                                  <span className="text-[9px] font-mono bg-emerald-200 text-emerald-900 px-1.5 py-0.2 rounded font-bold">
                                    LINKED
                                  </span>
                                ) : (
                                  <button
                                    onClick={() => handleLinkWitness(wit.id)}
                                    className="text-[10px] font-bold text-blue-600 hover:text-blue-800"
                                  >
                                    Link to #{selectedIncident.id} &rarr;
                                  </button>
                                )}
                              </div>
                              <p className="text-slate-700 text-[11px]">{wit.incident_description}</p>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {/* 5. UNIFIED TIMELINE TAB */}
                {inspectorTab === "timeline" && (
                  <div className="space-y-2">
                    <UnifiedTimelinePanel incidentId={selectedIncident.id} backendUrl={backendUrl} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="p-8 text-center text-xs text-slate-400 font-mono">
              Select an incident from the queue or map to inspect operational controls.
            </div>
          )}
        </section>
      </div>

      {/* ============================================================== */}
      {/* 3. MODALS: NEW INCIDENT REGISTRATION & RESOURCE ALLOCATION     */}
      {/* ============================================================== */}
      {isRegistrationOpen && (
        <IncidentRegistrationModal
          isOpen={isRegistrationOpen}
          onClose={() => setIsRegistrationOpen(false)}
          onIncidentCreated={(newInc) => {
            setSelectedIncident(newInc);
            fetchData();
          }}
        />
      )}

      {isAllocationOpen && selectedIncident && recommendations && (
        <AllocationModal
          isOpen={isAllocationOpen}
          onClose={() => setIsAllocationOpen(false)}
          incident={selectedIncident}
          recommendations={recommendations}
          onDispatchConfirmed={() => {
            fetchData();
            setInspectorTab("dispatch");
          }}
        />
      )}
    </div>
  );
}
