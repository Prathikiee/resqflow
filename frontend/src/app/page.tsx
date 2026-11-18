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
  FileText,
  Eye,
  Users,
  Link2,
  Split,
  Stethoscope,
  ChevronRight,
  Shield,
  History,
  LayoutDashboard,
  Settings,
  Search,
  Fuel,
  Bed,
  LogIn,
} from "lucide-react";
import DynamicCommandCenterMap from "@/components/MapWrapper";
import IncidentRegistrationModal from "@/components/IncidentRegistrationModal";
import AllocationModal from "@/components/AllocationModal";
import HandoverModal from "@/components/HandoverModal";
import UnifiedTimelinePanel from "@/components/UnifiedTimelinePanel";
import { formatDistance, formatDuration } from "@/lib/utils";

type NavigationTab = "overview" | "emergencies" | "ambulances" | "hospitals" | "witnesses" | "history" | "settings";
type InspectorTab = "overview" | "dispatch" | "escalation" | "handover" | "witness" | "timeline";

export default function CommandCenterDashboard() {
  const [activeNav, setActiveNav] = useState<NavigationTab>("overview");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("overview");

  const [incidents, setIncidents] = useState<any[]>([]);
  const [ambulances, setAmbulances] = useState<any[]>([]);
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [dispatches, setDispatches] = useState<any[]>([]);
  const [witnessReports, setWitnessReports] = useState<any[]>([]);

  const [selectedIncident, setSelectedIncident] = useState<any | null>(null);
  const [recommendations, setRecommendations] = useState<any | null>(null);
  const [activeRouteGeometry, setActiveRouteGeometry] = useState<number[][]>([]);

  const [isRegistrationOpen, setIsRegistrationOpen] = useState(false);
  const [isAllocationOpen, setIsAllocationOpen] = useState(false);
  const [isHandoverModalOpen, setIsHandoverModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Task 1: Lifecycle double-click & in-flight submission guard
  const isSteppingLifecycleRef = React.useRef(false);
  const [isSteppingLifecycle, setIsSteppingLifecycle] = useState(false);

  // Task 2: Server-authoritative countdown tracking
  const [reservationRemainingSeconds, setReservationRemainingSeconds] = useState<number | null>(null);
  const latestServerDateRef = React.useRef<string | null>(null);
  const serverClockOffsetRef = React.useRef<number>(0);
  const countdownSyncRef = React.useRef<{
    dispatchId: number | null;
    remainingSecondsAtSync: number;
    syncMonotonicMs: number;
  }>({
    dispatchId: null,
    remainingSecondsAtSync: 0,
    syncMonotonicMs: 0,
  });

  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Calculate remaining reservation TTL based on server-authoritative timestamps
  const calculateRemainingSeconds = useCallback((disp: any, serverDateStr?: string | null): number => {
    if (!disp?.reservation_expires_at) return 0;
    const expiresMs = new Date(disp.reservation_expires_at).getTime();
    if (isNaN(expiresMs)) return 0;

    // 1. Authoritative: Use server HTTP Date header if available from backend response
    if (serverDateStr) {
      const serverNowMs = new Date(serverDateStr).getTime();
      if (!isNaN(serverNowMs)) {
        return Math.max(0, Math.floor((expiresMs - serverNowMs) / 1000));
      }
    }

    // 2. Authoritative offset: Use measured difference between server clock and client clock
    if (serverClockOffsetRef.current !== 0) {
      const estimatedServerNow = Date.now() + serverClockOffsetRef.current;
      return Math.max(0, Math.floor((expiresMs - estimatedServerNow) / 1000));
    }

    // 3. Fallback: Use backend dispatched_at timestamp (both dispatched_at and reservation_expires_at set by server)
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
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      const [incRes, ambRes, hospRes, dispRes, witRes] = await Promise.all([
        fetch(`${backendUrl}/api/incidents`, { headers }),
        fetch(`${backendUrl}/api/ambulances`, { headers }),
        fetch(`${backendUrl}/api/hospitals`, { headers }),
        fetch(`${backendUrl}/api/dispatch`, { headers }),
        fetch(`${backendUrl}/api/witness-reports`, { headers }),
      ]);

      // Server-authoritative time capture from HTTP Date header
      const serverDateHeader = dispRes.headers.get("date");
      if (serverDateHeader) {
        latestServerDateRef.current = serverDateHeader;
        const parsedServerMs = new Date(serverDateHeader).getTime();
        if (!isNaN(parsedServerMs)) {
          serverClockOffsetRef.current = parsedServerMs - Date.now();
        }
      }

      if (incRes.ok) setIncidents(await incRes.json());
      if (ambRes.ok) setAmbulances(await ambRes.json());
      if (hospRes.ok) setHospitals(await hospRes.json());
      if (dispRes.ok) setDispatches(await dispRes.json());
      if (witRes.ok) setWitnessReports(await witRes.json());
    } catch (err) {
      console.error("Failed to fetch operational data:", err);
    } finally {
      setLoading(false);
    }
  }, [backendUrl]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 6000);

    // Live WebSocket connection for instant event-driven synchronization
    const wsUrl = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000")
      .replace(/^http/, "ws") + "/ws/live";
    let ws: WebSocket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;

    function connectWs() {
      try {
        const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
        const targetWsUrl = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
        ws = new WebSocket(targetWsUrl);
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
    // Synchronous ref guard: blocks duplicate invocations before next React render tick
    if (isSteppingLifecycleRef.current) return;
    isSteppingLifecycleRef.current = true;
    setIsSteppingLifecycle(true);

    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/step`, {
        method: "PATCH",
      });

      if (!res.ok) {
        let errorDetail = "Failed to advance dispatch stage";
        try {
          const errJson = await res.json();
          if (errJson?.detail) errorDetail = errJson.detail;
        } catch (_) {}
        alert(`Lifecycle advancement error: ${errorDetail}`);
        return;
      }

      // Update state exactly once after verified backend success
      await fetchData();
      if (selectedIncident?.id) {
        const updatedIncRes = await fetch(`${backendUrl}/api/incidents/${selectedIncident.id}`);
        if (updatedIncRes.ok) {
          setSelectedIncident(await updatedIncRes.json());
        }
      }
    } catch (err: any) {
      console.error("Step lifecycle error:", err);
      alert(`Network error advancing stage: ${err?.message || "Please check connection"}`);
    } finally {
      isSteppingLifecycleRef.current = false;
      setIsSteppingLifecycle(false);
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

  const handleAcknowledgeHandover = async (dispatchId: number) => {
    try {
      const res = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/handover/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acknowledged_by: "ER Triage Desk / Dr. Shenoy" }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Acknowledgment failed: ${err.detail || "Error"}`);
      }
      await fetchData();
    } catch (err: any) {
      console.error("Handover acknowledge error:", err);
    }
  };

  const handleLinkWitness = async (reportId: number, masterIncidentId: number) => {
    try {
      const res = await fetch(`${backendUrl}/api/witness-reports/${reportId}/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          master_incident_id: masterIncidentId,
          notes: `Dispatcher confirmed duplicate report of master incident #${masterIncidentId}.`,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Linking failed: ${err.detail || "Error"}`);
      }
      await fetchData();
    } catch (err: any) {
      console.error("Link witness error:", err);
    }
  };

  const handleMarkWitnessDistinct = async (reportId: number, promote: boolean = false) => {
    try {
      const res = await fetch(`${backendUrl}/api/witness-reports/${reportId}/mark-distinct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: "Dispatcher verified as an independent emergency incident.",
          promote_to_incident: promote,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Mark distinct failed: ${err.detail || "Error"}`);
      }
      await fetchData();
    } catch (err: any) {
      console.error("Mark distinct error:", err);
    }
  };

  const handleSimulateWitnessReport = async (incident: any) => {
    if (!incident) return;
    try {
      const res = await fetch(`${backendUrl}/api/witness-reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reporter_identifier: "Citizen Witness B (Demo)",
          incident_description: "Two-wheeler collided with vehicle, rider on road bleeding, traffic slowed down near junction.",
          incident_type: "Road Traffic Accident",
          latitude: incident.latitude + 0.0012,
          longitude: incident.longitude + 0.0009,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(`Simulate witness report failed: ${err.detail || "Error"}`);
      }
      await fetchData();
    } catch (err: any) {
      console.error("Simulate witness error:", err);
    }
  };

  // Find active dispatch for currently selected incident
  const currentDispatch = dispatches.find((d) => d.incident_id === selectedIncident?.id);
  const assignedAmbulance = ambulances.find((a) => a.id === currentDispatch?.ambulance_id);
  const assignedHospital = hospitals.find((h) => h.id === currentDispatch?.destination_hospital_id);
  const lastEscalation = currentDispatch?.escalation_history && currentDispatch.escalation_history.length > 0
    ? currentDispatch.escalation_history[currentDispatch.escalation_history.length - 1]
    : null;

  // Task 2: Synchronize countdown when current dispatch changes or new data arrives
  useEffect(() => {
    if (
      currentDispatch &&
      currentDispatch.coordination_status === "PENDING_CONFIRMATIONS" &&
      currentDispatch.reservation_expires_at
    ) {
      const remaining = calculateRemainingSeconds(currentDispatch, latestServerDateRef.current);
      countdownSyncRef.current = {
        dispatchId: currentDispatch.id,
        remainingSecondsAtSync: remaining,
        syncMonotonicMs: performance.now(),
      };
      setReservationRemainingSeconds(remaining);
    } else {
      countdownSyncRef.current = {
        dispatchId: null,
        remainingSecondsAtSync: 0,
        syncMonotonicMs: 0,
      };
      setReservationRemainingSeconds(null);
    }
  }, [currentDispatch, calculateRemainingSeconds]);

  // 1-second monotonic countdown interval (avoids polling server every second)
  useEffect(() => {
    const timer = setInterval(() => {
      const sync = countdownSyncRef.current;
      if (sync.dispatchId !== null && sync.remainingSecondsAtSync > 0) {
        const elapsedSeconds = Math.floor((performance.now() - sync.syncMonotonicMs) / 1000);
        const updatedRemaining = Math.max(0, sync.remainingSecondsAtSync - elapsedSeconds);
        setReservationRemainingSeconds(updatedRemaining);
      } else if (sync.dispatchId !== null) {
        setReservationRemainingSeconds(0);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const matchingWitnessReports = selectedIncident
    ? witnessReports.filter(
        (r) =>
          r.master_incident_id === selectedIncident.id ||
          r.matching_incident_id === selectedIncident.id
      )
    : [];
  const pendingDuplicateCount = witnessReports.filter(
    (r) => r.review_status === "POSSIBLE_DUPLICATE"
  ).length;

  // Filtered incidents
  const filteredIncidents = incidents.filter((inc) => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const match =
        inc.chief_complaint?.toLowerCase().includes(q) ||
        inc.location_address?.toLowerCase().includes(q) ||
        inc.caller_name?.toLowerCase().includes(q) ||
        String(inc.id).includes(q);
      if (!match) return false;
    }
    if (statusFilter === "ALL") return true;
    if (statusFilter === "P1") return inc.triage_color === "RED";
    if (statusFilter === "ACTIVE") return inc.status !== "RESOLVED" && inc.status !== "CANCELLED";
    return true;
  });

  // Fleet stats
  const availableAmbs = ambulances.filter((a) => a.status === "AVAILABLE").length;
  const totalBeds = hospitals.reduce((acc, h) => acc + h.available_emergency_beds, 0);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-blue-100 selection:text-blue-900">
      {/* Top Application Bar */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur px-5 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-40 shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center text-white shadow-md shadow-red-600/20">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black tracking-tight text-slate-900">LIFELINK</h1>
              <span className="text-xs font-semibold text-slate-400">/ ResQFlow</span>
              <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-bold">
                Command HQ
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Mangaluru Emergency Dispatch & Triage Corridor (12.9141° N, 74.8560° E)
            </p>
          </div>
        </div>

        {/* Real-Time Operational Counters & Primary CTA */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-xs">
            <Ambulance className="w-4 h-4 text-blue-600" />
            <span className="text-slate-500">Available Fleet:</span>
            <span className="font-mono font-bold text-slate-900">
              {availableAmbs} / {ambulances.length}
            </span>
          </div>

          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-100 border border-slate-200 text-xs">
            <Building2 className="w-4 h-4 text-emerald-600" />
            <span className="text-slate-500">Vacant ER Beds:</span>
            <span className="font-mono font-bold text-slate-900">{totalBeds}</span>
          </div>

          {pendingDuplicateCount > 0 && (
            <div
              onClick={() => setActiveNav("witnesses")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-amber-800 text-xs font-mono font-bold animate-pulse cursor-pointer shadow-2xs"
            >
              <Users className="w-3.5 h-3.5 text-amber-600" />
              <span>{pendingDuplicateCount} Duplicate Alert{pendingDuplicateCount > 1 ? "s" : ""}</span>
            </div>
          )}

          <button
            onClick={() => setIsRegistrationOpen(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-md shadow-red-600/20 transition cursor-pointer"
          >
            <FilePlus2 className="w-4 h-4" />
            <span>+ New Emergency</span>
          </button>

          <div className="hidden lg:flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs font-semibold">
            <a
              href="/ambulance"
              className="px-2 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Ambulance Paramedic In-Vehicle Terminal"
            >
              Ambulance
            </a>
            <a
              href="/hospital"
              className="px-2 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Hospital ER Intake Console"
            >
              Hospital ER
            </a>
            <a
              href="/citizen"
              className="px-2 py-1 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition"
              title="Citizen SOS Portal"
            >
              Citizen SOS
            </a>
          </div>

          <a
            href="/login"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 text-xs font-bold transition cursor-pointer"
            title="Switch portal or login with demo account"
          >
            <LogIn className="w-3.5 h-3.5 text-blue-600" />
            <span>Role Portals</span>
          </a>

          <button
            onClick={handleResetSeed}
            title="Reset database to fresh Mangaluru demonstration dataset"
            className="p-2 rounded-lg bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 hover:text-slate-900 transition cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Body: Sidebar Navigation + Workspace Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Slim Professional Sidebar Navigation */}
        <aside className="w-56 shrink-0 border-r border-slate-200 bg-white p-3 flex flex-col justify-between hidden md:flex">
          <div className="space-y-1">
            <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">
              Operations
            </div>

            <button
              onClick={() => setActiveNav("overview")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeNav === "overview"
                  ? "bg-blue-50 text-blue-700 font-bold border border-blue-200 shadow-2xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <LayoutDashboard className="w-4 h-4 text-blue-600" />
              <span>Command Center</span>
            </button>

            <button
              onClick={() => setActiveNav("emergencies")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeNav === "emergencies"
                  ? "bg-blue-50 text-blue-700 font-bold border border-blue-200 shadow-2xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="w-4 h-4 text-red-600" />
                <span>Emergencies</span>
              </div>
              <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600">
                {incidents.length}
              </span>
            </button>

            <button
              onClick={() => setActiveNav("ambulances")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeNav === "ambulances"
                  ? "bg-blue-50 text-blue-700 font-bold border border-blue-200 shadow-2xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Ambulance className="w-4 h-4 text-blue-600" />
                <span>Ambulances</span>
              </div>
              <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 font-bold">
                {availableAmbs}
              </span>
            </button>

            <button
              onClick={() => setActiveNav("hospitals")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeNav === "hospitals"
                  ? "bg-blue-50 text-blue-700 font-bold border border-blue-200 shadow-2xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Building2 className="w-4 h-4 text-emerald-600" />
                <span>Hospitals</span>
              </div>
              <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600">
                {hospitals.length}
              </span>
            </button>

            <button
              onClick={() => setActiveNav("witnesses")}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeNav === "witnesses"
                  ? "bg-blue-50 text-blue-700 font-bold border border-blue-200 shadow-2xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Users className="w-4 h-4 text-indigo-600" />
                <span>Witness Reports</span>
              </div>
              {pendingDuplicateCount > 0 ? (
                <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 font-bold animate-pulse">
                  {pendingDuplicateCount}
                </span>
              ) : (
                <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-slate-100 text-slate-600">
                  {witnessReports.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveNav("history")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeNav === "history"
                  ? "bg-blue-50 text-blue-700 font-bold border border-blue-200 shadow-2xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <History className="w-4 h-4 text-slate-600" />
              <span>Dispatch History</span>
            </button>

            <div className="pt-3 pb-1 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-400 font-mono">
              Administration
            </div>

            <button
              onClick={() => setActiveNav("settings")}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                activeNav === "settings"
                  ? "bg-blue-50 text-blue-700 font-bold border border-blue-200 shadow-2xs"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              <Settings className="w-4 h-4 text-slate-600" />
              <span>Platform & Roles</span>
            </button>
          </div>

          {/* System Pulse badge */}
          <div className="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
              <span className="text-[11px] font-bold text-slate-800">Dispatch Server</span>
            </div>
            <p className="text-[10px] text-slate-500 font-mono">
              Port: 8000 • WebSockets Connected • Latency &lt; 20ms
            </p>
          </div>
        </aside>

        {/* Dynamic Workspace Container */}
        <main className="flex-1 overflow-hidden p-3 bg-slate-50 flex flex-col">
          {/* ============================================================== */}
          {/* VIEW 1: OVERVIEW / COMMAND CENTER (Map + Queue + Tab Inspector)*/}
          {/* ============================================================== */}
          {activeNav === "overview" && (
            <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 overflow-hidden max-w-[1920px] w-full mx-auto">
              {/* Left Column: Live Incident Feed (3 Columns) */}
              <section className="lg:col-span-3 flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden shadow-2xs max-h-[calc(100vh-80px)]">
                <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50/70">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-red-600" />
                    <h2 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                      Emergency Queue ({filteredIncidents.length})
                    </h2>
                  </div>

                  {/* Filter buttons */}
                  <div className="flex gap-1 text-[10px] font-mono">
                    <button
                      onClick={() => setStatusFilter("ALL")}
                      className={`px-2 py-0.5 rounded transition cursor-pointer ${
                        statusFilter === "ALL" ? "bg-blue-600 text-white font-bold" : "text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      All
                    </button>
                    <button
                      onClick={() => setStatusFilter("P1")}
                      className={`px-2 py-0.5 rounded transition cursor-pointer ${
                        statusFilter === "P1" ? "bg-red-600 text-white font-bold" : "text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      P1 Red
                    </button>
                    <button
                      onClick={() => setStatusFilter("ACTIVE")}
                      className={`px-2 py-0.5 rounded transition cursor-pointer ${
                        statusFilter === "ACTIVE" ? "bg-emerald-600 text-white font-bold" : "text-slate-600 hover:bg-slate-200"
                      }`}
                    >
                      Active
                    </button>
                  </div>
                </div>

                {/* Search Bar */}
                <div className="p-2 border-b border-slate-100 bg-white">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                    <input
                      type="text"
                      placeholder="Search emergencies, locations..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:bg-white focus:border-blue-500"
                    />
                  </div>
                </div>

                {/* Incident Cards Scrollable List */}
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {filteredIncidents.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-400 font-mono">
                      No emergencies match filter.
                    </div>
                  ) : (
                    filteredIncidents.map((inc) => {
                      const isSelected = selectedIncident?.id === inc.id;

                      return (
                        <div
                          key={inc.id}
                          onClick={() => setSelectedIncident(inc)}
                          className={`p-3 rounded-xl border transition cursor-pointer space-y-2 ${
                            isSelected
                              ? "bg-blue-50/60 border-blue-500 shadow-sm ring-1 ring-blue-500"
                              : "bg-white border-slate-200 hover:border-slate-300 shadow-2xs"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span
                              className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded font-mono ${
                                inc.triage_color === "RED"
                                  ? "bg-red-50 text-red-700 border border-red-200"
                                  : inc.triage_color === "YELLOW"
                                  ? "bg-amber-50 text-amber-700 border border-amber-200"
                                  : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              }`}
                            >
                              {inc.triage_level}
                            </span>
                            <span className="text-[10px] font-mono text-slate-500 font-medium">
                              Score: {inc.triage_score}/100
                            </span>
                          </div>

                          <div className="text-xs font-bold text-slate-900 line-clamp-2 leading-snug">
                            {inc.chief_complaint}
                          </div>

                          <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                            <MapPin className="w-3 h-3 text-red-500 shrink-0" />
                            <span className="truncate">{inc.location_address}</span>
                          </div>

                          <div className="flex items-center justify-between pt-1 border-t border-slate-100 text-[10px]">
                            <span className="text-slate-500 font-mono">
                              Status: <strong className="text-blue-700 font-bold">{inc.status}</strong>
                            </span>
                            <div className="flex items-center gap-1.5">
                              {inc.witness_count > 0 && (
                                <span className="flex items-center gap-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold">
                                  <Users className="w-2.5 h-2.5" />
                                  {inc.witness_count} {inc.witness_count === 1 ? "Witness" : "Witnesses"}
                                </span>
                              )}
                              <span className="text-slate-400 font-mono">Need: {inc.required_ambulance_type}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </section>

              {/* Center Column: Interactive Leaflet Map (5 Columns) */}
              <section className="lg:col-span-5 flex flex-col rounded-xl overflow-hidden border border-slate-200 bg-white shadow-2xs relative min-h-[500px]">
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

              {/* Right Column: Selected Incident Organized Tabs Inspector (4 Columns) */}
              <section className="lg:col-span-4 flex flex-col rounded-xl border border-slate-200 bg-white overflow-hidden shadow-2xs max-h-[calc(100vh-80px)]">
                {selectedIncident ? (
                  <>
                    {/* Selected Incident Banner */}
                    <div className="p-3.5 border-b border-slate-200 bg-slate-50 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-800 uppercase font-mono">
                          Emergency Incident #{selectedIncident.id}
                        </span>
                        <span
                          className={`text-[9px] font-black px-2 py-0.5 rounded uppercase font-mono ${
                            selectedIncident.triage_color === "RED"
                              ? "bg-red-50 text-red-700 border border-red-200"
                              : selectedIncident.triage_color === "YELLOW"
                              ? "bg-amber-50 text-amber-700 border border-amber-200"
                              : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          }`}
                        >
                          {selectedIncident.triage_level}
                        </span>
                      </div>
                      <div className="text-xs font-bold text-slate-900 leading-snug">
                        {selectedIncident.chief_complaint}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                        <MapPin className="w-3 h-3 text-red-500 shrink-0" />
                        <span className="truncate">{selectedIncident.location_address}</span>
                      </div>
                    </div>

                    {/* Clean Organized Tabs Navigation */}
                    <div className="flex items-center border-b border-slate-200 bg-white px-2 overflow-x-auto text-xs font-semibold text-slate-600">
                      <button
                        onClick={() => setInspectorTab("overview")}
                        className={`px-3 py-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
                          inspectorTab === "overview"
                            ? "border-blue-600 text-blue-600 font-bold"
                            : "border-transparent hover:text-slate-900"
                        }`}
                      >
                        Overview
                      </button>
                      <button
                        onClick={() => setInspectorTab("dispatch")}
                        className={`px-3 py-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
                          inspectorTab === "dispatch"
                            ? "border-blue-600 text-blue-600 font-bold"
                            : "border-transparent hover:text-slate-900"
                        }`}
                      >
                        Dispatch & Confirm
                      </button>
                      <button
                        onClick={() => setInspectorTab("escalation")}
                        className={`px-3 py-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
                          inspectorTab === "escalation"
                            ? "border-blue-600 text-blue-600 font-bold"
                            : "border-transparent hover:text-slate-900"
                        }`}
                      >
                        Escalation
                        {currentDispatch?.attempt_number > 1 && (
                          <span className="ml-1 px-1 py-0.2 rounded-full bg-amber-100 text-amber-800 text-[9px] font-mono">
                            #{currentDispatch.attempt_number}
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => setInspectorTab("handover")}
                        className={`px-3 py-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
                          inspectorTab === "handover"
                            ? "border-blue-600 text-blue-600 font-bold"
                            : "border-transparent hover:text-slate-900"
                        }`}
                      >
                        Handover
                      </button>
                      <button
                        onClick={() => setInspectorTab("witness")}
                        className={`px-3 py-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
                          inspectorTab === "witness"
                            ? "border-blue-600 text-blue-600 font-bold"
                            : "border-transparent hover:text-slate-900"
                        }`}
                      >
                        Witness ({matchingWitnessReports.length})
                      </button>
                      <button
                        onClick={() => setInspectorTab("timeline")}
                        className={`px-3 py-2 border-b-2 transition whitespace-nowrap cursor-pointer ${
                          inspectorTab === "timeline"
                            ? "border-blue-600 text-blue-600 font-bold"
                            : "border-transparent hover:text-slate-900"
                        }`}
                      >
                        Timeline
                      </button>
                    </div>

                    {/* Tab Body Content */}
                    <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
                      {/* TAB 1: OVERVIEW */}
                      {inspectorTab === "overview" && (
                        <div className="space-y-3 text-xs">
                          {/* Caller & Patient Profile */}
                          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                            <span className="font-bold text-slate-800 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                              <User className="w-3.5 h-3.5 text-blue-600" />
                              Caller & Patient Details
                            </span>
                            <div className="grid grid-cols-2 gap-2 pt-1 text-[11px]">
                              <div>
                                <span className="text-slate-400 block text-[10px]">Caller:</span>
                                <span className="font-semibold text-slate-800">{selectedIncident.caller_name}</span>
                              </div>
                              <div>
                                <span className="text-slate-400 block text-[10px]">Phone:</span>
                                <span className="font-mono text-slate-700">{selectedIncident.caller_phone}</span>
                              </div>
                              <div>
                                <span className="text-slate-400 block text-[10px]">Patient:</span>
                                <span className="font-semibold text-slate-800">
                                  {selectedIncident.patient_age ? `${selectedIncident.patient_age} years` : "Age N/A"} • {selectedIncident.patient_gender}
                                </span>
                              </div>
                              <div>
                                <span className="text-slate-400 block text-[10px]">Incident Status:</span>
                                <span className="font-bold text-blue-700">{selectedIncident.status}</span>
                              </div>
                            </div>
                          </div>

                          {/* Clinical Rule Justifications */}
                          <div className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2">
                            <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                              <span>Clinical Triage Rationale</span>
                            </div>
                            <ul className="space-y-1.5 text-[11px] text-slate-600">
                              {selectedIncident.triage_justifications?.map((j: string, idx: number) => (
                                <li key={idx} className="flex items-start gap-1.5 leading-snug">
                                  <span className="text-blue-600 font-mono mt-0.5">•</span>
                                  <span>{j}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          {/* Quick Action Dispatch Button */}
                          {!currentDispatch && (
                            <button
                              onClick={() => setIsAllocationOpen(true)}
                              className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md shadow-blue-600/20 transition flex items-center justify-center gap-2 cursor-pointer"
                            >
                              <Sliders className="w-4 h-4" />
                              <span>Open Intelligent Allocation Engine</span>
                            </button>
                          )}
                        </div>
                      )}

                      {/* TAB 2: DISPATCH & CONFIRMATIONS */}
                      {inspectorTab === "dispatch" && (
                        <div className="space-y-3 text-xs">
                          {currentDispatch ? (
                            <>
                              {/* Coordination Status Box */}
                              <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
                                <div className="flex items-center justify-between border-b border-slate-200/80 pb-2">
                                  <span className="font-bold text-slate-800 flex items-center gap-1.5 text-xs">
                                    <Radio className="w-3.5 h-3.5 text-blue-600 animate-pulse" />
                                    Coordination Status
                                  </span>
                                  <span
                                    className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold border ${
                                      currentDispatch.coordination_status === "CONFIRMED"
                                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                        : currentDispatch.coordination_status === "PENDING_CONFIRMATIONS"
                                        ? "bg-amber-50 text-amber-700 border-amber-200 animate-pulse"
                                        : currentDispatch.coordination_status === "REJECTED"
                                        ? "bg-red-50 text-red-700 border-red-200"
                                        : currentDispatch.coordination_status === "EXPIRED"
                                        ? "bg-orange-50 text-orange-700 border-orange-200"
                                        : "bg-blue-50 text-blue-700 border-blue-200"
                                    }`}
                                  >
                                    {currentDispatch.coordination_status || currentDispatch.status}
                                  </span>
                                </div>

                                <div className="space-y-1.5 text-[11px] text-slate-700">
                                  <div className="flex justify-between">
                                    <span className="text-slate-400">Assigned Unit:</span>
                                    <strong className="text-blue-700">{assignedAmbulance?.call_sign} ({assignedAmbulance?.vehicle_type})</strong>
                                  </div>
                                  <div className="flex justify-between">
                                    <span className="text-slate-400">Receiving Hospital:</span>
                                    <strong className="text-emerald-700">{assignedHospital?.name || "TBD"}</strong>
                                  </div>
                                  <div className="flex justify-between font-mono text-[10px]">
                                    <span className="text-slate-400">Response Distance:</span>
                                    <span>{formatDistance(currentDispatch.route_distance_meters || 0)}</span>
                                  </div>
                                  <div className="flex justify-between font-mono text-[10px]">
                                    <span className="text-slate-400">Est. Arrival ETA:</span>
                                    <span className="text-emerald-600 font-bold">
                                      {formatDuration(currentDispatch.estimated_eta_seconds || 0)}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {/* Dual Confirmation Sub-Card */}
                              <div className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-2.5">
                                <div className="flex items-center justify-between font-bold text-slate-800 text-xs">
                                  <span className="flex items-center gap-1.5">
                                    <Clock className="w-3.5 h-3.5 text-blue-600" />
                                    Dual Confirmation
                                  </span>
                                  {currentDispatch.coordination_status === "PENDING_CONFIRMATIONS" && currentDispatch.reservation_expires_at && (
                                    <span className="font-mono text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded font-bold">
                                      TTL: {reservationRemainingSeconds !== null ? reservationRemainingSeconds : 0}s
                                    </span>
                                  )}
                                </div>

                                {/* Ambulance confirmation row */}
                                <div className="flex items-center justify-between text-[11px] p-2 rounded-lg bg-slate-50 border border-slate-200">
                                  <div className="flex items-center gap-1.5">
                                    <Ambulance className="w-3.5 h-3.5 text-blue-600" />
                                    <span className="text-slate-700">Ambulance Crew:</span>
                                  </div>
                                  <span
                                    className={`font-mono font-bold px-1.5 py-0.5 rounded text-[9px] uppercase ${
                                      currentDispatch.ambulance_confirmation_status === "ACCEPTED"
                                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                        : currentDispatch.ambulance_confirmation_status === "REJECTED"
                                        ? "bg-red-50 text-red-700 border border-red-200"
                                        : "bg-amber-50 text-amber-700 border border-amber-200"
                                    }`}
                                  >
                                    {currentDispatch.ambulance_confirmation_status}
                                  </span>
                                </div>

                                {/* Hospital confirmation row */}
                                <div className="flex items-center justify-between text-[11px] p-2 rounded-lg bg-slate-50 border border-slate-200">
                                  <div className="flex items-center gap-1.5">
                                    <Building2 className="w-3.5 h-3.5 text-emerald-600" />
                                    <span className="text-slate-700">Hospital ER Bay:</span>
                                  </div>
                                  <span
                                    className={`font-mono font-bold px-1.5 py-0.5 rounded text-[9px] uppercase ${
                                      currentDispatch.hospital_confirmation_status === "ACCEPTED"
                                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                        : currentDispatch.hospital_confirmation_status === "REJECTED"
                                        ? "bg-red-50 text-red-700 border border-red-200"
                                        : "bg-amber-50 text-amber-700 border border-amber-200"
                                    }`}
                                  >
                                    {currentDispatch.hospital_confirmation_status}
                                  </span>
                                </div>

                                {/* Demo Simulated Response Buttons */}
                                {currentDispatch.coordination_status === "PENDING_CONFIRMATIONS" && (
                                  <div className="pt-2 border-t border-slate-100 space-y-1.5">
                                    <div className="text-[9px] uppercase font-mono font-bold text-slate-400 flex items-center justify-between">
                                      <span>Simulated Terminal Responses</span>
                                      <span className="text-amber-600 font-semibold">[Demo Controls]</span>
                                    </div>

                                    {currentDispatch.ambulance_confirmation_status === "PENDING" && (
                                      <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                                        <button
                                          onClick={() => handleConfirmAmbulance(currentDispatch.id, "ACCEPTED")}
                                          className="px-2 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 font-bold transition cursor-pointer"
                                        >
                                          ✓ Amb Accept
                                        </button>
                                        <button
                                          onClick={() => handleConfirmAmbulance(currentDispatch.id, "REJECTED")}
                                          className="px-2 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 font-bold transition cursor-pointer"
                                        >
                                          ✕ Amb Reject
                                        </button>
                                      </div>
                                    )}

                                    {currentDispatch.hospital_confirmation_status === "PENDING" && (
                                      <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                                        <button
                                          onClick={() => handleConfirmHospital(currentDispatch.id, "ACCEPTED")}
                                          className="px-2 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 font-bold transition cursor-pointer"
                                        >
                                          ✓ Hosp Accept
                                        </button>
                                        <button
                                          onClick={() => handleConfirmHospital(currentDispatch.id, "REJECTED")}
                                          className="px-2 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 font-bold transition cursor-pointer"
                                        >
                                          ✕ Hosp Reject
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Lifecycle Step Progression Button */}
                              {currentDispatch.coordination_status === "CONFIRMED" && currentDispatch.status !== "COMPLETED" && (
                                <button
                                  onClick={() => handleStepLifecycle(currentDispatch.id)}
                                  disabled={isSteppingLifecycle}
                                  className={`w-full py-2.5 px-3 rounded-xl text-white text-xs font-bold shadow-md transition flex items-center justify-center gap-2 ${
                                    isSteppingLifecycle
                                      ? "bg-blue-400 cursor-not-allowed opacity-75 shadow-none"
                                      : "bg-blue-600 hover:bg-blue-700 shadow-blue-600/20 cursor-pointer"
                                  }`}
                                >
                                  {isSteppingLifecycle ? (
                                    <>
                                      <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                                      <span>Advancing Stage...</span>
                                    </>
                                  ) : (
                                    <>
                                      <span>
                                        Advance Lifecycle:{" "}
                                        {currentDispatch.status === "ASSIGNED"
                                          ? "Mark En Route"
                                          : currentDispatch.status === "EN_ROUTE_INCIDENT"
                                          ? "Mark Arrived Scene"
                                          : currentDispatch.status === "ON_SCENE"
                                          ? "Start Transport"
                                          : "Complete Handover"}
                                      </span>
                                      <ArrowRight className="w-3.5 h-3.5" />
                                    </>
                                  )}
                                </button>
                              )}
                            </>
                          ) : (
                            <div className="p-6 text-center text-xs text-slate-500 font-mono space-y-3">
                              <p>No ambulance dispatched yet for this emergency.</p>
                              <button
                                onClick={() => setIsAllocationOpen(true)}
                                className="py-2 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs transition cursor-pointer"
                              >
                                Allocate Ambulance & Hospital
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 3: SMART ESCALATION */}
                      {inspectorTab === "escalation" && (
                        <div className="space-y-3 text-xs">
                          {currentDispatch ? (
                            <>
                              <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-2">
                                <div className="flex items-center justify-between font-bold text-slate-800">
                                  <span>Dispatch Escalation State</span>
                                  <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200 font-bold">
                                    Attempt #{currentDispatch.attempt_number || 1}
                                  </span>
                                </div>

                                {currentDispatch.attempt_number > 1 ? (
                                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 space-y-2">
                                    <div className="flex items-center gap-1.5 font-bold text-amber-800 text-[11px]">
                                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                                      <span>Automatic Escalation Engaged</span>
                                    </div>
                                    {lastEscalation && (
                                      <div className="text-[10px] space-y-1 text-slate-700 font-mono">
                                        <div>Trigger: {lastEscalation.failure_reason}</div>
                                        <div className="flex items-center gap-1 text-slate-500">
                                          <span className="line-through text-red-500">{lastEscalation.failed_ambulance_call_sign}</span>
                                          <ArrowRight className="w-3 h-3 text-amber-600" />
                                          <span className="text-emerald-700 font-bold">{lastEscalation.replacement_ambulance_call_sign || assignedAmbulance?.call_sign}</span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <p className="text-[11px] text-slate-500">
                                    No escalation triggered. Initial reservation is active.
                                  </p>
                                )}
                              </div>

                              {(currentDispatch.coordination_status === "REJECTED" ||
                                currentDispatch.coordination_status === "EXPIRED" ||
                                currentDispatch.coordination_status === "REASSIGNMENT_REQUIRED") && (
                                <div className="p-3.5 rounded-xl border border-red-200 bg-red-50 space-y-2">
                                  <div className="text-[11px] text-red-800 font-medium">
                                    {currentDispatch.rejection_reason || "Resource reservation failed."}
                                  </div>
                                  <button
                                    onClick={() => handleReassignDispatch(currentDispatch.id)}
                                    className="w-full py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold shadow-xs transition flex items-center justify-center gap-1.5 cursor-pointer"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    <span>Reassign to Alternative Resource</span>
                                  </button>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="p-6 text-center text-xs text-slate-400 font-mono">
                              No active dispatch to inspect escalation.
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 4: EMERGENCY HANDOVER */}
                      {inspectorTab === "handover" && (
                        <div className="space-y-3 text-xs">
                          {currentDispatch ? (
                            <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
                              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                                <span className="font-bold text-slate-800 flex items-center gap-1.5">
                                  <FileText className="w-3.5 h-3.5 text-purple-600" />
                                  Handover Transmission
                                </span>
                                <span
                                  className={`text-[9px] font-mono px-2 py-0.5 rounded-full font-bold border uppercase ${
                                    currentDispatch.handover_packet?.status === "ACKNOWLEDGED"
                                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                      : currentDispatch.coordination_status === "CONFIRMED"
                                      ? "bg-blue-50 text-blue-700 border-blue-200 animate-pulse"
                                      : "bg-slate-100 text-slate-500 border-slate-200"
                                  }`}
                                >
                                  {currentDispatch.handover_packet?.status || "Awaiting Dual Confirmation"}
                                </span>
                              </div>

                              {currentDispatch.coordination_status === "CONFIRMED" ? (
                                <>
                                  <div className="space-y-1 text-[11px] text-slate-600">
                                    <div className="flex justify-between">
                                      <span>Receiving ER:</span>
                                      <strong className="text-emerald-700">{assignedHospital?.name}</strong>
                                    </div>
                                    <div className="flex justify-between font-mono">
                                      <span>Transmission Status:</span>
                                      <span className="text-purple-700 font-bold">{currentDispatch.handover_packet?.status || "TRANSMITTED"}</span>
                                    </div>
                                  </div>

                                  <div className="space-y-2 pt-2">
                                    <button
                                      onClick={() => setIsHandoverModalOpen(true)}
                                      className="w-full py-2 px-3 rounded-lg bg-purple-50 hover:bg-purple-100 border border-purple-200 text-purple-800 text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer"
                                    >
                                      <Eye className="w-3.5 h-3.5" />
                                      <span>Inspect Full Clinical Handover Packet</span>
                                    </button>

                                    {currentDispatch.handover_packet?.status !== "ACKNOWLEDGED" ? (
                                      <button
                                        onClick={() => handleAcknowledgeHandover(currentDispatch.id)}
                                        className="w-full py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
                                      >
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                        <span>Simulate Receiving Hospital Acknowledge</span>
                                      </button>
                                    ) : (
                                      <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-[10px] text-emerald-800 font-mono flex items-center gap-1.5">
                                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                        <span>Pre-Intake Acknowledged by {currentDispatch.handover_packet.acknowledged_by || "ER Staff"}</span>
                                      </div>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <p className="text-[11px] text-slate-500 leading-snug">
                                  Handover packet compiles automatically upon dual confirmation and is transmitted to the receiving ER triage workstation.
                                </p>
                              )}
                            </div>
                          ) : (
                            <div className="p-6 text-center text-xs text-slate-400 font-mono">
                              No active dispatch to compile handover packet.
                            </div>
                          )}
                        </div>
                      )}

                      {/* TAB 5: WITNESS INTELLIGENCE */}
                      {inspectorTab === "witness" && (
                        <div className="space-y-3 text-xs">
                          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-2.5">
                            <div className="flex items-center justify-between font-bold text-slate-800">
                              <span className="flex items-center gap-1.5">
                                <Users className="w-3.5 h-3.5 text-indigo-600" />
                                Correlated Witness Reports
                              </span>
                              <span className="font-mono text-[10px] px-2 py-0.5 rounded bg-white border border-slate-200">
                                {matchingWitnessReports.length} Reports
                              </span>
                            </div>

                            {matchingWitnessReports.length === 0 ? (
                              <p className="text-[11px] text-slate-500">
                                No secondary reports correlated with this incident yet.
                              </p>
                            ) : (
                              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                                {matchingWitnessReports.map((wr) => {
                                  const isPossible = wr.review_status === "POSSIBLE_DUPLICATE";
                                  const isLinked = wr.review_status === "CONFIRMED_DUPLICATE";
                                  return (
                                    <div
                                      key={wr.id}
                                      className={`p-2.5 rounded-lg border text-[11px] space-y-1.5 ${
                                        isPossible
                                          ? "bg-amber-50 border-amber-300 text-amber-900"
                                          : isLinked
                                          ? "bg-purple-50 border-purple-200 text-slate-800"
                                          : "bg-white border-slate-200 text-slate-800"
                                      }`}
                                    >
                                      <div className="flex items-center justify-between">
                                        <span className="font-bold text-slate-900">{wr.reporter_identifier}</span>
                                        <span
                                          className={`text-[9px] font-mono px-1.5 py-0.2 rounded font-bold uppercase ${
                                            isPossible
                                              ? "bg-amber-100 text-amber-800 border border-amber-300"
                                              : isLinked
                                              ? "bg-purple-100 text-purple-800 border border-purple-200"
                                              : "bg-slate-100 text-slate-600 border border-slate-200"
                                          }`}
                                        >
                                          {isPossible ? `⚠️ ${Math.round((wr.duplicate_probability || 0) * 100)}% Match` : wr.review_status}
                                        </span>
                                      </div>

                                      <p className="text-[10px] text-slate-600 italic">"{wr.incident_description}"</p>

                                      {isPossible && (
                                        <div className="grid grid-cols-2 gap-1.5 pt-1">
                                          <button
                                            onClick={() => handleLinkWitness(wr.id, selectedIncident.id)}
                                            className="py-1 px-2 rounded-md bg-purple-600 hover:bg-purple-700 text-white font-bold text-[10px] transition flex items-center justify-center gap-1 cursor-pointer"
                                          >
                                            <Link2 className="w-3 h-3" />
                                            <span>Link Duplicate</span>
                                          </button>
                                          <button
                                            onClick={() => handleMarkWitnessDistinct(wr.id, false)}
                                            className="py-1 px-2 rounded-md bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 font-semibold text-[10px] transition flex items-center justify-center gap-1 cursor-pointer"
                                          >
                                            <Split className="w-3 h-3" />
                                            <span>Distinct</span>
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            <button
                              onClick={() => handleSimulateWitnessReport(selectedIncident)}
                              className="w-full py-1.5 px-3 rounded-lg bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 text-[10px] font-bold transition flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <span>+ Simulate Eyewitness Report near this Scene [Demo]</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* TAB 6: TIMELINE */}
                      {inspectorTab === "timeline" && (
                        <div className="space-y-3">
                          <UnifiedTimelinePanel
                            incidentId={selectedIncident.id}
                            backendUrl={backendUrl}
                          />
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="p-8 text-center text-xs text-slate-400 font-mono space-y-2">
                    <ShieldAlert className="w-8 h-8 text-slate-300 mx-auto" />
                    <p>Select an emergency from the queue or map to inspect operational details.</p>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW 2: FULL EMERGENCIES TABLE                                */}
          {/* ============================================================== */}
          {activeNav === "emergencies" && (
            <div className="flex-1 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div>
                  <h2 className="text-base font-bold text-slate-900">Emergency Incident Registry</h2>
                  <p className="text-xs text-slate-500">Live Mangaluru operations queue and triage prioritization</p>
                </div>
                <button
                  onClick={() => setIsRegistrationOpen(true)}
                  className="px-3.5 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-xs cursor-pointer"
                >
                  + Register Emergency
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-500 font-mono uppercase text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3">ID</th>
                      <th className="py-2.5 px-3">Triage</th>
                      <th className="py-2.5 px-3">Chief Complaint</th>
                      <th className="py-2.5 px-3">Caller & Location</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {incidents.map((inc) => (
                      <tr key={inc.id} className="hover:bg-slate-50/70 transition">
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
                        <td className="py-3 px-3 font-semibold text-slate-900 max-w-xs">{inc.chief_complaint}</td>
                        <td className="py-3 px-3 text-slate-600">
                          <div>{inc.caller_name}</div>
                          <div className="text-[10px] text-slate-400">{inc.location_address}</div>
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-blue-700">{inc.status}</td>
                        <td className="py-3 px-3">
                          <button
                            onClick={() => {
                              setSelectedIncident(inc);
                              setActiveNav("overview");
                            }}
                            className="px-2.5 py-1 rounded bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold border border-blue-200 text-[11px] cursor-pointer"
                          >
                            Inspect HQ →
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
          {/* VIEW 3: AMBULANCES FLEET INVENTORY                            */}
          {/* ============================================================== */}
          {activeNav === "ambulances" && (
            <div className="flex-1 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div>
                  <h2 className="text-base font-bold text-slate-900">Mangaluru Ambulance Fleet Inventory</h2>
                  <p className="text-xs text-slate-500">Real-time status, medical equipment, telemetry, and base stations</p>
                </div>
                <div className="flex items-center gap-2 text-xs font-mono">
                  <span className="px-2 py-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                    {availableAmbs} Available
                  </span>
                  <span className="px-2 py-1 rounded bg-slate-100 text-slate-600">
                    {ambulances.length} Total Units
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {ambulances.map((amb) => (
                  <div key={amb.id} className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-2.5">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                      <span className="font-bold text-blue-700 font-mono text-sm">{amb.call_sign}</span>
                      <span
                        className={`text-[9px] font-mono px-2 py-0.5 rounded-full font-bold border uppercase ${
                          amb.status === "AVAILABLE"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : amb.status === "RESERVED"
                            ? "bg-amber-50 text-amber-700 border-amber-200"
                            : "bg-blue-50 text-blue-700 border-blue-200"
                        }`}
                      >
                        {amb.status}
                      </span>
                    </div>

                    <div className="text-[11px] space-y-1 text-slate-600">
                      <div className="flex justify-between">
                        <span>Vehicle Class:</span>
                        <strong className="text-slate-800">{amb.vehicle_type} ({amb.paramedic_level})</strong>
                      </div>
                      <div className="flex justify-between">
                        <span>Base Station:</span>
                        <span className="text-slate-700">{amb.base_station}</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span>Fuel Level:</span>
                        <span className="text-slate-900 font-bold">{amb.fuel_level_percent}%</span>
                      </div>
                    </div>

                    <div className="pt-1.5 border-t border-slate-200 text-[10px] text-slate-500">
                      <span className="block font-semibold text-slate-600">Onboard Clinical Equipment:</span>
                      <span className="truncate block mt-0.5">{amb.equipment?.join(", ") || "Standard Trauma Kit"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW 4: HOSPITALS & ER BAYS                                   */}
          {/* ============================================================== */}
          {activeNav === "hospitals" && (
            <div className="flex-1 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto space-y-4">
              <div className="pb-3 border-b border-slate-100">
                <h2 className="text-base font-bold text-slate-900">Emergency Receiving Hospitals (Mangaluru)</h2>
                <p className="text-xs text-slate-500">Active ER / ICU bed capacities and medical department specialties</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {hospitals.map((hosp) => (
                  <div key={hosp.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3 shadow-2xs">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-200">
                      <h3 className="font-bold text-slate-900 text-sm">{hosp.name}</h3>
                      <span className="text-xs font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded font-bold">
                        {hosp.available_emergency_beds} ER Beds Free
                      </span>
                    </div>

                    <p className="text-[11px] text-slate-500">{hosp.address}</p>

                    <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                      <div className="p-2 rounded-lg bg-white border border-slate-200 text-center">
                        <span className="text-[10px] text-slate-400 block">ICU Beds</span>
                        <span className="font-bold text-slate-800 text-sm">
                          {hosp.available_icu_beds} / {hosp.total_icu_beds}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-white border border-slate-200 text-center">
                        <span className="text-[10px] text-slate-400 block">Emergency Bays</span>
                        <span className="font-bold text-blue-700 text-sm">
                          {hosp.available_emergency_beds} / {hosp.total_emergency_beds}
                        </span>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-200 text-[11px] space-y-1">
                      <div className="text-slate-500">Specialty Departments:</div>
                      <div className="flex flex-wrap gap-1">
                        {hosp.specialties.map((spec: string, idx: number) => (
                          <span key={idx} className="px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-700 text-[10px]">
                            {spec}
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="text-[10px] font-mono text-slate-400 pt-1">
                      Emergency Hotline: {hosp.contact_number}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW 5: WITNESS REPORTS & DEDUPLICATION                       */}
          {/* ============================================================== */}
          {activeNav === "witnesses" && (
            <div className="flex-1 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div>
                  <h2 className="text-base font-bold text-slate-900">Multi-Witness Intelligence & Deduplication</h2>
                  <p className="text-xs text-slate-500">Correlate multiple caller reports for single real-world incidents</p>
                </div>
                <div className="font-mono text-xs text-slate-600">
                  Total Reports: <strong>{witnessReports.length}</strong>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-500 font-mono uppercase text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3">Report ID</th>
                      <th className="py-2.5 px-3">Witness Source</th>
                      <th className="py-2.5 px-3">Description</th>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Match Probability</th>
                      <th className="py-2.5 px-3">Master Incident</th>
                      <th className="py-2.5 px-3">Review Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {witnessReports.map((wr) => (
                      <tr key={wr.id} className="hover:bg-slate-50/70 transition">
                        <td className="py-3 px-3 font-mono font-bold text-slate-700">#WR-{wr.id}</td>
                        <td className="py-3 px-3 font-semibold text-slate-800">{wr.reporter_identifier}</td>
                        <td className="py-3 px-3 max-w-xs text-slate-600">"{wr.incident_description}"</td>
                        <td className="py-3 px-3">
                          <span
                            className={`px-2 py-0.5 rounded font-mono font-bold text-[10px] uppercase ${
                              wr.review_status === "POSSIBLE_DUPLICATE"
                                ? "bg-amber-50 text-amber-800 border border-amber-200 animate-pulse"
                                : wr.review_status === "CONFIRMED_DUPLICATE"
                                ? "bg-purple-50 text-purple-800 border border-purple-200"
                                : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {wr.review_status}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-slate-800">
                          {wr.duplicate_probability ? `${Math.round(wr.duplicate_probability * 100)}%` : "N/A"}
                        </td>
                        <td className="py-3 px-3 font-mono text-blue-700">
                          {wr.master_incident_id ? `#${wr.master_incident_id}` : wr.matching_incident_id ? `Match: #${wr.matching_incident_id}` : "None"}
                        </td>
                        <td className="py-3 px-3">
                          {wr.review_status === "POSSIBLE_DUPLICATE" && wr.matching_incident_id ? (
                            <div className="flex gap-1.5">
                              <button
                                onClick={() => handleLinkWitness(wr.id, wr.matching_incident_id)}
                                className="px-2 py-1 rounded bg-purple-600 hover:bg-purple-700 text-white font-bold text-[10px] cursor-pointer"
                              >
                                Link #{wr.matching_incident_id}
                              </button>
                              <button
                                onClick={() => handleMarkWitnessDistinct(wr.id, false)}
                                className="px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-[10px] border border-slate-200 cursor-pointer"
                              >
                                Distinct
                              </button>
                            </div>
                          ) : (
                            <span className="text-slate-400 text-[10px] font-mono">Reviewed</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW 6: DISPATCH HISTORY & ESCALATIONS                         */}
          {/* ============================================================== */}
          {activeNav === "history" && (
            <div className="flex-1 bg-white rounded-xl border border-slate-200 p-4 overflow-y-auto space-y-4">
              <div className="pb-3 border-b border-slate-100">
                <h2 className="text-base font-bold text-slate-900">Historical Dispatches & Escalation Audit</h2>
                <p className="text-xs text-slate-500">Record of ambulance dispatches, confirmations, reassignments, and outcomes</p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-500 font-mono uppercase text-[10px] border-b border-slate-200">
                    <tr>
                      <th className="py-2.5 px-3">Dispatch ID</th>
                      <th className="py-2.5 px-3">Incident</th>
                      <th className="py-2.5 px-3">Ambulance</th>
                      <th className="py-2.5 px-3">Destination ER</th>
                      <th className="py-2.5 px-3">Coordination</th>
                      <th className="py-2.5 px-3">Attempt</th>
                      <th className="py-2.5 px-3">Distance & ETA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {dispatches.map((disp) => (
                      <tr key={disp.id} className="hover:bg-slate-50/70 transition">
                        <td className="py-3 px-3 font-mono font-bold text-slate-700">#DSP-{disp.id}</td>
                        <td className="py-3 px-3 font-mono text-blue-700 font-bold">#{disp.incident_id}</td>
                        <td className="py-3 px-3 font-bold text-slate-800">Amb #{disp.ambulance_id}</td>
                        <td className="py-3 px-3 text-slate-700">Hospital #{disp.destination_hospital_id || "TBD"}</td>
                        <td className="py-3 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                              disp.coordination_status === "CONFIRMED"
                                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                : disp.coordination_status === "PENDING_CONFIRMATIONS"
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {disp.coordination_status}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-slate-800">
                          #{disp.attempt_number || 1}
                        </td>
                        <td className="py-3 px-3 font-mono text-slate-600">
                          {formatDistance(disp.route_distance_meters || 0)} • {formatDuration(disp.estimated_eta_seconds || 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* VIEW 7: PLATFORM SETTINGS & ROLE-BASED FOUNDATION             */}
          {/* ============================================================== */}
          {activeNav === "settings" && (
            <div className="flex-1 bg-white rounded-xl border border-slate-200 p-6 overflow-y-auto space-y-6">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Role-Based Emergency Platform Architecture</h2>
                <p className="text-xs text-slate-500">
                  LIFELINK / ResQFlow multi-stakeholder ecosystem foundation for Mangaluru operational corridor
                </p>
              </div>

              {/* 4 Roles Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <User className="w-5 h-5 text-red-600" />
                      <h3 className="font-bold text-slate-900 text-sm">1. Citizen SOS / Emergency Reporter</h3>
                    </div>
                    <p className="text-xs text-slate-600 leading-snug mt-1">
                      Web & future mobile app for civilians to broadcast real-time GPS emergency alerts, report symptoms, and view live incoming ambulance ETA.
                    </p>
                    <div className="text-[10px] font-mono text-slate-500 pt-1">
                      Permissions: Register Incident, Submit Witness Report, Stream Location.
                    </div>
                  </div>
                  <a
                    href="/citizen"
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 text-xs font-bold transition w-fit"
                  >
                    Launch Citizen Portal &rarr;
                  </a>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Ambulance className="w-5 h-5 text-blue-600" />
                      <h3 className="font-bold text-slate-900 text-sm">2. Ambulance Paramedic Crew Terminal</h3>
                    </div>
                    <p className="text-xs text-slate-600 leading-snug mt-1">
                      In-vehicle terminal allowing paramedics to accept or decline provisional dispatches within the 90s reservation TTL, update transit states, and view clinical patient briefings.
                    </p>
                    <div className="text-[10px] font-mono text-slate-500 pt-1">
                      Permissions: Confirm Dispatch, Step Lifecycle, Update GPS Telemetry.
                    </div>
                  </div>
                  <a
                    href="/ambulance"
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 text-xs font-bold transition w-fit"
                  >
                    Launch Paramedic Terminal &rarr;
                  </a>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Building2 className="w-5 h-5 text-emerald-600" />
                      <h3 className="font-bold text-slate-900 text-sm">3. Hospital ER Triage Intake Staff</h3>
                    </div>
                    <p className="text-xs text-slate-600 leading-snug mt-1">
                      Hospital emergency desk console receiving pre-arrival digital Handover Packets, confirming bed capacity reservations, and acknowledging patient arrivals.
                    </p>
                    <div className="text-[10px] font-mono text-slate-500 pt-1">
                      Permissions: Confirm ER Bay Reservation, Acknowledge Pre-Arrival Packet, Update Bed Counts.
                    </div>
                  </div>
                  <a
                    href="/hospital"
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 text-xs font-bold transition w-fit"
                  >
                    Launch Hospital ER Console &rarr;
                  </a>
                </div>

                <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 flex flex-col justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Shield className="w-5 h-5 text-purple-600" />
                      <h3 className="font-bold text-slate-900 text-sm">4. Central Dispatcher HQ (Current Web App)</h3>
                    </div>
                    <p className="text-xs text-slate-600 leading-snug mt-1">
                      Central regional operations command center with interactive GIS map, multi-factor allocation engine, smart auto-escalation oversight, and audit timeline stream.
                    </p>
                    <div className="text-[10px] font-mono text-slate-500 pt-1">
                      Permissions: Full Operations Oversight, Override Reassignments, Witness Deduplication.
                    </div>
                  </div>
                  <a
                    href="/dispatcher"
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200 text-xs font-bold transition w-fit"
                  >
                    Launch Dispatcher HQ &rarr;
                  </a>
                </div>
              </div>

              {/* System Specs */}
              <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-2 text-xs">
                <h4 className="font-bold text-slate-800">Operational Configuration (Mangaluru Region)</h4>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 font-mono text-[11px] text-slate-600">
                  <div>
                    <span className="text-slate-400 block text-[10px]">Reservation TTL:</span>
                    <strong className="text-slate-900">90 Seconds</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Escalation Worker:</span>
                    <strong className="text-slate-900">5s Async Loop</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Deduplication Radius:</span>
                    <strong className="text-slate-900">500 Meters</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Deduplication Window:</span>
                    <strong className="text-slate-900">15 Minutes</strong>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Emergency Registration Modal */}
      <IncidentRegistrationModal
        isOpen={isRegistrationOpen}
        onClose={() => setIsRegistrationOpen(false)}
        onIncidentCreated={(created) => {
          fetchData();
          setSelectedIncident(created);
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

      {/* Emergency Handover Packet Modal */}
      <HandoverModal
        isOpen={isHandoverModalOpen}
        onClose={() => setIsHandoverModalOpen(false)}
        dispatch={currentDispatch}
        incident={selectedIncident}
        onAcknowledge={() => currentDispatch && handleAcknowledgeHandover(currentDispatch.id)}
      />
    </div>
  );
}
