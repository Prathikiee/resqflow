"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Ambulance,
  CheckCircle2,
  Clock,
  MapPin,
  Radio,
  RefreshCw,
  LogOut,
  Building2,
  Mic,
  MicOff,
  Crosshair,
  PhoneCall,
  Volume2,
  ShieldAlert,
  ArrowRight,
  Send,
} from "lucide-react";

interface IncidentRecord {
  id: number;
  caller_name: string;
  caller_phone: string;
  location_address: string;
  latitude: number;
  longitude: number;
  chief_complaint: string;
  triage_level: string;
  triage_color: string;
  triage_score: number;
  required_ambulance_type: string;
  status: string;
  created_at: string;
}

interface DispatchRecord {
  id: number;
  incident_id: number;
  ambulance_id: number;
  ambulance_call_sign: string;
  destination_hospital_name: string;
  destination_hospital_id: number;
  destination_hospital_address?: string;
  coordination_status: string;
  ambulance_confirmation_status: string;
  hospital_confirmation_status: string;
  status: string;
  attempt_number: number;
  reservation_expires_at?: string;
  estimated_eta_seconds?: number;
  route_distance_meters?: number;
}

const EMERGENCY_CATEGORIES = [
  { id: "CARDIAC", label: "Cardiac / Severe Chest Pain", icon: "🫀", complaint: "Severe crushing chest pain, radiating to arm with sweating", isCardiac: true },
  { id: "BREATHING", label: "Severe Respiratory Distress", icon: "🫁", complaint: "Unable to breathe, gasping for air, acute asthma/choking", isBreathing: true },
  { id: "TRAUMA", label: "Road Accident / Trauma", icon: "🩸", complaint: "Major vehicular collision with severe bleeding and visible trauma", isTrauma: true },
  { id: "STROKE", label: "Suspected Acute Stroke", icon: "🧠", complaint: "Sudden facial droop, arm weakness, slurred speech", isStroke: true },
  { id: "OTHER", label: "Other Medical Crisis", icon: "⚠️", complaint: "Unconscious / high-risk acute medical emergency", isOther: true },
];

const MANGALURU_QUICK_LOCATIONS = [
  { name: "Hampankatta (City Centre)", lat: 12.8700, lng: 74.8420 },
  { name: "Kuntikana (NH 66)", lat: 12.8990, lng: 74.8465 },
  { name: "Kankanady (Highlands)", lat: 12.8640, lng: 74.8570 },
  { name: "Pumpwell (Mahaveera Circle)", lat: 12.8615, lng: 74.8700 },
  { name: "Kodialbail", lat: 12.8805, lng: 74.8430 },
  { name: "Surathkal", lat: 12.9815, lng: 74.7950 },
];

export default function CitizenPortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [activeIncident, setActiveIncident] = useState<IncidentRecord | null>(null);
  const [activeDispatch, setActiveDispatch] = useState<DispatchRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ACTION 1: SOS Message & Category State
  const [selectedCategory, setSelectedCategory] = useState(EMERGENCY_CATEGORIES[0]);
  const [customNotes, setCustomNotes] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);

  // ACTION 3: GPS Geolocation State
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number; accuracy?: number }>({
    lat: 12.8718,
    lng: 74.8458,
    accuracy: 15,
  });
  const [gpsStatus, setGpsStatus] = useState<"ACQUIRING" | "ACQUIRED" | "DENIED" | "MANUAL">("ACQUIRING");
  const [selectedAddress, setSelectedAddress] = useState("Hampankatta, Mangaluru, Karnataka");

  const isSubmittingRef = useRef(false);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Acquire Browser Geolocation (Action 3)
  const acquireGps = useCallback(() => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setGpsStatus("MANUAL");
      return;
    }

    setGpsStatus("ACQUIRING");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lng = Number(pos.coords.longitude.toFixed(6));
        const acc = Math.round(pos.coords.accuracy);
        setGpsCoords({ lat, lng, accuracy: acc });
        setGpsStatus("ACQUIRED");
        setSelectedAddress(`Live GPS Fix (${lat.toFixed(4)}, ${lng.toFixed(4)}) - Mangaluru`);
      },
      () => {
        // GPS permission denied or timed out -> Fallback cleanly without blocking SOS
        setGpsStatus("DENIED");
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 10000 }
    );
  }, []);

  // Web Speech Voice Dictation
  const toggleVoiceRecording = () => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceFeedback("Voice input not supported on this browser. Type below.");
      return;
    }

    if (isListening) {
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-IN";

      recognition.onstart = () => {
        setIsListening(true);
        setVoiceFeedback("Listening... Speak symptoms clearly.");
      };

      recognition.onresult = (e: any) => {
        const transcript = e.results[0][0].transcript;
        setCustomNotes((prev) => (prev ? `${prev}. ${transcript}` : transcript));
        setVoiceFeedback(`Captured: "${transcript}"`);
        setIsListening(false);
      };

      recognition.onerror = () => {
        setVoiceFeedback("Voice recognition timeout. Please type notes.");
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch (_) {
      setIsListening(false);
    }
  };

  // Fetch active incident or verify user
  const fetchActiveIncident = useCallback(async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) {
      router.push("/login");
      return;
    }

    try {
      const meResp = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) throw new Error("Session expired");
      const meData = await meResp.json();
      setUser(meData);

      // Check for previously saved active incident
      const savedIncId = localStorage.getItem("lifelink_active_incident_id");
      if (savedIncId) {
        const incResp = await fetch(`${backendUrl}/api/incidents/${savedIncId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (incResp.ok) {
          const incData = await incResp.json();
          if (incData.status !== "RESOLVED" && incData.status !== "CANCELLED") {
            setActiveIncident(incData);

            // Fetch any dispatches for this incident
            const dispResp = await fetch(`${backendUrl}/api/dispatch?incident_id=${savedIncId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (dispResp.ok) {
              const disps = await dispResp.json();
              if (disps.length > 0) {
                setActiveDispatch(disps[0]);
              }
            }
          } else {
            localStorage.removeItem("lifelink_active_incident_id");
          }
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to connect to backend");
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router]);

  useEffect(() => {
    fetchActiveIncident();
    acquireGps();
  }, [fetchActiveIncident, acquireGps]);

  // Authenticated WebSocket Connection for Live Tracking
  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) return;

    let ws: WebSocket | null = null;
    let isCleanedUp = false;

    try {
      const wsUrl = `${backendUrl.replace(/^http/, "ws")}/ws?token=${token}`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (!isCleanedUp) setWsConnected(true);
      };

      ws.onmessage = (event) => {
        if (isCleanedUp) return;
        try {
          const msg = JSON.parse(event.data);
          const eventType = msg.event;
          const payload = msg.data;

          // Incident Status Update
          if (eventType === "INCIDENT_STATUS_UPDATED" && activeIncident && payload.incident_id === activeIncident.id) {
            setActiveIncident((prev: any) => prev ? { ...prev, status: payload.status } : prev);
          }

          // Provisional Reservation Alert / Dual Confirmation
          if (
            (eventType === "DISPATCH_PROVISIONAL_RESERVATION" ||
             eventType === "DISPATCH_CONFIRMATION_UPDATED" ||
             eventType === "DISPATCH_CONFIRMED") &&
            activeIncident &&
            payload.incident_id === activeIncident.id
          ) {
            setActiveDispatch((prev: any) => {
              if (!prev) {
                return {
                  id: payload.dispatch_id,
                  incident_id: payload.incident_id,
                  ambulance_id: payload.ambulance_id,
                  ambulance_call_sign: payload.ambulance_call_sign || "Assigned Ambulance",
                  destination_hospital_name: payload.hospital_name || "Assigned Emergency Dept",
                  destination_hospital_id: payload.destination_hospital_id,
                  coordination_status: payload.coordination_status || "PENDING_CONFIRMATIONS",
                  ambulance_confirmation_status: payload.ambulance_confirmation_status || "PENDING",
                  hospital_confirmation_status: payload.hospital_confirmation_status || "PENDING",
                  status: payload.status || "ASSIGNED",
                  attempt_number: payload.attempt_number || 1,
                  estimated_eta_seconds: payload.estimated_eta_seconds,
                };
              }
              return {
                ...prev,
                coordination_status: payload.coordination_status || prev.coordination_status,
                ambulance_confirmation_status: payload.ambulance_confirmation_status || prev.ambulance_confirmation_status,
                hospital_confirmation_status: payload.hospital_confirmation_status || prev.hospital_confirmation_status,
                status: payload.status || prev.status,
                estimated_eta_seconds: payload.estimated_eta_seconds ?? prev.estimated_eta_seconds,
              };
            });
          }

          // Mission Lifecycle Stepping
          if (eventType === "DISPATCH_LIFECYCLE_STEPPED" && activeIncident && payload.incident_id === activeIncident.id) {
            setActiveDispatch((prev: any) => prev ? { ...prev, status: payload.status, estimated_eta_seconds: payload.estimated_eta_seconds } : prev);
          }

          // Completion
          if (eventType === "INCIDENT_RESOLVED" && activeIncident && payload.incident_id === activeIncident.id) {
            setActiveIncident((prev: any) => prev ? { ...prev, status: "RESOLVED" } : prev);
            localStorage.removeItem("lifelink_active_incident_id");
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        if (!isCleanedUp) setWsConnected(false);
      };
    } catch (_) {}

    return () => {
      isCleanedUp = true;
      if (ws) ws.close();
    };
  }, [backendUrl, activeIncident]);

  // ACTION 1 EXECUTION: Submit Immediate SOS
  const handleSubmitSos = async () => {
    if (isSubmittingRef.current || isSubmitting) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);

    const token = localStorage.getItem("lifelink_token");
    const complaintText = customNotes
      ? `${selectedCategory.label}: ${customNotes}`
      : selectedCategory.complaint;

    const payload = {
      caller_name: user?.full_name || "Citizen Reporter",
      caller_phone: user?.phone_number || "+91 98450 11200",
      location_address: selectedAddress,
      latitude: gpsCoords.lat,
      longitude: gpsCoords.lng,
      chief_complaint: complaintText,
      chest_pain: selectedCategory.isCardiac || false,
      breathing_status: selectedCategory.isBreathing ? "Difficult" : "Normal",
      severe_trauma: selectedCategory.isTrauma || false,
      suspected_stroke: selectedCategory.isStroke || false,
      severe_bleeding: selectedCategory.isTrauma || false,
    };

    try {
      const resp = await fetch(`${backendUrl}/api/incidents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || "Emergency transmission failed.");
      }

      const createdInc: IncidentRecord = await resp.json();
      setActiveIncident(createdInc);
      localStorage.setItem("lifelink_active_incident_id", String(createdInc.id));

      // Attempt immediate auto-dispatch if supported or fetch dispatches
      setTimeout(async () => {
        try {
          const dispResp = await fetch(`${backendUrl}/api/dispatch?incident_id=${createdInc.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (dispResp.ok) {
            const disps = await dispResp.json();
            if (disps.length > 0) setActiveDispatch(disps[0]);
          }
        } catch (_) {}
      }, 1000);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to broadcast emergency SOS.");
    } finally {
      setIsSubmitting(false);
      isSubmittingRef.current = false;
    }
  };

  const handleResetForNewSos = () => {
    localStorage.removeItem("lifelink_active_incident_id");
    setActiveIncident(null);
    setActiveDispatch(null);
    setCustomNotes("");
    setErrorMessage(null);
    acquireGps();
  };

  const handleLogout = () => {
    localStorage.removeItem("lifelink_token");
    localStorage.removeItem("lifelink_user");
    localStorage.removeItem("lifelink_active_incident_id");
    document.cookie = "lifelink_token=; path=/; max-age=0;";
    router.push("/login");
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3 text-white">
          <RefreshCw className="w-8 h-8 animate-spin text-red-500" />
          <span className="text-sm font-semibold">Connecting to LIFELINK Emergency Corridor...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-red-500 selection:text-white">
      {/* ============================================================== */}
      {/* TOP EMERGENCY HEADER                                           */}
      {/* ============================================================== */}
      <header className="bg-slate-900 border-b border-slate-800 px-4 py-3 sm:px-6 sticky top-0 z-40 backdrop-blur-md">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-red-600 flex items-center justify-center shadow-lg shadow-red-600/30">
              <Radio className="w-5 h-5 text-white animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-black text-lg tracking-tight text-white">LIFELINK</span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-950 text-red-400 border border-red-800">
                  Citizen SOS
                </span>
              </div>
              <span className="text-[10px] text-slate-400 block -mt-0.5">Mangaluru Emergency Hub</span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* ACTION 2: CALL 112 DIRECT BUTTON IN HEADER */}
            <a
              href="tel:112"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black shadow-md transition transform active:scale-95"
              title="Direct call to India's 112 emergency service"
            >
              <PhoneCall className="w-4 h-4" />
              <span>Call 112</span>
            </a>

            <button
              onClick={handleLogout}
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 flex flex-col justify-center">
        {errorMessage && (
          <div className="mb-4 p-3.5 rounded-xl bg-red-950/80 border border-red-800 text-red-200 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button onClick={() => setErrorMessage(null)} className="text-red-400 font-bold ml-2">✕</button>
          </div>
        )}

        {/* ============================================================== */}
        {/* CONDITIONAL RENDERING:                                         */}
        {/* VIEW 1: THREE PRIMARY ACTIONS (When no active incident)       */}
        {/* VIEW 2: INCIDENT TRACKING SCREEN (Replaces view after SOS)    */}
        {/* ============================================================== */}

        {!activeIncident ? (
          <div className="space-y-6 animate-fade-in">
            {/* Header intro */}
            <div className="text-center space-y-1">
              <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">
                Emergency Medical Assistance
              </h1>
              <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto">
                Trigger high-priority dispatch to the nearest Advanced Life Support (ALS) ambulance and trauma center.
              </p>
            </div>

            {/* ACTION 3: EMERGENCY GPS LOCATION CARD */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-lg space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-blue-500/10 text-blue-400">
                    <Crosshair className={`w-4 h-4 ${gpsStatus === "ACQUIRING" ? "animate-spin" : ""}`} />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-white block uppercase tracking-wider">
                      3. Emergency GPS Location
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {gpsStatus === "ACQUIRED"
                        ? `GPS Locked: ±${gpsCoords.accuracy}m accuracy`
                        : gpsStatus === "ACQUIRING"
                        ? "Acquiring satellite fix..."
                        : "GPS fix unavailable (manual location active)"}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={acquireGps}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-blue-400 text-xs font-semibold flex items-center gap-1 transition"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Update GPS</span>
                </button>
              </div>

              {/* Coordinates & Selected Location Pill */}
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono bg-slate-950 p-2.5 rounded-xl border border-slate-800/80">
                <MapPin className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <span className="text-slate-300 font-bold">{selectedAddress}</span>
                <span className="text-slate-500 text-[10px] ml-auto">
                  {gpsCoords.lat.toFixed(4)}°N, {gpsCoords.lng.toFixed(4)}°E
                </span>
              </div>

              {/* Manual Location Fallback Options */}
              <div>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                  Or Tap Common Mangaluru Pickup Landmark:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {MANGALURU_QUICK_LOCATIONS.map((loc) => (
                    <button
                      key={loc.name}
                      type="button"
                      onClick={() => {
                        setGpsCoords({ lat: loc.lat, lng: loc.lng, accuracy: 25 });
                        setSelectedAddress(loc.name);
                        setGpsStatus("MANUAL");
                      }}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                        selectedAddress.includes(loc.name)
                          ? "bg-blue-600 border-blue-500 text-white font-bold"
                          : "bg-slate-800/60 border-slate-700/60 text-slate-300 hover:bg-slate-800 hover:text-white"
                      }`}
                    >
                      {loc.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* ACTION 1: SEND SOS / EMERGENCY MESSAGE (CENTERPIECE) */}
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 sm:p-7 shadow-2xl space-y-5">
              <div className="space-y-1">
                <span className="text-xs font-bold text-red-400 uppercase tracking-wider block">
                  1. Send SOS / Message
                </span>
                <h2 className="text-lg font-black text-white">Select Emergency Category:</h2>
              </div>

              {/* Quick Category Chips */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {EMERGENCY_CATEGORIES.map((cat) => {
                  const isSel = selectedCategory.id === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`p-3 rounded-2xl border text-left flex flex-col justify-between transition-all transform active:scale-98 ${
                        isSel
                          ? "bg-red-600/20 border-red-500 ring-2 ring-red-500 shadow-md"
                          : "bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-300"
                      }`}
                    >
                      <span className="text-2xl mb-1">{cat.icon}</span>
                      <span className={`text-xs font-bold leading-snug ${isSel ? "text-white" : "text-slate-300"}`}>
                        {cat.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Optional Voice Dictation / Short Message */}
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <label className="text-slate-400 font-medium">
                    Short message or symptoms (optional):
                  </label>
                  <button
                    type="button"
                    onClick={toggleVoiceRecording}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold transition ${
                      isListening
                        ? "bg-red-600 text-white animate-pulse"
                        : "bg-slate-800 text-slate-300 hover:text-white"
                    }`}
                  >
                    {isListening ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5 text-red-400" />}
                    <span>{isListening ? "Listening (Tap to Stop)" : "Voice Input"}</span>
                  </button>
                </div>

                <input
                  type="text"
                  value={customNotes}
                  onChange={(e) => setCustomNotes(e.target.value)}
                  placeholder={`e.g., "${selectedCategory.complaint}"`}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-600 focus:outline-hidden focus:ring-2 focus:ring-red-500"
                />

                {voiceFeedback && (
                  <span className="text-[10px] font-mono text-emerald-400 block">
                    {voiceFeedback}
                  </span>
                )}
              </div>

              {/* PROMINENT 1-TAP SOS BUTTON */}
              <button
                type="button"
                onClick={handleSubmitSos}
                disabled={isSubmitting}
                className="w-full py-4 rounded-2xl bg-linear-to-r from-red-600 via-red-500 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white font-black text-lg sm:text-xl shadow-xl shadow-red-600/30 flex items-center justify-center gap-3 transition transform active:scale-98 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? (
                  <>
                    <RefreshCw className="w-6 h-6 animate-spin" />
                    <span>TRANSMITTING EMERGENCY SOS...</span>
                  </>
                ) : (
                  <>
                    <Radio className="w-6 h-6 animate-pulse" />
                    <span>🚨 SEND IMMEDIATE SOS</span>
                  </>
                )}
              </button>
            </div>

            {/* ACTION 2: CALL 112 FULL BANNER */}
            <div className="bg-emerald-950/40 border border-emerald-800/60 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="space-y-1 text-center sm:text-left">
                <div className="flex items-center justify-center sm:justify-start gap-2 text-emerald-400 font-bold text-xs uppercase tracking-wider">
                  <PhoneCall className="w-4 h-4" />
                  <span>2. Official National Emergency Call: 112</span>
                </div>
                <p className="text-xs text-slate-300 max-w-md">
                  Direct telephone contact with India&apos;s National Emergency Response Support System (ERSS).
                  Connects to emergency police, fire & medical call takers.
                </p>
                <span className="text-[10px] text-slate-400 block">
                  LIFELINK coordinates parallel digital hospital bed & ambulance reservation.
                </span>
              </div>

              <a
                href="tel:112"
                className="px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-black text-base shadow-lg shadow-emerald-600/25 flex items-center gap-2 transition shrink-0"
              >
                <PhoneCall className="w-5 h-5" />
                <span>DIAL 112 NOW</span>
              </a>
            </div>
          </div>
        ) : (
          /* ============================================================== */
          /* VIEW 2: INCIDENT TRACKING SCREEN                               */
          /* Replaces initial actions once SOS is created                  */
          /* ============================================================== */
          <div className="space-y-6 animate-fade-in">
            {/* Status Hero Card */}
            <div className="bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-5">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-full bg-red-600/20 border border-red-500 text-red-400 font-mono text-xs font-black">
                      Incident #{activeIncident.id}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                      SOS Received by Regional HQ
                    </span>
                  </div>
                  <h1 className="text-xl sm:text-2xl font-black text-white mt-1">
                    Emergency Response Active
                  </h1>
                  <span className="text-xs text-slate-400">
                    Reported Location: {activeIncident.location_address}
                  </span>
                </div>

                <div className="text-left sm:text-right">
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 block font-mono">
                    Acuity Level
                  </span>
                  <span className="text-sm font-black text-red-400">
                    {activeIncident.triage_level}
                  </span>
                </div>
              </div>

              {/* Live Assignment Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Ambulance Assignment */}
                <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4.5 space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center gap-1.5 font-bold text-white">
                      <Ambulance className="w-4 h-4 text-blue-400" />
                      Ambulance Assignment
                    </span>
                    <span className="font-mono text-blue-400 font-bold">
                      {activeDispatch?.ambulance_call_sign || "Matching Unit..."}
                    </span>
                  </div>

                  {activeDispatch ? (
                    <div className="space-y-1 pt-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-300">Vehicle Identifier:</span>
                        <span className="text-xs font-mono font-bold text-white">
                          {activeDispatch.ambulance_call_sign}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-300">Crew Status:</span>
                        <span className="text-xs font-bold text-emerald-400">
                          {activeDispatch.status.replace(/_/g, " ")}
                        </span>
                      </div>
                      {activeDispatch.estimated_eta_seconds && (
                        <div className="flex items-center justify-between pt-1 border-t border-slate-800">
                          <span className="text-xs text-slate-300 flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5 text-amber-400" /> Estimated Arrival:
                          </span>
                          <span className="text-sm font-black font-mono text-amber-400">
                            ~{Math.ceil(activeDispatch.estimated_eta_seconds / 60)} mins
                          </span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-3 bg-slate-900 rounded-xl text-center">
                      <span className="text-xs text-slate-400 animate-pulse">
                        Allocating closest Advanced Life Support unit...
                      </span>
                    </div>
                  )}
                </div>

                {/* Hospital Assignment */}
                <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4.5 space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center gap-1.5 font-bold text-white">
                      <Building2 className="w-4 h-4 text-emerald-400" />
                      Hospital Assignment
                    </span>
                    <span className="font-mono text-emerald-400 font-bold">
                      {activeDispatch?.destination_hospital_name || "Matching Facility..."}
                    </span>
                  </div>

                  {activeDispatch ? (
                    <div className="space-y-1 pt-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-300">Destination Facility:</span>
                        <span className="text-xs font-bold text-white">
                          {activeDispatch.destination_hospital_name}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-300">Bed Reservation:</span>
                        <span className="text-xs font-bold text-emerald-400">
                          {activeDispatch.hospital_confirmation_status === "ACCEPTED"
                            ? "Confirmed & Reserved"
                            : "Provisional Hold (90s)"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between pt-1 border-t border-slate-800">
                        <span className="text-xs text-slate-300">Coordination State:</span>
                        <span className="text-xs font-mono font-bold text-blue-400">
                          {activeDispatch.coordination_status}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3 bg-slate-900 rounded-xl text-center">
                      <span className="text-xs text-slate-400 animate-pulse">
                        Matching receiving trauma center & reserving bed...
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* SIMPLE PROGRESS TIMELINE (5 STAGES) */}
              <div className="pt-2 space-y-3">
                <span className="text-xs font-bold text-slate-300 uppercase tracking-wider block">
                  Response Progress Timeline
                </span>

                <div className="space-y-3">
                  {[
                    {
                      label: "1. SOS Received by Regional HQ",
                      desc: "Incident triaged and verified",
                      isDone: true,
                    },
                    {
                      label: "2. Ambulance & Hospital Dual-Confirmed",
                      desc: "Both crew and trauma bay accepted assignment",
                      isDone: activeDispatch?.coordination_status === "CONFIRMED",
                      isActive: activeDispatch?.coordination_status === "PENDING_CONFIRMATIONS",
                    },
                    {
                      label: "3. Ambulance En Route to You",
                      desc: "Paramedics navigating to your coordinates",
                      isDone: ["EN_ROUTE_INCIDENT", "ON_SCENE", "EN_ROUTE_HOSPITAL", "COMPLETED"].includes(activeDispatch?.status || ""),
                      isActive: activeDispatch?.status === "EN_ROUTE_INCIDENT",
                    },
                    {
                      label: "4. Paramedics On Scene",
                      desc: "Unit arrived at patient location",
                      isDone: ["ON_SCENE", "EN_ROUTE_HOSPITAL", "COMPLETED"].includes(activeDispatch?.status || ""),
                      isActive: activeDispatch?.status === "ON_SCENE",
                    },
                    {
                      label: "5. Safe Hospital ER Handover",
                      desc: "Patient transferred to emergency physician",
                      isDone: activeDispatch?.status === "COMPLETED" || activeIncident.status === "RESOLVED",
                      isActive: activeDispatch?.status === "EN_ROUTE_HOSPITAL",
                    },
                  ].map((step, idx) => {
                    return (
                      <div key={idx} className="flex items-start gap-3">
                        <div className="mt-0.5">
                          {step.isDone ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                          ) : step.isActive ? (
                            <div className="w-5 h-5 rounded-full border-2 border-amber-400 flex items-center justify-center">
                              <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                            </div>
                          ) : (
                            <div className="w-5 h-5 rounded-full border border-slate-700 bg-slate-800" />
                          )}
                        </div>
                        <div>
                          <span className={`text-xs font-bold block ${step.isDone ? "text-emerald-400" : step.isActive ? "text-amber-400" : "text-slate-500"}`}>
                            {step.label}
                          </span>
                          <span className="text-[11px] text-slate-400">{step.desc}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <a
                  href="tel:112"
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5 transition"
                >
                  <PhoneCall className="w-4 h-4" />
                  <span>Call 112 (Voice Backup)</span>
                </a>

                <button
                  onClick={handleResetForNewSos}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition"
                >
                  Report Another Emergency
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
