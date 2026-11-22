"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Ambulance,
  ArrowLeft,
  Building2,
  Car,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Crosshair,
  Flame,
  HeartPulse,
  HelpCircle,
  LogOut,
  MapPin,
  MessageSquare,
  Mic,
  MicOff,
  Navigation,
  PhoneCall,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Volume2,
  X,
} from "lucide-react";

interface IncidentRecord {
  id: number;
  caller_name: string;
  caller_phone: string;
  location_address: string;
  latitude: number;
  longitude: number;
  chief_complaint: string;
  triage_level?: string;
  triage_color?: string;
  triage_score?: number;
  required_ambulance_type?: string;
  status: string;
  created_at: string;
}

interface DispatchRecord {
  id: number;
  incident_id: number;
  ambulance_id: number;
  ambulance_call_sign: string;
  ambulance_vehicle_type?: string;
  ambulance_current_latitude?: number;
  ambulance_current_longitude?: number;
  destination_hospital_name: string;
  destination_hospital_id: number;
  destination_hospital_address?: string;
  coordination_status: string;
  ambulance_confirmation_status: string;
  hospital_confirmation_status: string;
  patient_arrived_hospital_confirmed_at?: string;
  status: string;
  attempt_number: number;
  reservation_expires_at?: string;
  estimated_eta_seconds?: number;
  route_distance_meters?: number;
}

type CitizenView = "MAIN" | "TALK" | "TEXT";

type GpsStatus = "ACQUIRING" | "ACQUIRED" | "DENIED" | "TIMEOUT" | "UNAVAILABLE" | "MANUAL";

type EmergencyType = "MEDICAL" | "ACCIDENT" | "FIRE" | "OTHER";

interface Landmark {
  name: string;
  area: string;
  lat: number;
  lng: number;
}

const MANGALURU_LANDMARKS: Landmark[] = [
  { name: "Hampankatta (City Centre)", area: "Central Mangaluru", lat: 12.8700, lng: 74.8420 },
  { name: "Kuntikana (NH 66 Junction)", area: "North Corridor", lat: 12.8990, lng: 74.8465 },
  { name: "Kankanady (Highlands)", area: "South Central", lat: 12.8640, lng: 74.8570 },
  { name: "Pumpwell (Mahaveera Circle)", area: "National Highway Hub", lat: 12.8615, lng: 74.8700 },
  { name: "Kodialbail (MG Road)", area: "Civic District", lat: 12.8805, lng: 74.8430 },
  { name: "Surathkal (NITK / Beach Road)", area: "Coastal North", lat: 12.9815, lng: 74.7950 },
  { name: "Kadri Park Road", area: "Kadri Hills", lat: 12.8760, lng: 74.8560 },
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

  // Workflow navigation
  const [view, setView] = useState<CitizenView>("MAIN");

  // Location state
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number; accuracy?: number }>({
    lat: 12.8718,
    lng: 74.8458,
    accuracy: 15,
  });
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("ACQUIRING");
  const [selectedAddress, setSelectedAddress] = useState<string>("Hampankatta, Mangaluru, Karnataka");
  const [hasConfirmedLocation, setHasConfirmedLocation] = useState<boolean>(false);

  // Missing Location Modal state
  const [isLocationModalOpen, setIsLocationModalOpen] = useState(false);
  const [pendingFlow, setPendingFlow] = useState<"TALK" | "TEXT" | null>(null);
  const [manualInput, setManualInput] = useState("");

  // Cancel Incident Modal state
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);

  // Talk for Help state
  const [isListening, setIsListening] = useState(false);
  const [spokenTranscript, setSpokenTranscript] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceFeedback, setVoiceFeedback] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  // Text for Help state
  const [emergencyType, setEmergencyType] = useState<EmergencyType>("MEDICAL");
  const [incidentDescription, setIncidentDescription] = useState("");
  const [injuredCount, setInjuredCount] = useState<string>("1");
  const [showAdditionalInfo, setShowAdditionalInfo] = useState(false);
  const [specificLandmark, setSpecificLandmark] = useState("");
  const [flagUnconscious, setFlagUnconscious] = useState(false);
  const [flagBreathing, setFlagBreathing] = useState(false);
  const [flagSevereBleeding, setFlagSevereBleeding] = useState(false);
  const [flagChestPain, setFlagChestPain] = useState(false);

  const isSubmittingRef = useRef(false);
  const activeIncidentRef = useRef<IncidentRecord | null>(null);
  const activeDispatchRef = useRef<DispatchRecord | null>(null);
  const [isRefreshingTracking, setIsRefreshingTracking] = useState(false);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  useEffect(() => {
    activeIncidentRef.current = activeIncident;
  }, [activeIncident]);

  useEffect(() => {
    activeDispatchRef.current = activeDispatch;
  }, [activeDispatch]);

  // Check whether current location is considered valid and confirmed
  const isLocationReady = Boolean(
    (gpsStatus === "ACQUIRED" || gpsStatus === "MANUAL" || hasConfirmedLocation) &&
      selectedAddress.trim().length > 0 &&
      gpsCoords.lat !== 0
  );

  // Acquire Geolocation
  const acquireGps = useCallback((flowToResume?: "TALK" | "TEXT") => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setGpsStatus("UNAVAILABLE");
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
        setHasConfirmedLocation(true);
        setSelectedAddress(`Live GPS Fix (${lat.toFixed(4)}, ${lng.toFixed(4)}) - Mangaluru`);
        if (flowToResume) {
          setIsLocationModalOpen(false);
          setPendingFlow(null);
          setView(flowToResume);
        }
      },
      (err) => {
        if (err.code === 1) {
          setGpsStatus("DENIED");
        } else if (err.code === 3) {
          setGpsStatus("TIMEOUT");
        } else {
          setGpsStatus("UNAVAILABLE");
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
    );
  }, []);

  // Fetch active incident or verify user session
  const fetchActiveIncident = useCallback(async (isManualRefresh = false) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) {
      router.push("/login");
      return;
    }

    if (isManualRefresh) setIsRefreshingTracking(true);

    try {
      const meResp = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!meResp.ok) throw new Error("Session expired");
      const meData = await meResp.json();
      setUser(meData);

      const savedIncId = localStorage.getItem("lifelink_active_incident_id");
      let foundActive = false;

      if (savedIncId) {
        const incResp = await fetch(`${backendUrl}/api/incidents/${savedIncId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (incResp.ok) {
          const incData = await incResp.json();
          setActiveIncident(incData);
          foundActive = true;

          const dispResp = await fetch(`${backendUrl}/api/dispatch?incident_id=${savedIncId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (dispResp.ok) {
            const disps = await dispResp.json();
            if (disps.length > 0) {
              setActiveDispatch(disps[0]);
            }
          }
        }
      }

      // If no active incident found in local storage, query user's personal reported incidents
      if (!foundActive) {
        const listResp = await fetch(`${backendUrl}/api/incidents`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (listResp.ok) {
          const incidents = await listResp.json();
          const active = incidents.find(
            (inc: any) => inc.status !== "RESOLVED" && inc.status !== "CANCELLED" && inc.status !== "CLOSED"
          );
          if (active) {
            setActiveIncident(active);
            localStorage.setItem("lifelink_active_incident_id", String(active.id));
            const dispResp = await fetch(`${backendUrl}/api/dispatch?incident_id=${active.id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (dispResp.ok) {
              const disps = await dispResp.json();
              if (disps.length > 0) setActiveDispatch(disps[0]);
            }
          }
        }
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to connect to backend");
    } finally {
      setIsLoading(false);
      if (isManualRefresh) setIsRefreshingTracking(false);
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
          const payload = msg.payload || msg.data;
          if (!payload) return;

          const curInc = activeIncidentRef.current;
          const curDisp = activeDispatchRef.current;

          // 1. Incident status updates
          if (
            (eventType === "INCIDENT_STATUS_UPDATED" || eventType === "INCIDENT_CREATED") &&
            curInc &&
            payload.incident_id === curInc.id
          ) {
            setActiveIncident((prev: any) => (prev ? { ...prev, status: payload.status } : prev));
          }

          // 2. Dispatch creation & provisional reservation
          if (
            (eventType === "DISPATCH_PROVISIONAL_RESERVATION" ||
              eventType === "DISPATCH_CONFIRMATION_UPDATED" ||
              eventType === "DISPATCH_CONFIRMED" ||
              eventType === "DISPATCH_CREATED") &&
            curInc &&
            payload.incident_id === curInc.id
          ) {
            setActiveDispatch((prev: any) => {
              if (!prev) {
                return {
                  id: payload.dispatch_id,
                  incident_id: payload.incident_id,
                  ambulance_id: payload.ambulance_id,
                  ambulance_call_sign: payload.ambulance_call_sign || "Assigned Ambulance",
                  ambulance_vehicle_type: payload.ambulance_vehicle_type || "BLS",
                  ambulance_current_latitude: payload.ambulance_current_latitude,
                  ambulance_current_longitude: payload.ambulance_current_longitude,
                  destination_hospital_name: payload.destination_hospital_name || payload.hospital_name || "Assigned Emergency Dept",
                  destination_hospital_id: payload.destination_hospital_id,
                  destination_hospital_address: payload.destination_hospital_address,
                  coordination_status: payload.coordination_status || "PENDING_CONFIRMATIONS",
                  ambulance_confirmation_status: payload.ambulance_confirmation_status || payload.ambulance_confirmation || "PENDING",
                  hospital_confirmation_status: payload.hospital_confirmation_status || payload.hospital_confirmation || "PENDING",
                  status: payload.status || "ASSIGNED",
                  attempt_number: payload.attempt_number || 1,
                  estimated_eta_seconds: payload.estimated_eta_seconds,
                  route_distance_meters: payload.route_distance_meters,
                };
              }
              return {
                ...prev,
                ambulance_call_sign: payload.ambulance_call_sign || prev.ambulance_call_sign,
                ambulance_vehicle_type: payload.ambulance_vehicle_type || prev.ambulance_vehicle_type,
                destination_hospital_name: payload.destination_hospital_name || payload.hospital_name || prev.destination_hospital_name,
                destination_hospital_address: payload.destination_hospital_address || prev.destination_hospital_address,
                coordination_status: payload.coordination_status || prev.coordination_status,
                ambulance_confirmation_status: payload.ambulance_confirmation_status || payload.ambulance_confirmation || prev.ambulance_confirmation_status,
                hospital_confirmation_status: payload.hospital_confirmation_status || payload.hospital_confirmation || prev.hospital_confirmation_status,
                status: payload.status || prev.status,
                estimated_eta_seconds: payload.estimated_eta_seconds ?? prev.estimated_eta_seconds,
                route_distance_meters: payload.route_distance_meters ?? prev.route_distance_meters,
                ambulance_current_latitude: payload.ambulance_current_latitude ?? prev.ambulance_current_latitude,
                ambulance_current_longitude: payload.ambulance_current_longitude ?? prev.ambulance_current_longitude,
              };
            });
          }

          // 3. Dispatch lifecycle progression
          if (
            (eventType === "DISPATCH_STEPPED" || eventType === "DISPATCH_LIFECYCLE_STEPPED") &&
            curInc &&
            payload.incident_id === curInc.id
          ) {
            setActiveDispatch((prev: any) =>
              prev
                ? {
                    ...prev,
                    status: payload.status,
                    estimated_eta_seconds: payload.estimated_eta_seconds ?? prev.estimated_eta_seconds,
                  }
                : prev
            );
            if (payload.incident_status) {
              setActiveIncident((prev: any) => (prev ? { ...prev, status: payload.incident_status } : prev));
            }
          }

          // 4. Hospital arrival confirmed
          if (
            eventType === "PATIENT_ARRIVED_HOSPITAL" &&
            curInc &&
            payload.incident_id === curInc.id
          ) {
            setActiveDispatch((prev: any) =>
              prev
                ? {
                    ...prev,
                    status: "AT_HOSPITAL",
                    patient_arrived_hospital_confirmed_at: payload.patient_arrived_hospital_confirmed_at,
                  }
                : prev
            );
            setActiveIncident((prev: any) => (prev ? { ...prev, status: "AT_HOSPITAL" } : prev));
          }

          // 5. Ambulance status and real-time GPS telemetry
          if (
            eventType === "AMBULANCE_STATUS_UPDATED" &&
            curDisp &&
            payload.ambulance_id === curDisp.ambulance_id
          ) {
            setActiveDispatch((prev: any) =>
              prev
                ? {
                    ...prev,
                    ambulance_current_latitude: payload.current_latitude ?? prev.ambulance_current_latitude,
                    ambulance_current_longitude: payload.current_longitude ?? prev.ambulance_current_longitude,
                  }
                : prev
            );
          }

          // 6. Terminal incident statuses
          if (eventType === "INCIDENT_RESOLVED" && curInc && payload.incident_id === curInc.id) {
            setActiveIncident((prev: any) => (prev ? { ...prev, status: "RESOLVED" } : prev));
          }

          if (eventType === "INCIDENT_CANCELLED" && curInc && payload.incident_id === curInc.id) {
            setActiveIncident((prev: any) => (prev ? { ...prev, status: "CANCELLED" } : prev));
          }

          if (eventType === "INCIDENT_CLOSED" && curInc && payload.incident_id === curInc.id) {
            setActiveIncident((prev: any) => (prev ? { ...prev, status: "CLOSED" } : prev));
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
  }, [backendUrl]);

  // Speech Recognition Setup
  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
    }
    setIsListening(false);
  }, []);

  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceSupported(false);
      setVoiceFeedback("Voice recognition is not supported in this browser. Please type details below.");
      return;
    }

    try {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }

      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-IN";

      recognition.onstart = () => {
        setIsListening(true);
        setVoiceFeedback("Listening... Speak clearly about your emergency.");
      };

      recognition.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        const combined = final || interim;
        if (combined) {
          setSpokenTranscript((prev) => {
            const trimmedPrev = prev.trim();
            if (trimmedPrev && final) {
              return `${trimmedPrev} ${final.trim()}`;
            }
            return combined;
          });
          setVoiceFeedback(`Captured: "${combined.trim()}"`);
        }
      };

      recognition.onerror = (e: any) => {
        if (e.error !== "no-speech") {
          setVoiceFeedback("Voice recognition stopped. You can tap to record again or edit text below.");
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch (_) {
      setIsListening(false);
    }
  }, []);

  const toggleVoiceRecording = () => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  };

  // Symptom keyword extraction from transcript
  const detectedSymptomTags = React.useMemo(() => {
    const text = spokenTranscript.toLowerCase();
    const tags: { id: string; label: string; icon: any }[] = [];
    if (/chest pain|heart|cardiac|angina|attack/.test(text)) {
      tags.push({ id: "cardiac", label: "Cardiac Distress", icon: Activity });
    }
    if (/breath|breathing|shortness|asthma|chok|gasp/.test(text)) {
      tags.push({ id: "breathing", label: "Breathing Difficulty", icon: Activity });
    }
    if (/accident|crash|fall|injury|hit|fracture/.test(text)) {
      tags.push({ id: "trauma", label: "Trauma / Accident", icon: Car });
    }
    if (/bleed|blood|hemorrhage/.test(text)) {
      tags.push({ id: "bleeding", label: "Severe Bleeding", icon: AlertCircle });
    }
    if (/stroke|facial|weakness|slurred|paralysis/.test(text)) {
      tags.push({ id: "stroke", label: "Suspected Stroke", icon: AlertCircle });
    }
    if (/fire|burn|smoke|flame|explosion/.test(text)) {
      tags.push({ id: "fire", label: "Fire / Burns", icon: Flame });
    }
    return tags;
  }, [spokenTranscript]);

  // Initiate either Talk or Text workflow
  const handleSelectWorkflow = (targetFlow: "TALK" | "TEXT") => {
    if (!isLocationReady) {
      setPendingFlow(targetFlow);
      setManualInput(selectedAddress || "");
      setIsLocationModalOpen(true);
      return;
    }
    setView(targetFlow);
    if (targetFlow === "TALK") {
      setTimeout(() => startListening(), 400);
    }
  };

  // Confirm manual location from modal
  const handleConfirmManualLocation = () => {
    const trimmed = manualInput.trim();
    if (!trimmed) return;

    setSelectedAddress(trimmed);
    setGpsStatus("MANUAL");
    setHasConfirmedLocation(true);
    setIsLocationModalOpen(false);

    if (pendingFlow) {
      const flow = pendingFlow;
      setPendingFlow(null);
      setView(flow);
      if (flow === "TALK") {
        setTimeout(() => startListening(), 400);
      }
    }
  };

  // Quick select landmark
  const handleSelectLandmark = (landmark: Landmark) => {
    setGpsCoords({ lat: landmark.lat, lng: landmark.lng, accuracy: 20 });
    setSelectedAddress(`${landmark.name}, ${landmark.area}, Mangaluru`);
    setManualInput(`${landmark.name}, ${landmark.area}, Mangaluru`);
    setGpsStatus("MANUAL");
    setHasConfirmedLocation(true);
  };

  // Submit Emergency Request
  const handleSubmitEmergency = async (sourceFlow: "TALK" | "TEXT") => {
    if (isSubmittingRef.current || isSubmitting) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);

    const token = localStorage.getItem("lifelink_token");

    let complaintText = "";
    let isCardiac = false;
    let isBreathingDifficult = false;
    let isTrauma = false;
    let isStroke = false;
    let isBleeding = false;

    if (sourceFlow === "TALK") {
      complaintText = spokenTranscript.trim() || "Immediate emergency assistance requested via voice SOS.";
      const lower = complaintText.toLowerCase();
      isCardiac = /chest pain|heart|cardiac|angina/.test(lower);
      isBreathingDifficult = /breath|breathing|asthma|chok|gasp/.test(lower);
      isTrauma = /accident|crash|fall|injury|fracture/.test(lower);
      isStroke = /stroke|facial|weakness|slurred|paralysis/.test(lower);
      isBleeding = /bleed|blood/.test(lower);
    } else {
      const typeLabel =
        emergencyType === "MEDICAL"
          ? "Medical Emergency"
          : emergencyType === "ACCIDENT"
          ? "Road Accident"
          : emergencyType === "FIRE"
          ? "Fire / Rescue"
          : "Urgent Emergency";

      const details = incidentDescription.trim() || "Immediate responders required.";
      const injuredStr = injuredCount !== "Unknown" ? `Injured: ${injuredCount}` : "Injured count unknown";
      const landmarkStr = specificLandmark.trim() ? `Near: ${specificLandmark.trim()}` : "";

      complaintText = [typeLabel, details, injuredStr, landmarkStr].filter(Boolean).join(" - ");

      isCardiac = flagChestPain || emergencyType === "MEDICAL";
      isBreathingDifficult = flagBreathing;
      isTrauma = flagSevereBleeding || emergencyType === "ACCIDENT";
      isStroke = false;
      isBleeding = flagSevereBleeding;
    }

    const payload = {
      caller_name: user?.full_name || "Citizen Reporter",
      caller_phone: user?.phone_number || "+91 98450 11200",
      location_address: selectedAddress || "Mangaluru, Karnataka",
      latitude: gpsCoords.lat,
      longitude: gpsCoords.lng,
      chief_complaint: complaintText,
      chest_pain: isCardiac,
      breathing_status: isBreathingDifficult ? "Difficult" : "Normal",
      severe_trauma: isTrauma,
      suspected_stroke: isStroke,
      severe_bleeding: isBleeding,
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
        throw new Error(err.detail || "Emergency request transmission failed.");
      }

      const createdInc: IncidentRecord = await resp.json();
      setActiveIncident(createdInc);
      localStorage.setItem("lifelink_active_incident_id", String(createdInc.id));
      setView("MAIN");

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

  const handleCancelIncident = async () => {
    if (!activeIncident) return;
    setIsCancelling(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
      const res = await fetch(`${backendUrl}/api/incidents/${activeIncident.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: cancelReason || "Cancelled by citizen" }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || "Failed to cancel emergency request");
      }

      const updatedInc = await res.json();
      setActiveIncident(updatedInc);
      localStorage.removeItem("lifelink_active_incident_id");
      setIsCancelModalOpen(false);
      setCancelReason("");
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to cancel emergency request");
    } finally {
      setIsCancelling(false);
    }
  };

  const handleResetForNewSos = () => {
    localStorage.removeItem("lifelink_active_incident_id");
    setActiveIncident(null);
    setActiveDispatch(null);
    setSpokenTranscript("");
    setIncidentDescription("");
    setErrorMessage(null);
    setView("MAIN");
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

  // Emergency Category Detector
  const getEmergencyCategory = (complaint?: string, triageLevel?: string) => {
    const text = (complaint || "").toLowerCase();
    if (/cardiac|chest pain|heart|angina/.test(text)) return "Cardiac Emergency";
    if (/accident|crash|collision|trauma|fall|fracture/.test(text)) return "Road Trauma / Accident";
    if (/breath|respiratory|asthma|chok/.test(text)) return "Respiratory Distress";
    if (/fire|burn|flame|smoke/.test(text)) return "Fire & Rescue";
    if (/bleed|hemorrhage/.test(text)) return "Severe Hemorrhage";
    if (/stroke|paralysis/.test(text)) return "Neurological / Stroke";
    if (triageLevel) return `Triage ${triageLevel} Priority`;
    return "Medical Emergency";
  };

  // Calculate timeline stage (1 to 5)
  const getTimelineStage = () => {
    if (!activeIncident) return 1;
    if (activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED") return 5;
    if (activeIncident.status === "AT_HOSPITAL") return 5;
    if (!activeDispatch) {
      if (activeIncident.status === "TRIAGED" || activeIncident.status === "ALLOCATED") return 2;
      return 1;
    }
    if (activeDispatch.status === "COMPLETED" || activeDispatch.status === "AT_HOSPITAL") return 5;
    if (
      activeDispatch.status === "ON_SCENE" ||
      activeDispatch.status === "EN_ROUTE_HOSPITAL" ||
      activeIncident.status === "ON_SCENE" ||
      activeIncident.status === "TRANSPORTING"
    )
      return 4;
    if (
      activeDispatch.status === "EN_ROUTE_INCIDENT" ||
      activeDispatch.coordination_status === "CONFIRMED" ||
      activeIncident.status === "EN_ROUTE"
    )
      return 3;
    if (activeDispatch.status === "ASSIGNED" || activeIncident.status === "DISPATCHED") return 2;
    return 2;
  };

  // Contextual stage description for citizen
  const getStageDescription = () => {
    const stage = getTimelineStage();
    if (activeIncident?.status === "CANCELLED") {
      return "This emergency incident was cancelled. Dispatched ambulance and hospital bed reservations have been returned to active service.";
    }
    if (
      activeIncident?.status === "RESOLVED" ||
      activeIncident?.status === "CLOSED" ||
      activeDispatch?.status === "COMPLETED"
    ) {
      return "Emergency mission complete. Patient has been safely transferred to emergency department clinical care.";
    }
    switch (stage) {
      case 1:
        return "Your emergency SOS has been received and verified by the regional dispatch system. Clinical triage completed.";
      case 2:
        return activeDispatch?.ambulance_call_sign
          ? `Unit ${activeDispatch.ambulance_call_sign} provisionally allocated. Awaiting crew response and hospital ER bed reservation.`
          : "Regional emergency control is allocating the nearest available paramedic unit and receiving emergency department.";
      case 3:
        return activeDispatch?.ambulance_call_sign
          ? `Ambulance ${activeDispatch.ambulance_call_sign} has confirmed dispatch and is en route to your location. Keep phone line open.`
          : "Emergency crew has accepted the mission and is actively en route.";
      case 4:
        return activeDispatch?.status === "EN_ROUTE_HOSPITAL" || activeIncident?.status === "TRANSPORTING"
          ? "Paramedics have stabilized the patient on scene and are actively transporting to the receiving trauma department."
          : "Paramedic crew has arrived on scene and is evaluating and stabilizing the patient.";
      case 5:
        return "Ambulance has arrived at the emergency department. Clinical handover to hospital trauma bay is in progress.";
      default:
        return "Emergency services are actively responding to your emergency.";
    }
  };

  const currentStage = getTimelineStage();

  // Location display helper
  const getLocationStatusText = () => {
    if (gpsStatus === "ACQUIRING") return "Detecting location...";
    if (gpsStatus === "ACQUIRED") return "Location detected (GPS)";
    if (gpsStatus === "MANUAL" || hasConfirmedLocation) return "Location set";
    if (gpsStatus === "DENIED") return "Location denied - tap to set";
    if (gpsStatus === "TIMEOUT") return "Location timed out - tap to set";
    return "Location unavailable - tap to set";
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans antialiased">
      {/* Top Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-30 px-4 py-3 sm:px-6 shadow-2xs">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-600 flex items-center justify-center text-white shadow-xs">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base tracking-tight text-slate-900">LIFELINK</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 uppercase tracking-wider">
                  Citizen Portal
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium">Mangaluru Emergency Coordination</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* Location Pill */}
            <button
              type="button"
              onClick={() => {
                setManualInput(selectedAddress);
                setIsLocationModalOpen(true);
              }}
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition max-w-[220px] truncate bg-white hover:bg-slate-50 border-slate-200 text-slate-700"
              title="Click to view or edit emergency location"
            >
              <MapPin className="w-3.5 h-3.5 text-red-600 shrink-0" />
              <span className="truncate">{getLocationStatusText()}</span>
            </button>

            {/* Direct Call 112 Action */}
            <a
              href="tel:112"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 border border-red-200 text-red-700 text-xs font-bold transition"
              title="Direct call to India ERSS 112"
            >
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Call 112</span>
            </a>

            {/* Sign Out */}
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
      <main className="flex-1 max-w-4xl w-full mx-auto p-4 sm:p-6 flex flex-col justify-center">
        {errorMessage && (
          <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button onClick={() => setErrorMessage(null)} className="text-red-700 font-bold ml-2">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* VIEW: ACTIVE INCIDENT TRACKING (Replaces intake when active)   */}
        {/* ============================================================== */}
        {activeIncident ? (
          <div className="space-y-6 py-2">
            {/* Status Banner */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center space-y-3 shadow-xs">
              <div className="flex flex-wrap items-center justify-center gap-2">
                {/* WebSocket Pulse Badge */}
                <span
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold tracking-wide border ${
                    wsConnected
                      ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                      : "bg-amber-50 border-amber-200 text-amber-700"
                  }`}
                >
                  <Radio className={`w-3.5 h-3.5 ${wsConnected ? "animate-pulse text-emerald-600" : "text-amber-600"}`} />
                  <span>{wsConnected ? "Live Tracking Active" : "Corridor Syncing..."}</span>
                </span>

                {/* Emergency Category Badge */}
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-bold tracking-wide">
                  <Activity className="w-3.5 h-3.5 text-red-600" />
                  <span>{getEmergencyCategory(activeIncident.chief_complaint, activeIncident.triage_level)}</span>
                </span>

                {/* Triage Priority Badge */}
                {activeIncident.triage_level && (
                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold tracking-wide border ${
                      activeIncident.triage_color === "RED"
                        ? "bg-red-50 border-red-300 text-red-800"
                        : activeIncident.triage_color === "YELLOW"
                        ? "bg-amber-50 border-amber-300 text-amber-800"
                        : "bg-emerald-50 border-emerald-300 text-emerald-800"
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-current" />
                    <span>Priority: {activeIncident.triage_level}</span>
                  </span>
                )}
              </div>

              <div>
                <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                  Emergency Incident #{activeIncident.id}
                </h1>
                <div className="mt-1 flex items-center justify-center gap-2">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Status:</span>
                  <span
                    className={`text-xs font-extrabold px-2.5 py-0.5 rounded-md ${
                      activeIncident.status === "CANCELLED"
                        ? "bg-slate-100 text-slate-600"
                        : activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED"
                        ? "bg-emerald-100 text-emerald-800"
                        : activeDispatch?.status === "AT_HOSPITAL" || activeIncident.status === "AT_HOSPITAL"
                        ? "bg-purple-100 text-purple-800"
                        : activeDispatch?.status === "ON_SCENE"
                        ? "bg-blue-100 text-blue-800"
                        : "bg-red-100 text-red-800"
                    }`}
                  >
                    {activeIncident.status === "CANCELLED"
                      ? "CANCELLED"
                      : activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED"
                      ? "CASE RESOLVED"
                      : activeDispatch?.status
                      ? activeDispatch.status.replace(/_/g, " ")
                      : activeIncident.status}
                  </span>
                </div>
              </div>

              <div className="pt-1 space-y-1">
                <p className="text-xs sm:text-sm text-slate-700 max-w-lg mx-auto flex items-center justify-center gap-1.5">
                  <MapPin className="w-4 h-4 text-red-600 shrink-0" />
                  <span>
                    <strong className="text-slate-900 font-semibold">Location:</strong> {activeIncident.location_address}
                  </span>
                </p>
                <p className="text-xs text-slate-500 max-w-lg mx-auto">
                  <strong className="text-slate-700 font-medium">Complaint:</strong> {activeIncident.chief_complaint}
                </p>
              </div>
            </div>

            {/* 5-STAGE PROGRESS TIMELINE */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider block">
                  Emergency Response Timeline
                </span>
                <span className="text-[11px] font-semibold text-slate-400">
                  Step {currentStage} of 5
                </span>
              </div>

              <div className="relative flex items-center justify-between pt-2">
                {/* Horizontal Track Line */}
                <div className="absolute left-6 right-6 top-6 h-1 bg-slate-100 z-0" />
                <div
                  className="absolute left-6 top-6 h-1 bg-emerald-500 z-0 transition-all duration-500"
                  style={{ width: `${((currentStage - 1) / 4) * 85}%` }}
                />

                {[
                  { num: 1, label: "SOS Received" },
                  { num: 2, label: "Unit Allocated" },
                  { num: 3, label: "En Route" },
                  { num: 4, label: "On Scene / Care" },
                  { num: 5, label: "Hospital ER" },
                ].map((step) => {
                  const isDone = currentStage >= step.num;
                  const isCurrent = currentStage === step.num;
                  return (
                    <div key={step.num} className="relative z-10 flex flex-col items-center">
                      <div
                        className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs transition-all ${
                          isDone
                            ? "bg-emerald-600 text-white shadow-xs"
                            : isCurrent
                            ? "bg-blue-600 text-white ring-4 ring-blue-100"
                            : "bg-white border-2 border-slate-200 text-slate-400"
                        }`}
                      >
                        {isDone ? <Check className="w-4 h-4 stroke-[3]" /> : step.num}
                      </div>
                      <span
                        className={`text-[11px] font-semibold mt-2 text-center max-w-[80px] sm:max-w-none ${
                          isCurrent ? "text-blue-700 font-bold" : isDone ? "text-slate-800" : "text-slate-400"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Real-Time Stage Explainer Card */}
              <div className="mt-4 p-3.5 rounded-xl bg-blue-50/60 border border-blue-100 flex items-start gap-3 text-xs text-blue-900 leading-relaxed">
                <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold text-blue-950 block mb-0.5">Response Status</span>
                  <span>{getStageDescription()}</span>
                </div>
              </div>
            </div>

            {/* DISPATCH ASSIGNMENT CARDS */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Ambulance Assignment */}
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-3 flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 shrink-0">
                        <Ambulance className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                          Assigned Ambulance
                        </span>
                        <p className="text-sm font-bold text-slate-900">
                          {activeDispatch?.ambulance_call_sign || "Matching closest available unit..."}
                        </p>
                      </div>
                    </div>
                    {activeDispatch?.ambulance_vehicle_type && (
                      <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 uppercase">
                        {activeDispatch.ambulance_vehicle_type}
                      </span>
                    )}
                  </div>

                  {/* Confirmation / Mission Status */}
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 font-medium flex items-center justify-between">
                    <span>Crew Confirmation:</span>
                    <strong
                      className={`font-bold ${
                        activeDispatch?.ambulance_confirmation_status === "ACCEPTED"
                          ? "text-emerald-700"
                          : activeDispatch?.ambulance_confirmation_status === "REJECTED"
                          ? "text-red-700"
                          : "text-amber-700"
                      }`}
                    >
                      {activeDispatch?.ambulance_confirmation_status === "ACCEPTED"
                        ? "Confirmed & Dispatched ✓"
                        : activeDispatch?.ambulance_confirmation_status === "REJECTED"
                        ? "Reassigning alternate unit..."
                        : "Awaiting Crew Acceptance"}
                    </strong>
                  </div>

                  {/* Estimated Arrival Time (ETA) */}
                  {activeDispatch?.estimated_eta_seconds && activeDispatch.estimated_eta_seconds > 0 ? (
                    <div className="p-3 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-between text-xs font-semibold text-blue-900">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-blue-600" />
                        <span>Estimated Arrival Time:</span>
                      </span>
                      <span className="font-bold font-mono text-sm text-blue-700">
                        ~{Math.round(activeDispatch.estimated_eta_seconds / 60)} mins
                        {activeDispatch.route_distance_meters && (
                          <span className="text-[11px] text-blue-600 font-normal ml-1">
                            ({(activeDispatch.route_distance_meters / 1000).toFixed(1)} km)
                          </span>
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 font-medium flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span>ETA: Calculating based on live road conditions</span>
                    </div>
                  )}

                  {/* Live GPS Telemetry */}
                  {activeDispatch?.ambulance_current_latitude && activeDispatch?.ambulance_current_longitude ? (
                    <div className="p-2.5 rounded-xl bg-emerald-50/70 border border-emerald-100 flex items-center justify-between text-xs text-emerald-900 font-medium">
                      <span className="flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping shrink-0" />
                        <Navigation className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span>Ambulance GPS Fix:</span>
                      </span>
                      <span className="font-mono font-bold text-emerald-800 text-[11px]">
                        {activeDispatch.ambulance_current_latitude.toFixed(4)},{" "}
                        {activeDispatch.ambulance_current_longitude.toFixed(4)}
                      </span>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-500 font-medium flex items-center gap-1.5">
                      <Navigation className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span>Live GPS coordinates: Awaiting ambulance stream</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Hospital Assignment */}
              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-3 flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 shrink-0">
                      <Building2 className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                        Destination Hospital
                      </span>
                      <p className="text-sm font-bold text-slate-900">
                        {activeDispatch?.destination_hospital_name || "Coordinating receiving trauma facility..."}
                      </p>
                    </div>
                  </div>

                  {activeDispatch?.destination_hospital_address && (
                    <p className="text-xs text-slate-500 flex items-start gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                      <span className="truncate">{activeDispatch.destination_hospital_address}</span>
                    </p>
                  )}

                  {/* Bed Reservation Status */}
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-700 font-medium flex items-center justify-between">
                    <span>Bed Reservation:</span>
                    <strong
                      className={`font-bold ${
                        activeDispatch?.hospital_confirmation_status === "ACCEPTED"
                          ? "text-emerald-700"
                          : activeDispatch?.hospital_confirmation_status === "REJECTED"
                          ? "text-red-700"
                          : "text-amber-700"
                      }`}
                    >
                      {activeDispatch?.hospital_confirmation_status === "ACCEPTED"
                        ? "Bed Reserved & ER Notified ✓"
                        : activeDispatch?.hospital_confirmation_status === "REJECTED"
                        ? "Finding Alternate Facility..."
                        : "Awaiting ER Confirmation"}
                    </strong>
                  </div>

                  {/* Emergency Department Reception Status */}
                  {activeDispatch?.patient_arrived_hospital_confirmed_at ||
                  activeDispatch?.status === "AT_HOSPITAL" ||
                  activeIncident.status === "AT_HOSPITAL" ? (
                    <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 font-semibold flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>Patient Arrival Confirmed at Trauma Bay ✓</span>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600 font-medium flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span>ER Trauma Bay Preparing for Arrival</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* LIVE INCIDENT TELEMETRY STRIP */}
            <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-xs shadow-2xs">
              <div className="flex flex-wrap items-center gap-4 text-slate-600">
                <span>
                  <strong className="text-slate-800">Incident:</strong> #{activeIncident.id}
                </span>
                <span>
                  <strong className="text-slate-800">Dispatch:</strong>{" "}
                  {activeDispatch ? `#${activeDispatch.id}` : "Pending Allocation"}
                </span>
                <span>
                  <strong className="text-slate-800">Coordination:</strong>{" "}
                  <span className="font-semibold text-slate-900">
                    {activeDispatch?.coordination_status || "PENDING"}
                  </span>
                </span>
              </div>

              <button
                type="button"
                onClick={() => fetchActiveIncident(true)}
                disabled={isRefreshingTracking}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-semibold text-xs transition disabled:opacity-50"
                title="Refresh tracking data from server"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingTracking ? "animate-spin text-blue-600" : ""}`} />
                <span>{isRefreshingTracking ? "Refreshing..." : "Refresh"}</span>
              </button>
            </div>

            {/* Helpline Banner */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left shadow-xs">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-200 flex items-center justify-center text-red-600 shrink-0">
                  <PhoneCall className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-900">Need Immediate Advice or Question?</p>
                  <p className="text-[11px] text-slate-500">Government 112 emergency control room is operating 24/7.</p>
                </div>
              </div>
              <a
                href="tel:112"
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold flex items-center justify-center gap-2 transition shadow-xs"
              >
                <PhoneCall className="w-4 h-4" />
                <span>Call 112 Now</span>
              </a>
            </div>

            {/* Incident Status Alert Banner if Cancelled or Closed/Resolved */}
            {activeIncident?.status === "CANCELLED" && (
              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold flex items-center gap-2.5">
                <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>This emergency request was cancelled. Dispatched ambulance and hospital reservations have been released.</span>
              </div>
            )}
            {(activeIncident?.status === "RESOLVED" || activeIncident?.status === "CLOSED") && (
              <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Emergency case {activeIncident?.status === "CLOSED" ? "formally closed" : "resolved"}. Patient handover and clinical care completed.</span>
              </div>
            )}

            {/* Actions: Cancel Emergency Request & Reset */}
            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
              {activeIncident?.status !== "CANCELLED" && activeIncident?.status !== "RESOLVED" && activeIncident?.status !== "CLOSED" && (
                <button
                  type="button"
                  onClick={() => setIsCancelModalOpen(true)}
                  className="w-full sm:w-auto px-4 py-2 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-xs font-bold text-red-700 transition"
                >
                  Cancel Emergency Request
                </button>
              )}
              <button
                type="button"
                onClick={handleResetForNewSos}
                className="w-full sm:w-auto px-4 py-2 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:bg-white transition"
              >
                Report Another Emergency / Start Over
              </button>
            </div>
          </div>
        ) : view === "MAIN" ? (
          /* ============================================================== */
          /* VIEW 1: CENTERED MAIN SCREEN (Two Primary Options)            */
          /* ============================================================== */
          <div className="max-w-2xl mx-auto w-full space-y-8 py-6">
            {/* Title & Introduction */}
            <div className="text-center space-y-2">
              <h1 className="text-3xl sm:text-4xl font-black text-slate-900 tracking-tight">
                Need emergency help?
              </h1>
              <p className="text-sm sm:text-base text-slate-600 max-w-md mx-auto">
                Choose how you want to reach emergency assistance.
              </p>
            </div>

            {/* Location Pill for mobile or quick change */}
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setManualInput(selectedAddress);
                  setIsLocationModalOpen(true);
                }}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 shadow-2xs transition"
              >
                <MapPin className="w-3.5 h-3.5 text-red-600 shrink-0" />
                <span className="font-semibold text-slate-900 truncate max-w-[260px]">
                  {selectedAddress || "Tap to set emergency location"}
                </span>
                <span className="text-[11px] text-blue-600 underline font-medium ml-1">Change</span>
              </button>
            </div>

            {/* Two Primary Large Option Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 pt-2">
              {/* Option 1: Talk for Help */}
              <button
                type="button"
                onClick={() => handleSelectWorkflow("TALK")}
                className="group relative flex flex-col items-center justify-center p-8 rounded-2xl bg-white border-2 border-slate-200 hover:border-red-500 hover:shadow-lg transition-all duration-200 text-center cursor-pointer active:scale-[0.99] focus:outline-none focus:ring-4 focus:ring-red-100"
              >
                <div className="w-20 h-20 rounded-full bg-red-50 border-2 border-red-200 group-hover:bg-red-600 group-hover:border-red-600 group-hover:text-white flex items-center justify-center text-red-600 transition-colors duration-200 mb-5 shadow-xs">
                  <Mic className="w-10 h-10 stroke-[2.2]" />
                </div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight mb-2 group-hover:text-red-600 transition-colors">
                  Talk for Help
                </h2>
                <p className="text-xs sm:text-sm text-slate-500 leading-relaxed max-w-xs">
                  Speak and explain your emergency.
                </p>
                <div className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-red-600 group-hover:translate-x-0.5 transition-transform">
                  <span>Start speaking</span>
                  <span>→</span>
                </div>
              </button>

              {/* Option 2: Text for Help */}
              <button
                type="button"
                onClick={() => handleSelectWorkflow("TEXT")}
                className="group relative flex flex-col items-center justify-center p-8 rounded-2xl bg-white border-2 border-slate-200 hover:border-blue-500 hover:shadow-lg transition-all duration-200 text-center cursor-pointer active:scale-[0.99] focus:outline-none focus:ring-4 focus:ring-blue-100"
              >
                <div className="w-20 h-20 rounded-full bg-blue-50 border-2 border-blue-200 group-hover:bg-blue-600 group-hover:border-blue-600 group-hover:text-white flex items-center justify-center text-blue-600 transition-colors duration-200 mb-5 shadow-xs">
                  <MessageSquare className="w-10 h-10 stroke-[2.2]" />
                </div>
                <h2 className="text-xl font-black text-slate-900 tracking-tight mb-2 group-hover:text-blue-600 transition-colors">
                  Text for Help
                </h2>
                <p className="text-xs sm:text-sm text-slate-500 leading-relaxed max-w-xs">
                  Send your emergency details without speaking.
                </p>
                <div className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 group-hover:translate-x-0.5 transition-transform">
                  <span>Enter details</span>
                  <span>→</span>
                </div>
              </button>
            </div>

            {/* Direct Helpline Reminder */}
            <div className="pt-4 text-center">
              <p className="text-xs text-slate-500">
                If you need immediate emergency assistance, you can also{" "}
                <a href="tel:112" className="text-red-600 font-bold hover:underline inline-flex items-center gap-1">
                  <PhoneCall className="w-3 h-3" />
                  call 112
                </a>
                .
              </p>
            </div>
          </div>
        ) : view === "TALK" ? (
          /* ============================================================== */
          /* VIEW 2: DEDICATED TALK FOR HELP EXPERIENCE                     */
          /* ============================================================== */
          <div className="max-w-2xl mx-auto w-full space-y-6 py-2">
            {/* Navigation Header */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  stopListening();
                  setView("MAIN");
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 transition"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to options</span>
              </button>

              {/* Location indicator */}
              <button
                type="button"
                onClick={() => {
                  setManualInput(selectedAddress);
                  setIsLocationModalOpen(true);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition max-w-[200px] truncate"
              >
                <MapPin className="w-3 h-3 text-red-600 shrink-0" />
                <span className="truncate">{selectedAddress}</span>
              </button>
            </div>

            {/* Title Card */}
            <div className="text-center space-y-1">
              <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                Tell us what happened
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 max-w-md mx-auto">
                Speak naturally. We will help collect the details needed to send assistance.
              </p>
            </div>

            {/* Central Interactive Voice Card */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-xs flex flex-col items-center text-center space-y-6">
              {/* Circular Microphone Button with Pulsing Rings */}
              <div className="relative flex items-center justify-center my-2">
                {isListening && (
                  <>
                    <span className="absolute w-36 h-36 rounded-full bg-red-400/20 animate-ping" />
                    <span className="absolute w-44 h-44 rounded-full border-2 border-red-300/40 animate-pulse" />
                  </>
                )}

                <button
                  type="button"
                  onClick={toggleVoiceRecording}
                  className={`relative w-28 h-28 sm:w-32 sm:h-32 rounded-full flex flex-col items-center justify-center shadow-lg transition-all duration-200 cursor-pointer active:scale-95 focus:outline-none focus:ring-4 ${
                    isListening
                      ? "bg-red-600 text-white ring-red-200 shadow-red-200"
                      : "bg-red-50 hover:bg-red-100 text-red-600 border-2 border-red-200 ring-slate-100"
                  }`}
                  aria-label={isListening ? "Stop Listening" : "Start Speaking"}
                >
                  {isListening ? (
                    <Mic className="w-12 h-12 stroke-[2.2] animate-bounce" />
                  ) : (
                    <Mic className="w-12 h-12 stroke-[2.2]" />
                  )}
                  <span className="text-[10px] font-bold uppercase tracking-wider mt-1">
                    {isListening ? "Listening" : "Tap to Speak"}
                  </span>
                </button>
              </div>

              {/* Status & Feedback */}
              <div className="space-y-1">
                <p className="text-sm font-bold text-slate-900">
                  {isListening ? "Listening to your voice..." : "Microphone ready"}
                </p>
                <p className="text-xs text-slate-500">
                  {voiceFeedback || "State symptoms, injuries, or what assistance is needed."}
                </p>
                {!voiceSupported && (
                  <p className="text-xs text-amber-600 font-medium">
                    Web Speech API is not supported in this browser. Please type details below.
                  </p>
                )}
              </div>

              {/* Detected Symptom Tags (Real-time Extraction) */}
              {detectedSymptomTags.length > 0 && (
                <div className="w-full pt-2 border-t border-slate-100">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2 text-left">
                    Detected Emergency Indicators
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {detectedSymptomTags.map((tag) => {
                      const IconComp = tag.icon;
                      return (
                        <span
                          key={tag.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-bold"
                        >
                          <IconComp className="w-3.5 h-3.5 text-red-600" />
                          <span>{tag.label}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Editable Review Textarea */}
              <div className="w-full space-y-1.5 text-left">
                <label className="text-xs font-bold text-slate-700 block">
                  Transcribed Emergency Details (tap to edit)
                </label>
                <textarea
                  value={spokenTranscript}
                  onChange={(e) => setSpokenTranscript(e.target.value)}
                  placeholder="Your spoken words will appear here. You can also edit or type additional information..."
                  rows={3}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm rounded-xl border border-slate-200 bg-slate-50 text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 transition"
                />
              </div>

              {/* Action: Send Emergency Request */}
              <div className="w-full pt-2">
                <button
                  type="button"
                  onClick={() => handleSubmitEmergency("TALK")}
                  disabled={isSubmitting}
                  className={`w-full py-4 px-6 rounded-xl bg-red-600 hover:bg-red-700 text-white font-extrabold text-sm sm:text-base flex items-center justify-center gap-2 shadow-md shadow-red-200 transition active:scale-[0.99] cursor-pointer ${
                    isSubmitting ? "opacity-75 cursor-not-allowed" : ""
                  }`}
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      <span>Transmitting Emergency Request...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-5 h-5" />
                      <span>Send Emergency Request</span>
                    </>
                  )}
                </button>
              </div>

              {/* Fallback Switcher */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => {
                    stopListening();
                    setIncidentDescription(spokenTranscript);
                    setView("TEXT");
                  }}
                  className="text-xs font-semibold text-slate-600 hover:text-blue-600 underline"
                >
                  Prefer to type? Switch to Text for Help
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ============================================================== */
          /* VIEW 3: DEDICATED TEXT FOR HELP EXPERIENCE                     */
          /* ============================================================== */
          <div className="max-w-2xl mx-auto w-full space-y-6 py-2">
            {/* Navigation Header */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setView("MAIN")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-700 transition"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back to options</span>
              </button>

              {/* Location indicator */}
              <button
                type="button"
                onClick={() => {
                  setManualInput(selectedAddress);
                  setIsLocationModalOpen(true);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50 transition max-w-[200px] truncate"
              >
                <MapPin className="w-3 h-3 text-red-600 shrink-0" />
                <span className="truncate">{selectedAddress}</span>
              </button>
            </div>

            {/* Title Card */}
            <div className="text-center space-y-1">
              <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                Send emergency details
              </h2>
              <p className="text-xs sm:text-sm text-slate-600 max-w-md mx-auto">
                Provide what you know. You can send the request even if some details are unknown.
              </p>
            </div>

            {/* Text Intake Form */}
            <div className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 shadow-xs space-y-6">
              {/* Emergency Type Chips */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-900 block uppercase tracking-wider">
                  Select Emergency Type
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {[
                    { id: "MEDICAL", label: "Medical emergency", icon: Activity },
                    { id: "ACCIDENT", label: "Road accident", icon: Car },
                    { id: "FIRE", label: "Fire", icon: Flame },
                    { id: "OTHER", label: "Other", icon: ShieldAlert },
                  ].map((type) => {
                    const IconComp = type.icon;
                    const isSelected = emergencyType === type.id;
                    return (
                      <button
                        key={type.id}
                        type="button"
                        onClick={() => setEmergencyType(type.id as EmergencyType)}
                        className={`p-3 rounded-xl border text-left transition flex flex-col items-center justify-center text-center gap-1.5 cursor-pointer ${
                          isSelected
                            ? "bg-red-50 border-red-500 text-red-900 ring-2 ring-red-400 shadow-2xs font-bold"
                            : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 font-medium"
                        }`}
                      >
                        <IconComp className={`w-5 h-5 ${isSelected ? "text-red-600" : "text-slate-500"}`} />
                        <span className="text-xs leading-tight">{type.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* What happened? textarea */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-slate-900 block uppercase tracking-wider">
                  What happened?
                </label>
                <textarea
                  value={incidentDescription}
                  onChange={(e) => setIncidentDescription(e.target.value)}
                  placeholder="Describe the emergency briefly..."
                  rows={3}
                  className="w-full px-3.5 py-2.5 text-xs sm:text-sm rounded-xl border border-slate-200 bg-slate-50 text-slate-900 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 transition"
                />
              </div>

              {/* Number of injured people */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-slate-900 block uppercase tracking-wider">
                  Number of injured people
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {["1", "2", "3+", "Unknown"].map((count) => {
                    const isSelected = injuredCount === count;
                    return (
                      <button
                        key={count}
                        type="button"
                        onClick={() => setInjuredCount(count)}
                        className={`py-2 px-3 rounded-xl border text-xs font-bold transition text-center cursor-pointer ${
                          isSelected
                            ? "bg-blue-50 border-blue-500 text-blue-900 ring-1 ring-blue-400"
                            : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                        }`}
                      >
                        {count === "1"
                          ? "1 person"
                          : count === "2"
                          ? "2 people"
                          : count === "3+"
                          ? "3+ people"
                          : "Unknown"}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Collapsible "Add more information" */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdditionalInfo((prev) => !prev)}
                  className="w-full p-3.5 bg-slate-50 hover:bg-slate-100 flex items-center justify-between text-xs font-bold text-slate-800 transition text-left"
                >
                  <span>Add more information (landmark, special assistance)</span>
                  {showAdditionalInfo ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>

                {showAdditionalInfo && (
                  <div className="p-4 bg-white space-y-4 border-t border-slate-200">
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-slate-700 block">
                        Nearby landmark or specific directions
                      </label>
                      <input
                        type="text"
                        value={specificLandmark}
                        onChange={(e) => setSpecificLandmark(e.target.value)}
                        placeholder="e.g. Near bus stop, opposite temple, 2nd floor..."
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-700 block">Critical Conditions</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: "Patient is unconscious", state: flagUnconscious, setter: setFlagUnconscious },
                          { label: "Difficulty breathing", state: flagBreathing, setter: setFlagBreathing },
                          { label: "Severe bleeding", state: flagSevereBleeding, setter: setFlagSevereBleeding },
                          { label: "Severe chest pain", state: flagChestPain, setter: setFlagChestPain },
                        ].map((item, idx) => (
                          <label
                            key={idx}
                            className={`flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer transition ${
                              item.state ? "bg-red-50 border-red-300 text-red-900 font-bold" : "bg-white border-slate-200 text-slate-700"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={item.state}
                              onChange={(e) => item.setter(e.target.checked)}
                              className="rounded text-red-600 focus:ring-red-500"
                            />
                            <span>{item.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Action: Send Emergency Request */}
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => handleSubmitEmergency("TEXT")}
                  disabled={isSubmitting}
                  className={`w-full py-4 px-6 rounded-xl bg-red-600 hover:bg-red-700 text-white font-extrabold text-sm sm:text-base flex items-center justify-center gap-2 shadow-md shadow-red-200 transition active:scale-[0.99] cursor-pointer ${
                    isSubmitting ? "opacity-75 cursor-not-allowed" : ""
                  }`}
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      <span>Transmitting Emergency Request...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-5 h-5" />
                      <span>Send Emergency Request</span>
                    </>
                  )}
                </button>
              </div>

              {/* Fallback Switcher */}
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setSpokenTranscript(incidentDescription);
                    setView("TALK");
                  }}
                  className="text-xs font-semibold text-slate-600 hover:text-red-600 underline"
                >
                  Prefer to speak? Switch to Talk for Help
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ============================================================== */}
      {/* CANCELLATION CONFIRMATION MODAL                                */}
      {/* ============================================================== */}
      {isCancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <h3 className="text-base font-bold text-slate-900">Cancel Emergency Request?</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCancelModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Canceling will notify dispatchers and immediately release any dispatched ambulance crew and reserved hospital trauma beds back into public service.
            </p>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700 block">
                Reason for cancellation (optional):
              </label>
              <select
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-slate-50 text-slate-800 focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                <option value="">Select a common reason...</option>
                <option value="Situation resolved on site">Situation resolved on site</option>
                <option value="Patient transported via private vehicle">Patient transported via private vehicle</option>
                <option value="Accidental / false alarm">Accidental / false alarm</option>
                <option value="Duplicate report">Duplicate report</option>
                <option value="Other / Not required">Other / Not required</option>
              </select>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCancelModalOpen(false)}
                className="px-4 py-2 text-xs font-semibold rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 transition"
              >
                Keep Active
              </button>
              <button
                type="button"
                onClick={handleCancelIncident}
                disabled={isCancelling}
                className="px-4 py-2 text-xs font-bold rounded-xl bg-red-600 hover:bg-red-700 text-white transition flex items-center gap-1.5"
              >
                {isCancelling ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>Confirm Cancellation</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* MISSING LOCATION MODAL (Shared Across Both Flows)               */}
      {/* ============================================================== */}
      {isLocationModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 sm:p-7 shadow-xl space-y-5 animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-red-600">
                  <MapPin className="w-5 h-5" />
                  <h3 className="text-lg font-black text-slate-900 tracking-tight">We need your location</h3>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  We couldn't automatically detect your location. Enter where you need emergency assistance so responders can find you.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsLocationModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Manual Location Input */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-slate-700 block">
                Address, area or nearby landmark
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  placeholder="Enter address, area or nearby landmark..."
                  className="w-full pl-9 pr-3 py-2.5 text-xs sm:text-sm rounded-xl border border-slate-300 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 transition"
                />
                <MapPin className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              </div>
            </div>

            {/* Quick-Select Mangaluru Landmark Chips */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider block">
                Or tap a Mangaluru landmark:
              </span>
              <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto pr-1">
                {MANGALURU_LANDMARKS.map((landmark) => {
                  const isSelected = manualInput.includes(landmark.name);
                  return (
                    <button
                      key={landmark.name}
                      type="button"
                      onClick={() => handleSelectLandmark(landmark)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition cursor-pointer ${
                        isSelected
                          ? "bg-red-50 border-red-400 text-red-800 font-bold"
                          : "bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      {landmark.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Modal Actions */}
            <div className="space-y-2 pt-2">
              <button
                type="button"
                onClick={handleConfirmManualLocation}
                disabled={!manualInput.trim()}
                className={`w-full py-3 px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs sm:text-sm font-bold flex items-center justify-center gap-2 shadow-xs transition ${
                  !manualInput.trim() ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                }`}
              >
                <Check className="w-4 h-4" />
                <span>Confirm location & continue</span>
              </button>

              <button
                type="button"
                onClick={() => acquireGps(pendingFlow || undefined)}
                className="w-full py-2.5 px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                <Crosshair className={`w-3.5 h-3.5 text-blue-600 ${gpsStatus === "ACQUIRING" ? "animate-spin" : ""}`} />
                <span>Try detecting location again</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Minimal Footer */}
      <footer className="border-t border-slate-200 bg-white py-3 px-4 text-center text-[11px] text-slate-500">
        LIFELINK Emergency Response Platform • Mangaluru District Administration & Health Services
      </footer>
    </div>
  );
}
