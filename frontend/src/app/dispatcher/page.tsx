"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
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
  FilePlus2,
  FileText,
  Filter,
  History,
  Layers,
  LayoutDashboard,
  Link2,
  LogOut,
  MapPin,
  Navigation,
  Phone,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Shield,
  ShieldAlert,
  Sliders,
  Sparkles,
  Split,
  User,
  Users,
  X,
  Zap,
} from "lucide-react";
import DynamicCommandCenterMap from "@/components/MapWrapper";
import IncidentRegistrationModal from "@/components/IncidentRegistrationModal";
import AllocationModal from "@/components/AllocationModal";
import UnifiedTimelinePanel from "@/components/UnifiedTimelinePanel";
import Sidebar, { NavItem } from "@/components/layout/Sidebar";
import TopNav from "@/components/layout/TopNav";
import { formatDistance, formatDuration } from "@/lib/utils";

type InspectorTab = "overview" | "dispatch" | "escalation" | "witness" | "timeline";

export default function DispatcherCommandCenterPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [currentNav, setCurrentNav] = useState<string>("overview");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
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

  // WebSocket Subscription
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

  // Fetch allocation recommendations
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

  const currentDispatch = selectedIncident
    ? dispatches.find((d) => d.incident_id === selectedIncident.id && d.status !== "CANCELLED")
    : null;

  // Reservation countdown
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

  // Handlers
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

  const handleSeedReset = async () => {
    if (!confirm("Reset database to clean Mangaluru demonstration state?")) return;
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
      const res = await fetch(`${backendUrl}/api/seed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.ok) {
        alert("Database successfully reset and seeded!");
        await fetchData();
      }
    } catch (e) {
      alert("Reset error: " + e);
    }
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

  const activeIncidentsCount = incidents.filter((i) => i.status !== "RESOLVED" && i.status !== "CLOSED").length;
  const availableAmbulances = ambulances.filter((a) => a.status === "AVAILABLE");

  // Sidebar navigation items
  const sidebarNavItems: NavItem[] = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "queue", label: "Emergency Queue", icon: Radio, count: activeIncidentsCount },
    { id: "map", label: "Live Tactical Map", icon: MapPin },
    { id: "ambulances", label: "Ambulances", icon: Ambulance, count: availableAmbulances.length },
    { id: "hospitals", label: "Hospitals", icon: Building2, count: hospitals.length },
    { id: "history", label: "Incident History", icon: History },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-red-600" />
          <span className="text-xs font-bold text-slate-700">Connecting to Regional Command HQ...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex font-sans">
      {/* 1. LEFT SIDEBAR */}
      <Sidebar
        role="DISPATCHER"
        roleLabel="Regional Dispatcher"
        user={user}
        currentNav={currentNav}
        onNavChange={setCurrentNav}
        navItems={sidebarNavItems}
        isOpenMobile={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
        onLogout={handleLogout}
        entityName="Mangaluru Command HQ"
      />

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0">
        {/* Top Minimal Navigation */}
        <TopNav
          title="Emergency Dispatch Console"
          subtitle="Real-time multi-agency coordination • Mangaluru District"
          wsConnected={wsConnected}
          onMenuToggle={() => setIsMobileMenuOpen(true)}
          actions={
            <>
              <button
                onClick={() => setIsRegistrationOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-2xs"
              >
                <FilePlus2 className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New Incident</span>
              </button>
              <button
                onClick={handleSeedReset}
                className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition"
                title="Reset Database to Demonstration State"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </>
          }
        />

        {/* Notifications Bar */}
        {notifications.length > 0 && (
          <div className="bg-blue-50 border-b border-blue-100 px-4 py-2 flex items-center justify-between text-xs text-blue-900">
            <div className="flex items-center gap-2 truncate">
              <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
              <span className="font-semibold">{notifications[0]}</span>
            </div>
            <button
              onClick={() => setNotifications([])}
              className="text-blue-600 hover:text-blue-800 text-[11px] font-bold shrink-0 ml-2"
            >
              Clear
            </button>
          </div>
        )}

        {/* PAGE CONTENT SWITCHER */}
        <main className="flex-1 p-4 sm:p-6 overflow-x-hidden">
          {/* ============================================================== */}
          {/* VIEW: OVERVIEW (Default Two-Column Workspace)                   */}
          {/* ============================================================== */}
          {currentNav === "overview" && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* LEFT COLUMN: ACTIVE EMERGENCY QUEUE & SELECTED INSPECTOR (5 cols) */}
              <div className="lg:col-span-5 space-y-4 flex flex-col">
                {/* Search & Filter Bar */}
                <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs space-y-2.5">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search by ID, complaint, or location..."
                      className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
                    {[
                      { id: "ALL", label: "All" },
                      { id: "P1", label: "Critical P1" },
                      { id: "ACTIVE", label: "Active Only" },
                      { id: "UNASSIGNED", label: "Unassigned" },
                    ].map((tab) => (
                      <button
                        key={tab.id}
                        onClick={() => setStatusFilter(tab.id)}
                        className={`px-2.5 py-1 rounded-md text-xs font-semibold whitespace-nowrap transition ${
                          statusFilter === tab.id
                            ? "bg-slate-900 text-white"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Compact Incident Queue List */}
                <div className="bg-white border border-slate-200 rounded-xl shadow-2xs divide-y divide-slate-100 max-h-[380px] overflow-y-auto">
                  {filteredIncidents.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      No active emergency incidents match filter.
                    </div>
                  ) : (
                    filteredIncidents.map((inc) => {
                      const isSelected = selectedIncident?.id === inc.id;
                      const isCritical = inc.triage_color === "RED";
                      return (
                        <div
                          key={inc.id}
                          onClick={() => setSelectedIncident(inc)}
                          className={`p-3.5 transition cursor-pointer flex items-start justify-between gap-3 ${
                            isSelected
                              ? "bg-blue-50/70 border-l-4 border-l-blue-600"
                              : "hover:bg-slate-50"
                          }`}
                        >
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                                  isCritical
                                    ? "bg-red-50 text-red-700 border border-red-200"
                                    : "bg-amber-50 text-amber-700 border border-amber-200"
                                }`}
                              >
                                {inc.triage_level || "P1"}
                              </span>
                              <span className="text-xs font-bold text-slate-900">Incident #{inc.id}</span>
                              <span className="text-[10px] text-slate-400 font-mono">
                                {new Date(inc.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            </div>
                            <p className="text-xs text-slate-800 font-medium truncate">{inc.chief_complaint}</p>
                            <p className="text-[11px] text-slate-500 truncate flex items-center gap-1">
                              <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                              <span>{inc.location_address}</span>
                            </p>
                          </div>

                          <div className="text-right shrink-0">
                            <span
                              className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                                inc.status === "TRIAGED"
                                  ? "bg-red-50 text-red-700"
                                  : inc.status === "ALLOCATED"
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-emerald-50 text-emerald-700"
                              }`}
                            >
                              {inc.status}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* SELECTED INCIDENT DETAIL INSPECTOR PANEL */}
                {selectedIncident && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-4">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                      <div>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                          Selected Incident Inspector
                        </span>
                        <h3 className="text-sm font-bold text-slate-900">
                          #{selectedIncident.id} • {selectedIncident.caller_name} ({selectedIncident.caller_phone})
                        </h3>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {/* Auto-Allocate Trigger */}
                        <button
                          type="button"
                          onClick={handleAutoAllocate}
                          className="px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-1 shadow-2xs transition"
                          title="Automatically reserve best ambulance and hospital"
                        >
                          <Zap className="w-3.5 h-3.5" />
                          <span>⚡ Auto-Allocate</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsAllocationOpen(true)}
                          className="px-2.5 py-1 rounded-md border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center gap-1 transition"
                        >
                          <Sliders className="w-3.5 h-3.5 text-slate-500" />
                          <span>Manual</span>
                        </button>
                      </div>
                    </div>

                    {/* Active Dispatch & Dual-Confirmation Status */}
                    {currentDispatch ? (
                      <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-slate-900">
                            Dispatch #{currentDispatch.id} (Attempt #{currentDispatch.attempt_number})
                          </span>
                          <span
                            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                              currentDispatch.coordination_status === "CONFIRMED"
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {currentDispatch.coordination_status}
                          </span>
                        </div>

                        {/* Dual Acceptance Badges */}
                        <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                          <div className="p-2 rounded bg-white border border-slate-200 flex items-center justify-between">
                            <span className="text-slate-500 text-[11px]">Ambulance:</span>
                            <span
                              className={`font-bold ${
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
                          <div className="p-2 rounded bg-white border border-slate-200 flex items-center justify-between">
                            <span className="text-slate-500 text-[11px]">Hospital:</span>
                            <span
                              className={`font-bold ${
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

                        {/* 90-Second Reservation Timer */}
                        {reservationRemainingSeconds !== null && currentDispatch.coordination_status === "PENDING_CONFIRMATIONS" && (
                          <div className="flex items-center justify-between text-xs font-mono pt-1 text-amber-800">
                            <span className="flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5 animate-spin" />
                              <span>Dual Confirmation TTL:</span>
                            </span>
                            <span className="font-bold">{reservationRemainingSeconds}s remaining</span>
                          </div>
                        )}

                        {/* Lifecycle Stepping Controls for Testing */}
                        {currentDispatch.coordination_status === "CONFIRMED" && (
                          <div className="pt-2 flex items-center justify-between">
                            <span className="text-xs text-slate-500">
                              Mission Status: <strong className="text-slate-900">{currentDispatch.status}</strong>
                            </span>
                            {currentDispatch.status !== "COMPLETED" && (
                              <button
                                type="button"
                                onClick={() => handleStepLifecycle(currentDispatch.id)}
                                disabled={isSteppingLifecycle}
                                className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold flex items-center gap-1 transition"
                              >
                                <ChevronRight className="w-3.5 h-3.5" />
                                <span>Advance Lifecycle</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="p-3 rounded-lg bg-amber-50/60 border border-amber-200 text-xs text-amber-900 flex items-center justify-between">
                        <span>No fleet allocated yet. Tap <strong>⚡ Auto-Allocate</strong> to initiate dual confirmation.</span>
                      </div>
                    )}

                    {/* Inspector Sub-Tabs: Timeline / Witness / Recommendations */}
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center gap-1 border-b border-slate-200 pb-1">
                        <button
                          type="button"
                          onClick={() => setInspectorTab("overview")}
                          className={`px-2.5 py-1 rounded text-xs font-bold transition ${
                            inspectorTab === "overview"
                              ? "bg-slate-900 text-white"
                              : "text-slate-500 hover:text-slate-900"
                          }`}
                        >
                          Recommendation Reasoning
                        </button>
                        <button
                          type="button"
                          onClick={() => setInspectorTab("timeline")}
                          className={`px-2.5 py-1 rounded text-xs font-bold transition ${
                            inspectorTab === "timeline"
                              ? "bg-slate-900 text-white"
                              : "text-slate-500 hover:text-slate-900"
                          }`}
                        >
                          Audit Timeline
                        </button>
                      </div>

                      {inspectorTab === "overview" && recommendations && (
                        <div className="space-y-2 text-xs">
                          {recommendations.recommended_ambulance && (
                            <div className="p-2 rounded bg-slate-50 border border-slate-200 flex items-center justify-between">
                              <span>Recommended Unit:</span>
                              <strong className="text-blue-700">
                                {recommendations.recommended_ambulance.call_sign} ({recommendations.recommended_ambulance.vehicle_type})
                              </strong>
                            </div>
                          )}
                          {recommendations.recommended_hospital && (
                            <div className="p-2 rounded bg-slate-50 border border-slate-200 flex items-center justify-between">
                              <span>Recommended Facility:</span>
                              <strong className="text-emerald-700">
                                {recommendations.recommended_hospital.name}
                              </strong>
                            </div>
                          )}
                        </div>
                      )}

                      {inspectorTab === "timeline" && (
                        <div className="max-h-[220px] overflow-y-auto">
                          <UnifiedTimelinePanel incidentId={selectedIncident.id} backendUrl={backendUrl} />
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* RIGHT COLUMN: LARGE INTERACTIVE MAP (7 cols) */}
              <div className="lg:col-span-7 flex flex-col space-y-4">
                <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs flex-1 min-h-[540px] flex flex-col">
                  <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-100">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-red-600" />
                      <h3 className="text-sm font-bold text-slate-900">Mangaluru Regional Tactical GIS Map</h3>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      <span className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-red-600" /> Incidents ({incidents.length})
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-blue-600" /> Ambulances ({ambulances.length})
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-600" /> Hospitals ({hospitals.length})
                      </span>
                    </div>
                  </div>

                  {/* Map Component */}
                  <div className="flex-1 w-full rounded-lg overflow-hidden border border-slate-200 min-h-[460px]">
                    <DynamicCommandCenterMap
                      incidents={incidents}
                      ambulances={ambulances}
                      hospitals={hospitals}
                      selectedIncident={selectedIncident}
                      onSelectIncident={(inc: any) => setSelectedIncident(inc)}
                      activeRouteGeometry={activeRouteGeometry}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: EMERGENCY QUEUE FULL TABLE                               */}
          {/* ============================================================== */}
          {currentNav === "queue" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-slate-900">Regional Emergency Queue</h2>
                  <p className="text-xs text-slate-500">Live triage queue with multi-witness clustering and allocation tracking</p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase font-mono text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">ID</th>
                      <th className="py-2.5 px-3">Priority</th>
                      <th className="py-2.5 px-3">Caller & Location</th>
                      <th className="py-2.5 px-3">Complaint</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {incidents.map((inc) => (
                      <tr key={inc.id} className="hover:bg-slate-50 transition">
                        <td className="py-3 px-3 font-mono font-bold text-slate-900">#{inc.id}</td>
                        <td className="py-3 px-3">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded font-mono ${
                              inc.triage_color === "RED"
                                ? "bg-red-50 text-red-700 border border-red-200"
                                : "bg-amber-50 text-amber-700 border border-amber-200"
                            }`}
                          >
                            {inc.triage_level}
                          </span>
                        </td>
                        <td className="py-3 px-3">
                          <p className="font-bold text-slate-900">{inc.caller_name}</p>
                          <p className="text-slate-500 text-[11px] truncate max-w-xs">{inc.location_address}</p>
                        </td>
                        <td className="py-3 px-3 max-w-xs truncate text-slate-700">{inc.chief_complaint}</td>
                        <td className="py-3 px-3">
                          <span className="font-semibold text-slate-700 uppercase">{inc.status}</span>
                        </td>
                        <td className="py-3 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedIncident(inc);
                              setCurrentNav("overview");
                            }}
                            className="px-2.5 py-1 rounded bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: LIVE TACTICAL MAP EXPANDED                               */}
          {/* ============================================================== */}
          {currentNav === "map" && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3 min-h-[640px] flex flex-col">
              <h2 className="text-base font-bold text-slate-900">Live Tactical GIS Command Map</h2>
              <div className="flex-1 rounded-lg overflow-hidden border border-slate-200 min-h-[580px]">
                <DynamicCommandCenterMap
                  incidents={incidents}
                  ambulances={ambulances}
                  hospitals={hospitals}
                  selectedIncident={selectedIncident}
                  onSelectIncident={(inc: any) => setSelectedIncident(inc)}
                  activeRouteGeometry={activeRouteGeometry}
                />
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: AMBULANCES FLEET TABLE                                   */}
          {/* ============================================================== */}
          {currentNav === "ambulances" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <h2 className="text-base font-bold text-slate-900">Regional Ambulance Fleet</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase font-mono text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">Call Sign</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Base Station</th>
                      <th className="py-2.5 px-3">Fuel Level</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ambulances.map((amb) => (
                      <tr key={amb.id} className="hover:bg-slate-50 transition">
                        <td className="py-3 px-3 font-mono font-bold text-slate-900">{amb.call_sign}</td>
                        <td className="py-3 px-3 font-semibold text-blue-700">{amb.vehicle_type}</td>
                        <td className="py-3 px-3">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded font-mono ${
                              amb.status === "AVAILABLE"
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : amb.status === "MAINTENANCE"
                                ? "bg-slate-100 text-slate-700 border border-slate-300"
                                : "bg-amber-50 text-amber-700 border border-amber-200"
                            }`}
                          >
                            {amb.status}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-slate-600">{amb.base_station}</td>
                        <td className="py-3 px-3 font-mono font-bold">{amb.fuel_level_percent}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: HOSPITALS CAPACITY & READINESS TABLE                     */}
          {/* ============================================================== */}
          {currentNav === "hospitals" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <h2 className="text-base font-bold text-slate-900">Regional Receiving Hospitals & Capacity</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase font-mono text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">Facility Name</th>
                      <th className="py-2.5 px-3">Readiness</th>
                      <th className="py-2.5 px-3">ER Beds</th>
                      <th className="py-2.5 px-3">ICU Beds</th>
                      <th className="py-2.5 px-3">Ward Beds</th>
                      <th className="py-2.5 px-3">Contact</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {hospitals.map((hosp) => (
                      <tr key={hosp.id} className="hover:bg-slate-50 transition">
                        <td className="py-3 px-3 font-bold text-slate-900">{hosp.name}</td>
                        <td className="py-3 px-3">
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                              hosp.readiness_status === "DIVERT"
                                ? "bg-red-50 text-red-700 border border-red-200"
                                : hosp.readiness_status === "BUSY"
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            }`}
                          >
                            {hosp.readiness_status || "READY"}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-emerald-700">
                          {hosp.available_emergency_beds} / {hosp.total_emergency_beds}
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-blue-700">
                          {hosp.available_icu_beds} / {hosp.total_icu_beds}
                        </td>
                        <td className="py-3 px-3 font-mono">
                          {hosp.available_ward_beds ?? 15} / {hosp.total_ward_beds ?? 40}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-600">{hosp.contact_number}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW: INCIDENT HISTORY                                         */}
          {/* ============================================================== */}
          {currentNav === "history" && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <h2 className="text-base font-bold text-slate-900">Incident History & Closed Files</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-y border-slate-200 text-slate-600 uppercase font-mono text-[10px]">
                    <tr>
                      <th className="py-2.5 px-3">ID</th>
                      <th className="py-2.5 px-3">Date & Time</th>
                      <th className="py-2.5 px-3">Location</th>
                      <th className="py-2.5 px-3">Complaint</th>
                      <th className="py-2.5 px-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {incidents
                      .filter((i) => i.status === "RESOLVED" || i.status === "CLOSED")
                      .map((inc) => (
                        <tr key={inc.id} className="hover:bg-slate-50 transition">
                          <td className="py-3 px-3 font-mono font-bold text-slate-900">#{inc.id}</td>
                          <td className="py-3 px-3 font-mono text-slate-500">
                            {new Date(inc.created_at).toLocaleString()}
                          </td>
                          <td className="py-3 px-3 font-medium text-slate-700">{inc.location_address}</td>
                          <td className="py-3 px-3 text-slate-600">{inc.chief_complaint}</td>
                          <td className="py-3 px-3">
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
                              RESOLVED
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Manual Allocation Modal */}
      {isAllocationOpen && selectedIncident && (
        <AllocationModal
          isOpen={isAllocationOpen}
          onClose={() => setIsAllocationOpen(false)}
          incident={selectedIncident}
          recommendations={recommendations}
          onDispatchConfirmed={() => {
            setIsAllocationOpen(false);
            fetchData();
          }}
        />
      )}

      {/* Incident Registration Modal */}
      {isRegistrationOpen && (
        <IncidentRegistrationModal
          isOpen={isRegistrationOpen}
          onClose={() => setIsRegistrationOpen(false)}
          onIncidentCreated={(newInc) => {
            setIsRegistrationOpen(false);
            setSelectedIncident(newInc);
            fetchData();
          }}
        />
      )}
    </div>
  );
}
