"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  Ambulance,
  Building2,
  CheckCircle2,
  Clock,
  Compass,
  Crosshair,
  Heart,
  LogOut,
  MapPin,
  Mic,
  MicOff,
  Navigation,
  PhoneCall,
  Radio,
  RefreshCw,
  Send,
  Shield,
  ShieldAlert,
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
  { id: "CARDIAC", label: "Cardiac / Chest Pain", icon: "🫀", complaint: "Severe crushing chest pain, sweating, shortness of breath", isCardiac: true },
  { id: "BREATHING", label: "Breathing Difficulty", icon: "🫁", complaint: "Severe respiratory distress, gasping for air", isBreathing: true },
  { id: "TRAUMA", label: "Accident / Trauma", icon: "🩸", complaint: "Major road accident, visible trauma, severe bleeding", isTrauma: true },
  { id: "STROKE", label: "Suspected Stroke", icon: "🧠", complaint: "Sudden facial droop, arm weakness, speech difficulty", isStroke: true },
  { id: "OTHER", label: "Other Emergency", icon: "⚠️", complaint: "Acute high-risk medical crisis, immediate assistance required", isOther: true },
];

const MANGALURU_LANDMARKS = [
  { name: "Hampankatta (City Centre)", lat: 12.8700, lng: 74.8420 },
  { name: "Kuntikana (NH 66)", lat: 12.8990, lng: 74.8465 },
  { name: "Kankanady (Highlands)", lat: 12.8640, lng: 74.8570 },
  { name: "Pumpwell (Mahaveera Circle)", lat: 12.8615, lng: 74.8700 },
  { name: "Kodialbail", lat: 12.8805, lng: 74.8430 },
  { name: "Surathkal Hub", lat: 12.9815, lng: 74.7950 },
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

  // Form selections
  const [selectedCategory, setSelectedCategory] = useState(EMERGENCY_CATEGORIES[0]);
  const [customNotes, setCustomNotes] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);

  // Location state
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number; accuracy?: number }>({
    lat: 12.8718,
    lng: 74.8458,
    accuracy: 15,
  });
  const [gpsStatus, setGpsStatus] = useState<"ACQUIRING" | "ACQUIRED" | "DENIED" | "MANUAL">("ACQUIRING");
  const [selectedAddress, setSelectedAddress] = useState("Hampankatta, Mangaluru, Karnataka");

  const isSubmittingRef = useRef(false);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Acquire Browser Geolocation
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
        setVoiceFeedback("Voice timeout. You may type symptoms below.");
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

      const savedIncId = localStorage.getItem("lifelink_active_incident_id");
      if (savedIncId) {
        const incResp = await fetch(`${backendUrl}/api/incidents/${savedIncId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (incResp.ok) {
          const incData = await incResp.json();
          if (incData.status !== "RESOLVED" && incData.status !== "CANCELLED") {
            setActiveIncident(incData);

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

  // WebSocket Live Updates
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

          if (eventType === "INCIDENT_STATUS_UPDATED" && activeIncident && payload.incident_id === activeIncident.id) {
            setActiveIncident((prev: any) => (prev ? { ...prev, status: payload.status } : prev));
          }

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

          if (eventType === "DISPATCH_LIFECYCLE_STEPPED" && activeIncident && payload.incident_id === activeIncident.id) {
            setActiveDispatch((prev: any) =>
              prev ? { ...prev, status: payload.status, estimated_eta_seconds: payload.estimated_eta_seconds } : prev
            );
          }

          if (eventType === "INCIDENT_RESOLVED" && activeIncident && payload.incident_id === activeIncident.id) {
            setActiveIncident((prev: any) => (prev ? { ...prev, status: "RESOLVED" } : prev));
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

  // Submit Immediate SOS
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
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-red-600" />
          <span className="text-xs font-bold text-slate-700">Connecting to LIFELINK Emergency Corridor...</span>
        </div>
      </div>
    );
  }

  // Calculate timeline stage (1 to 5)
  const getTimelineStage = () => {
    if (!activeIncident) return 1;
    if (activeIncident.status === "RESOLVED") return 5;
    if (!activeDispatch) return 2;
    if (activeDispatch.status === "COMPLETED") return 5;
    if (activeDispatch.status === "ON_SCENE") return 4;
    if (activeDispatch.status === "EN_ROUTE_HOSPITAL") return 4;
    if (activeDispatch.status === "EN_ROUTE_INCIDENT") return 3;
    if (activeDispatch.coordination_status === "CONFIRMED") return 3;
    return 2;
  };

  const currentStage = getTimelineStage();

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col font-sans">
      {/* Minimal Top Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-30 px-4 py-3 sm:px-6">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-red-600 flex items-center justify-center text-white shadow-sm">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base tracking-tight text-slate-900">LIFELINK</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 uppercase">
                  Citizen SOS
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium">Mangaluru Regional Emergency Service</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <a
              href="tel:112"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 text-xs font-bold transition"
              title="Direct call to India ERSS 112"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Call 112</span>
            </a>

            <button
              onClick={handleLogout}
              className="p-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-3xl w-full mx-auto p-4 sm:p-6 flex flex-col justify-center">
        {errorMessage && (
          <div className="mb-4 p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button onClick={() => setErrorMessage(null)} className="text-red-700 font-bold ml-2">✕</button>
          </div>
        )}

        {/* ============================================================== */}
        {/* VIEW 1: THREE PRIMARY ACTIONS (When no active incident)       */}
        {/* ============================================================== */}
        {!activeIncident ? (
          <div className="space-y-8 py-4">
            {/* Instruction Title */}
            <div className="text-center space-y-1">
              <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                Emergency Medical Assistance
              </h1>
              <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto">
                Press the button below to alert regional dispatch, the nearest Advanced Life Support ambulance, and receiving hospital.
              </p>
            </div>

            {/* ACTION 1: LARGE CIRCULAR RED SOS BUTTON */}
            <div className="flex flex-col items-center justify-center pt-2 pb-4">
              <button
                type="button"
                onClick={handleSubmitSos}
                disabled={isSubmitting}
                className={`group relative w-48 h-48 sm:w-56 sm:h-56 rounded-full bg-red-600 hover:bg-red-700 text-white flex flex-col items-center justify-center shadow-xl shadow-red-200 transition-all duration-200 cursor-pointer active:scale-95 focus:outline-none focus:ring-4 focus:ring-red-200 ${
                  isSubmitting ? "opacity-75 cursor-not-allowed" : ""
                }`}
                aria-label="Send Emergency SOS"
              >
                {/* Subtle pulse ring */}
                <span className="absolute inset-0 rounded-full border-4 border-red-400/40 animate-ping opacity-30" />
                
                <div className="flex flex-col items-center gap-1 z-10">
                  <AlertCircle className="w-12 h-12 sm:w-14 sm:h-14 stroke-[2.5]" />
                  <span className="text-3xl sm:text-4xl font-black tracking-wider">SOS</span>
                  <span className="text-[11px] font-semibold text-red-100 uppercase tracking-widest mt-0.5">
                    {isSubmitting ? "Broadcasting..." : "Press to Alert"}
                  </span>
                </div>
              </button>

              <p className="text-xs font-semibold text-slate-500 mt-4 text-center">
                Press SOS to request immediate emergency assistance.
              </p>
            </div>

            {/* ACTION 2: CALL 112 BACKUP BANNER */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
                  <PhoneCall className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-900">National Emergency Support (India ERSS)</p>
                  <p className="text-[11px] text-slate-500">Need immediate voice guidance? Dial 112 toll-free from any phone.</p>
                </div>
              </div>
              <a
                href="tel:112"
                className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shrink-0"
              >
                Call 112
              </a>
            </div>

            {/* ACTION 3: EMERGENCY GPS & LOCATION CARD */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-2xs space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-md bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                    <Crosshair className={`w-4 h-4 ${gpsStatus === "ACQUIRING" ? "animate-spin" : ""}`} />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-slate-900 block">Emergency Location</span>
                    <span className="text-[11px] text-slate-500">
                      {gpsStatus === "ACQUIRED"
                        ? `GPS Fixed (±${gpsCoords.accuracy}m accuracy)`
                        : gpsStatus === "ACQUIRING"
                        ? "Acquiring GPS fix..."
                        : "Using manual landmark location"}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={acquireGps}
                  className="px-2.5 py-1 rounded-md border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-medium flex items-center gap-1 transition"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Update GPS</span>
                </button>
              </div>

              {/* Coordinates Pill */}
              <div className="flex items-center gap-2 text-xs bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <MapPin className="w-4 h-4 text-red-600 shrink-0" />
                <span className="font-semibold text-slate-900 truncate">{selectedAddress}</span>
                <span className="text-[11px] text-slate-500 ml-auto font-mono shrink-0">
                  {gpsCoords.lat.toFixed(4)}°N, {gpsCoords.lng.toFixed(4)}°E
                </span>
              </div>

              {/* Quick Landmark Fallback */}
              <div>
                <p className="text-[11px] font-semibold text-slate-500 mb-1.5">Or tap nearby Mangaluru landmark:</p>
                <div className="flex flex-wrap gap-1.5">
                  {MANGALURU_LANDMARKS.map((loc) => (
                    <button
                      key={loc.name}
                      type="button"
                      onClick={() => {
                        setGpsCoords({ lat: loc.lat, lng: loc.lng, accuracy: 25 });
                        setSelectedAddress(loc.name);
                        setGpsStatus("MANUAL");
                      }}
                      className={`px-2.5 py-1 rounded-md text-xs font-medium border transition ${
                        selectedAddress.includes(loc.name)
                          ? "bg-blue-50 border-blue-300 text-blue-700 font-bold"
                          : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {loc.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* EMERGENCY CATEGORY SELECTION */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 shadow-2xs space-y-3">
              <span className="text-xs font-bold text-slate-900 block">Select Primary Emergency Category</span>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {EMERGENCY_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`p-2.5 rounded-lg border text-left transition flex items-center gap-2 ${
                      selectedCategory.id === cat.id
                        ? "bg-red-50 border-red-300 text-red-900 ring-1 ring-red-400"
                        : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <span className="text-base">{cat.icon}</span>
                    <span className="text-xs font-bold leading-tight">{cat.label}</span>
                  </button>
                ))}
              </div>

              {/* Optional Voice Dictation / Note Input */}
              <div className="pt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-semibold text-slate-500">Optional: Additional Details or Symptoms</span>
                  <button
                    type="button"
                    onClick={toggleVoiceRecording}
                    className={`flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded border transition ${
                      isListening
                        ? "bg-red-100 border-red-300 text-red-700 animate-pulse"
                        : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {isListening ? <MicOff className="w-3 h-3 text-red-600" /> : <Mic className="w-3 h-3 text-slate-500" />}
                    <span>{isListening ? "Listening..." : "Voice Input"}</span>
                  </button>
                </div>
                <input
                  type="text"
                  value={customNotes}
                  onChange={(e) => setCustomNotes(e.target.value)}
                  placeholder="e.g. Patient is conscious, severe chest pain radiating to left arm..."
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 bg-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
                />
                {voiceFeedback && (
                  <p className="text-[11px] text-blue-600 mt-1 italic">{voiceFeedback}</p>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* ============================================================== */
          /* VIEW 2: INCIDENT TRACKING SCREEN (Replaces SOS screen)        */
          /* ============================================================== */
          <div className="space-y-6 py-2">
            {/* Header: Status Banner */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 text-center space-y-2">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-100 border border-red-200 text-red-800 text-xs font-bold">
                <Radio className="w-3.5 h-3.5 animate-pulse text-red-600" />
                <span>ACTIVE EMERGENCY RESPONSE IN PROGRESS</span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-slate-900">
                Incident #{activeIncident.id}
              </h2>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Location: {activeIncident.location_address} • Complaint: {activeIncident.chief_complaint}
              </p>
            </div>

            {/* 5-STAGE PROGRESS TIMELINE */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-2xs space-y-4">
              <span className="text-xs font-bold text-slate-900 block uppercase tracking-wider">
                Emergency Response Timeline
              </span>
              <div className="relative flex items-center justify-between">
                {/* Horizontal Track Line */}
                <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1 bg-slate-100 z-0" />
                <div
                  className="absolute left-0 top-1/2 -translate-y-1/2 h-1 bg-emerald-500 z-0 transition-all duration-500"
                  style={{ width: `${((currentStage - 1) / 4) * 100}%` }}
                />

                {[
                  { num: 1, label: "SOS Received" },
                  { num: 2, label: "Triage & Allocation" },
                  { num: 3, label: "Ambulance En Route" },
                  { num: 4, label: "On Scene" },
                  { num: 5, label: "Hospital ER" },
                ].map((step) => {
                  const isDone = currentStage >= step.num;
                  const isCurrent = currentStage === step.num;
                  return (
                    <div key={step.num} className="relative z-10 flex flex-col items-center">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs transition-all ${
                          isDone
                            ? "bg-emerald-600 text-white shadow-xs"
                            : isCurrent
                            ? "bg-blue-600 text-white ring-4 ring-blue-100"
                            : "bg-white border-2 border-slate-200 text-slate-400"
                        }`}
                      >
                        {isDone ? <CheckCircle2 className="w-4 h-4" /> : step.num}
                      </div>
                      <span
                        className={`text-[10px] font-semibold mt-1.5 text-center hidden sm:block ${
                          isCurrent ? "text-blue-700 font-bold" : isDone ? "text-slate-800" : "text-slate-400"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* DISPATCH ASSIGNMENT CARDS */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Ambulance Assignment */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                    <Ambulance className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-slate-500 uppercase">Assigned Ambulance</span>
                    <p className="text-sm font-bold text-slate-900">
                      {activeDispatch?.ambulance_call_sign || "Selecting optimal unit..."}
                    </p>
                  </div>
                </div>
                {activeDispatch?.estimated_eta_seconds && (
                  <div className="p-2 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-between text-xs font-semibold text-blue-900">
                    <span>Estimated Arrival Time:</span>
                    <span className="font-bold font-mono">
                      ~{Math.round(activeDispatch.estimated_eta_seconds / 60)} mins
                    </span>
                  </div>
                )}
              </div>

              {/* Hospital Assignment */}
              <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-[11px] font-semibold text-slate-500 uppercase">Destination Hospital</span>
                    <p className="text-sm font-bold text-slate-900">
                      {activeDispatch?.destination_hospital_name || "Coordinating trauma facility..."}
                    </p>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500">
                  Status:{" "}
                  <strong className="text-slate-800 font-semibold">
                    {activeDispatch?.hospital_confirmation_status === "ACCEPTED"
                      ? "Bed Reserved & ER Prepared"
                      : "Coordinating bed reservation"}
                  </strong>
                </p>
              </div>
            </div>

            {/* CALL 112 DIRECT EMERGENCY ACCESS */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
              <div>
                <p className="text-xs font-bold text-slate-900">Need Immediate Advice or Status Question?</p>
                <p className="text-[11px] text-slate-500">Regional emergency operators are active on 112.</p>
              </div>
              <a
                href="tel:112"
                className="w-full sm:w-auto px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition"
              >
                <PhoneCall className="w-3.5 h-3.5" />
                <span>Call 112 Helpline</span>
              </a>
            </div>

            {/* Reset / New SOS Action once complete */}
            <div className="pt-2 text-center">
              <button
                type="button"
                onClick={handleResetForNewSos}
                className="px-4 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition"
              >
                Report Another Emergency / New SOS
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Minimal Footer */}
      <footer className="border-t border-slate-200 bg-white py-3 px-4 text-center text-[11px] text-slate-400">
        LIFELINK Emergency Response Platform • Mangaluru District Administration & Health Services
      </footer>
    </div>
  );
}
