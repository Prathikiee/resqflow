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
  Navigation,
  Phone,
  Radio,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import DynamicCitizenTrackingMap from "@/components/CitizenMapWrapper";
import { formatIST, parseUtcDate } from "@/lib/utils";

interface TimelineEventRecord {
  id: number;
  incident_id: number;
  dispatch_id?: number | null;
  event_type: string;
  event_title: string;
  event_description: string;
  actor_type: string;
  actor_reference?: string | null;
  created_at: string;
}

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
  destination_hospital_latitude?: number;
  destination_hospital_longitude?: number;
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

type GpsStatus = "ACQUIRING" | "ACQUIRED" | "DENIED" | "TIMEOUT" | "UNAVAILABLE" | "MANUAL";

type EmergencyCategory = "ROAD_ACCIDENT" | "MEDICAL" | "CARDIAC" | "FIRE" | "INJURY_FALL" | "OTHER";

type VoiceState =
  | "READY"
  | "LISTENING"
  | "TRANSCRIBING"
  | "TRANSCRIPT_READY"
  | "PERMISSION_DENIED"
  | "UNAVAILABLE"
  | "FAILED";

interface EmergencyCategoryOption {
  id: EmergencyCategory;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isCardiac?: boolean;
  isTrauma?: boolean;
  code: string;
}

const EMERGENCY_CATEGORIES: EmergencyCategoryOption[] = [
  { id: "ROAD_ACCIDENT", label: "Road Accident", icon: Car, isTrauma: true, code: "Road Accident" },
  { id: "MEDICAL", label: "Medical", icon: Activity, code: "Medical Emergency" },
  { id: "CARDIAC", label: "Cardiac", icon: HeartPulse, isCardiac: true, code: "Cardiac Emergency" },
  { id: "FIRE", label: "Fire", icon: Flame, code: "Fire / Rescue" },
  { id: "INJURY_FALL", label: "Injury / Fall", icon: ShieldAlert, isTrauma: true, code: "Injury / Fall" },
  { id: "OTHER", label: "Other", icon: HelpCircle, code: "Other Emergency" },
];

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

const MAX_DESCRIPTION_LENGTH = 500;

export default function CitizenPortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [activeIncident, setActiveIncident] = useState<IncidentRecord | null>(null);
  const [activeDispatch, setActiveDispatch] = useState<DispatchRecord | null>(null);
  const [isTrackingViewOpen, setIsTrackingViewOpen] = useState(false);
  const [isCheckingMyEmergency, setIsCheckingMyEmergency] = useState(false);
  const [hasNoActiveEmergency, setHasNoActiveEmergency] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRefreshingTracking, setIsRefreshingTracking] = useState(false);

  // Initialize cached user session immediately to prevent screen flickers
  useEffect(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("lifelink_user");
      if (stored) {
        try {
          setUser(JSON.parse(stored));
        } catch {
          // ignore
        }
      }
    }
  }, []);

  // Form State
  const [selectedCategory, setSelectedCategory] = useState<EmergencyCategory>("MEDICAL");
  const [customOtherType, setCustomOtherType] = useState("");
  const [incidentDescription, setIncidentDescription] = useState("");
  const [isDescriptionVisible, setIsDescriptionVisible] = useState(false);
  const [showAdditionalInfo, setShowAdditionalInfo] = useState(false);
  const [injuredCount, setInjuredCount] = useState<string>("1");
  const [specificLandmark, setSpecificLandmark] = useState("");
  const [flagUnconscious, setFlagUnconscious] = useState(false);
  const [flagBreathing, setFlagBreathing] = useState(false);
  const [flagSevereBleeding, setFlagSevereBleeding] = useState(false);

  // Voice Speech Recognition State
  const [voiceState, setVoiceState] = useState<VoiceState>("READY");
  const recognitionRef = useRef<any>(null);

  // Location State
  const [gpsCoords, setGpsCoords] = useState<{ lat: number; lng: number; accuracy?: number }>({
    lat: 12.8718,
    lng: 74.8458,
    accuracy: 15,
  });
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("ACQUIRING");
  const [selectedAddress, setSelectedAddress] = useState<string>("Hampankatta, Mangaluru, Karnataka");
  const [hasConfirmedLocation, setHasConfirmedLocation] = useState<boolean>(false);
  const [isManualLocationOpen, setIsManualLocationOpen] = useState(false);
  const [manualInput, setManualInput] = useState("");

  // Cancel Incident Modal State
  const [isCancelModalOpen, setIsCancelModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEventRecord[]>([]);

  const isSubmittingRef = useRef(false);
  const descriptionInputRef = useRef<HTMLTextAreaElement | null>(null);
  const activeIncidentRef = useRef<IncidentRecord | null>(null);
  const activeDispatchRef = useRef<DispatchRecord | null>(null);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  useEffect(() => {
    activeIncidentRef.current = activeIncident;
  }, [activeIncident]);

  useEffect(() => {
    activeDispatchRef.current = activeDispatch;
  }, [activeDispatch]);

  // Acquire Geolocation
  const acquireGps = useCallback(() => {
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
  const fetchActiveIncident = useCallback(
    async (isManualRefresh = false) => {
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
        if (meResp.status === 401) {
          localStorage.removeItem("lifelink_token");
          localStorage.removeItem("lifelink_user");
          router.push("/login");
          return;
        }
        if (meResp.ok) {
          const meData = await meResp.json();
          setUser(meData);
          localStorage.setItem("lifelink_user", JSON.stringify(meData));
        }

        // Authoritative query from backend: active non-terminal incident for current citizen
        const myActiveResp = await fetch(`${backendUrl}/api/incidents/my-active`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (myActiveResp.ok) {
          const active = await myActiveResp.json();
          if (active && active.id) {
            setActiveIncident(active);
            setHasNoActiveEmergency(false);
            localStorage.setItem("lifelink_active_incident_id", String(active.id));

            try {
              const tlResp = await fetch(`${backendUrl}/api/incidents/${active.id}/timeline`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (tlResp.ok) {
                const tlData = await tlResp.json();
                setTimelineEvents(tlData);
              }
            } catch {
              // non-fatal timeline fetch failure
            }

            try {
              const dispResp = await fetch(`${backendUrl}/api/dispatch?incident_id=${active.id}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (dispResp.ok) {
                const disps = await dispResp.json();
                if (disps.length > 0) setActiveDispatch(disps[0]);
                else setActiveDispatch(null);
              }
            } catch {
              // non-fatal dispatch fetch failure
            }
          } else {
            setActiveIncident(null);
            setActiveDispatch(null);
            localStorage.removeItem("lifelink_active_incident_id");
          }
        }
      } catch (err: any) {
        setErrorMessage(err.message || "Failed to connect to backend");
      } finally {
        setIsLoading(false);
        if (isManualRefresh) setIsRefreshingTracking(false);
      }
    },
    [backendUrl, router]
  );

  // Dedicated "My Emergency" navigation handler
  const handleOpenMyEmergency = async () => {
    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) {
      router.push("/login");
      return;
    }

    setIsCheckingMyEmergency(true);
    setErrorMessage(null);

    try {
      const resp = await fetch(`${backendUrl}/api/incidents/my-active`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.status === 401) {
        localStorage.removeItem("lifelink_token");
        localStorage.removeItem("lifelink_user");
        router.push("/login");
        return;
      }

      if (resp.ok) {
        const activeInc = await resp.json();
        if (activeInc && activeInc.id) {
          setActiveIncident(activeInc);
          localStorage.setItem("lifelink_active_incident_id", String(activeInc.id));
          setHasNoActiveEmergency(false);

          try {
            const tlResp = await fetch(`${backendUrl}/api/incidents/${activeInc.id}/timeline`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (tlResp.ok) {
              const tlData = await tlResp.json();
              setTimelineEvents(tlData);
            }
          } catch {
            // non-fatal
          }

          try {
            const dispResp = await fetch(`${backendUrl}/api/dispatch?incident_id=${activeInc.id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (dispResp.ok) {
              const disps = await dispResp.json();
              if (disps.length > 0) setActiveDispatch(disps[0]);
              else setActiveDispatch(null);
            }
          } catch {
            // non-fatal
          }

          setIsTrackingViewOpen(true);
        } else {
          // No active emergency found in database
          setActiveIncident(null);
          setActiveDispatch(null);
          localStorage.removeItem("lifelink_active_incident_id");
          setHasNoActiveEmergency(true);
          setIsTrackingViewOpen(true);
        }
      } else {
        throw new Error("Unable to check active emergency status");
      }
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to retrieve your emergency status");
    } finally {
      setIsCheckingMyEmergency(false);
    }
  };

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

          // 2. Dispatch creation & provisional reservations
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
                  destination_hospital_name:
                    payload.destination_hospital_name || payload.hospital_name || "Assigned Emergency Dept",
                  destination_hospital_id: payload.destination_hospital_id,
                  destination_hospital_address: payload.destination_hospital_address,
                  destination_hospital_latitude: payload.destination_hospital_latitude,
                  destination_hospital_longitude: payload.destination_hospital_longitude,
                  coordination_status: payload.coordination_status || "PENDING_CONFIRMATIONS",
                  ambulance_confirmation_status:
                    payload.ambulance_confirmation_status || payload.ambulance_confirmation || "PENDING",
                  hospital_confirmation_status:
                    payload.hospital_confirmation_status || payload.hospital_confirmation || "PENDING",
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
                destination_hospital_name:
                  payload.destination_hospital_name || payload.hospital_name || prev.destination_hospital_name,
                destination_hospital_address: payload.destination_hospital_address || prev.destination_hospital_address,
                destination_hospital_latitude: payload.destination_hospital_latitude ?? prev.destination_hospital_latitude,
                destination_hospital_longitude: payload.destination_hospital_longitude ?? prev.destination_hospital_longitude,
                coordination_status: payload.coordination_status || prev.coordination_status,
                ambulance_confirmation_status:
                  payload.ambulance_confirmation_status ||
                  payload.ambulance_confirmation ||
                  prev.ambulance_confirmation_status,
                hospital_confirmation_status:
                  payload.hospital_confirmation_status ||
                  payload.hospital_confirmation ||
                  prev.hospital_confirmation_status,
                status: payload.status || prev.status,
                estimated_eta_seconds: payload.estimated_eta_seconds ?? prev.estimated_eta_seconds,
                route_distance_meters: payload.route_distance_meters ?? prev.route_distance_meters,
                ambulance_current_latitude:
                  payload.ambulance_current_latitude ?? prev.ambulance_current_latitude,
                ambulance_current_longitude:
                  payload.ambulance_current_longitude ?? prev.ambulance_current_longitude,
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
          if (eventType === "PATIENT_ARRIVED_HOSPITAL" && curInc && payload.incident_id === curInc.id) {
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

          // 5. Live GPS telemetry
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

          // 6. Terminal statuses
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

  // Voice Recording Implementation
  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
    }
  }, []);

  const startListening = useCallback(() => {
    if (typeof window === "undefined") return;
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceState("UNAVAILABLE");
      setIsDescriptionVisible(true);
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
        setVoiceState("LISTENING");
        setIsDescriptionVisible(true);
      };

      recognition.onresult = (event: any) => {
        setVoiceState("TRANSCRIBING");
        setIsDescriptionVisible(true);
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        const text = (final || interim).trim();
        if (text) {
          setIncidentDescription((prev) => {
            const trimmedPrev = prev.trim();
            if (trimmedPrev && final) {
              const combined = `${trimmedPrev} ${final.trim()}`;
              return combined.slice(0, MAX_DESCRIPTION_LENGTH);
            }
            return (final || interim).slice(0, MAX_DESCRIPTION_LENGTH);
          });
        }
      };

      recognition.onerror = (e: any) => {
        if (e.error === "not-allowed" || e.error === "permission-denied") {
          setVoiceState("PERMISSION_DENIED");
          setIsDescriptionVisible(true);
        } else if (e.error !== "no-speech") {
          setVoiceState("FAILED");
          setIsDescriptionVisible(true);
        } else {
          setVoiceState("READY");
        }
      };

      recognition.onend = () => {
        setVoiceState((prev) => (prev === "LISTENING" || prev === "TRANSCRIBING" ? "TRANSCRIPT_READY" : prev));
      };

      recognition.start();
    } catch (_) {
      setVoiceState("FAILED");
      setIsDescriptionVisible(true);
    }
  }, []);

  // Primary Call 112 click handler: activates simulated voice input
  const handleSimulatedCall112 = () => {
    setIsDescriptionVisible(true);
    if (voiceState === "LISTENING") {
      stopListening();
      setVoiceState("TRANSCRIPT_READY");
    } else {
      startListening();
    }
  };

  // Secondary Text SOS click handler: reveals and focuses description textarea
  const handleTextSosClick = () => {
    setIsDescriptionVisible(true);
    setTimeout(() => {
      descriptionInputRef.current?.focus();
      descriptionInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  };

  // Manual Landmark Selection
  const handleSelectLandmark = (landmark: Landmark) => {
    setGpsCoords({ lat: landmark.lat, lng: landmark.lng, accuracy: 25 });
    const fullAddr = `${landmark.name}, ${landmark.area}, Mangaluru`;
    setSelectedAddress(fullAddr);
    setManualInput(fullAddr);
    setGpsStatus("MANUAL");
    setHasConfirmedLocation(true);
    setIsManualLocationOpen(false);
  };

  const handleConfirmManualLocation = () => {
    const trimmed = manualInput.trim();
    if (!trimmed) return;
    setSelectedAddress(trimmed);
    setGpsStatus("MANUAL");
    setHasConfirmedLocation(true);
    setIsManualLocationOpen(false);
  };

  // Validation Logic
  const isDescriptionValid = incidentDescription.trim().length >= 3;
  const isCategoryValid = Boolean(selectedCategory);
  const isOtherValid = selectedCategory !== "OTHER" || customOtherType.trim().length >= 2;
  const isLocationValid =
    Boolean(selectedAddress.trim()) &&
    ((gpsStatus === "ACQUIRED" && gpsCoords.lat !== 0 && gpsCoords.lng !== 0) ||
      manualInput.trim().length >= 3 ||
      selectedAddress.trim().length >= 3);

  const isFormValid = isDescriptionValid && isCategoryValid && isOtherValid && isLocationValid;

  // Submit Emergency Request
  const handleSubmitEmergency = async () => {
    if (isSubmittingRef.current || isSubmitting || !isFormValid) return;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);

    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    const activeCat = EMERGENCY_CATEGORIES.find((c) => c.id === selectedCategory) || EMERGENCY_CATEGORIES[1];

    let categoryPrefix = activeCat.code;
    if (selectedCategory === "OTHER" && customOtherType.trim()) {
      categoryPrefix = `Other (${customOtherType.trim()})`;
    }

    const descriptionText = incidentDescription.trim();
    const landmarkStr = specificLandmark.trim() ? `Near: ${specificLandmark.trim()}` : "";
    const injuredStr = injuredCount !== "Unknown" ? `Injured: ${injuredCount}` : "";

    const combinedComplaint = [categoryPrefix, descriptionText, injuredStr, landmarkStr]
      .filter(Boolean)
      .join(" - ");

    const payload = {
      caller_name: user?.full_name || "Citizen Reporter",
      caller_phone: user?.phone_number || "+91 98450 11200",
      location_address: selectedAddress.trim() || manualInput.trim() || "Mangaluru, Karnataka",
      latitude: gpsCoords.lat,
      longitude: gpsCoords.lng,
      chief_complaint: combinedComplaint,
      chest_pain: activeCat.isCardiac || false,
      breathing_status: flagBreathing ? "Difficult" : "Normal",
      severe_trauma: activeCat.isTrauma || flagSevereBleeding || false,
      suspected_stroke: false,
      severe_bleeding: flagSevereBleeding,
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
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Emergency request transmission failed.");
      }

      const createdInc: IncidentRecord = await resp.json();
      setActiveIncident(createdInc);
      setHasNoActiveEmergency(false);
      localStorage.setItem("lifelink_active_incident_id", String(createdInc.id));
      setIsTrackingViewOpen(true);

      setTimeout(async () => {
        try {
          const tlResp = await fetch(`${backendUrl}/api/incidents/${createdInc.id}/timeline`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (tlResp.ok) {
            const tlData = await tlResp.json();
            setTimelineEvents(tlData);
          }
        } catch (_) {}

        try {
          const dispResp = await fetch(`${backendUrl}/api/dispatch?incident_id=${createdInc.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (dispResp.ok) {
            const disps = await dispResp.json();
            if (disps.length > 0) setActiveDispatch(disps[0]);
          }
        } catch (_) {}
      }, 500);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to broadcast emergency SOS. Please retry.");
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
    setHasNoActiveEmergency(false);
    setIncidentDescription("");
    setCustomOtherType("");
    setSelectedCategory("MEDICAL");
    setIsDescriptionVisible(false);
    setErrorMessage(null);
    setIsTrackingViewOpen(false);
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
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-red-600" />
          <span className="text-xs font-bold text-slate-700">Connecting to ResQFlow Network...</span>
        </div>
      </div>
    );
  }

  // Calculate timeline stage (1 to 6) strictly based on actual backend data
  const getTimelineStage = () => {
    if (!activeIncident) return 1;
    if (activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED") return 6;
    if (activeIncident.status === "AT_HOSPITAL" || activeDispatch?.status === "AT_HOSPITAL" || activeDispatch?.status === "COMPLETED") return 6;
    if (activeDispatch?.status === "EN_ROUTE_HOSPITAL" || activeIncident.status === "TRANSPORTING") return 5;
    if (activeDispatch?.status === "ON_SCENE" || activeIncident.status === "ON_SCENE") return 4;
    if (activeDispatch?.status === "EN_ROUTE_INCIDENT" || activeIncident.status === "EN_ROUTE") return 3;
    if (activeDispatch) return 2;
    return 1;
  };

  const currentStage = getTimelineStage();

  // Location display badge helper
  const getLocationBadge = () => {
    if (gpsStatus === "ACQUIRING") {
      return {
        text: "Detecting location...",
        color: "text-blue-700 bg-blue-50 border-blue-200",
        icon: <Crosshair className="w-3.5 h-3.5 animate-spin text-blue-600 shrink-0" />,
      };
    }
    if (gpsStatus === "ACQUIRED" || gpsStatus === "MANUAL" || hasConfirmedLocation) {
      return {
        text: "Location detected",
        color: "text-emerald-700 bg-emerald-50 border-emerald-200",
        icon: <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />,
      };
    }
    if (gpsStatus === "DENIED") {
      return {
        text: "Permission denied",
        color: "text-amber-800 bg-amber-50 border-amber-200",
        icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />,
      };
    }
    return {
      text: "Location unavailable",
      color: "text-amber-800 bg-amber-50 border-amber-200",
      icon: <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />,
    };
  };

  const locationBadge = getLocationBadge();

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col font-sans antialiased selection:bg-red-100 selection:text-red-900">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-30 px-4 py-3 sm:px-6 shadow-2xs">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-red-600 flex items-center justify-center text-white shadow-xs">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-base tracking-tight text-slate-900">ResQFlow</span>
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200 uppercase tracking-wider">
                  Citizen
                </span>
              </div>
              <p className="text-xs text-slate-600 font-medium">Emergency Response Platform</p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* "My Emergency" Entry Point */}
            <button
              type="button"
              onClick={handleOpenMyEmergency}
              disabled={isCheckingMyEmergency}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs sm:text-sm font-bold transition shadow-2xs cursor-pointer active:scale-95 ${
                activeIncident && !isTrackingViewOpen
                  ? "bg-red-50 border-red-300 text-red-800 hover:bg-red-100 ring-2 ring-red-200"
                  : "bg-white border-slate-200 text-slate-800 hover:bg-slate-50"
              }`}
              title="Access your emergency tracking"
            >
              {isCheckingMyEmergency ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-red-600" />
              ) : (
                <Radio className={`w-3.5 h-3.5 ${activeIncident ? "text-red-600 animate-pulse" : "text-slate-500"}`} />
              )}
              <span>My Emergency</span>
              {activeIncident && (
                <span className="w-2 h-2 rounded-full bg-red-600 animate-ping" />
              )}
            </button>

            {user?.full_name && (
              <span className="hidden sm:inline-block text-xs font-bold text-slate-700 mr-1">
                {user.full_name}
              </span>
            )}
            <button
              onClick={handleLogout}
              className="p-2 rounded-xl border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition cursor-pointer"
              title="Sign Out"
              aria-label="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-2xl w-full mx-auto p-4 sm:p-6 flex flex-col justify-center">
        {errorMessage && (
          <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs sm:text-sm flex items-center justify-between shadow-2xs animate-in fade-in">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              <span className="font-medium">{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-red-700 hover:text-red-900 font-bold ml-2 p-1 cursor-pointer"
              aria-label="Dismiss error"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* POST-SUBMISSION / ACTIVE INCIDENT TRACKING VIEW               */}
        {/* ============================================================== */}
        {isTrackingViewOpen ? (
          hasNoActiveEmergency || !activeIncident ? (
            /* Clean Reassuring Empty State */
            <div className="bg-white border border-slate-200 rounded-2xl p-8 sm:p-10 text-center space-y-6 shadow-xs max-w-lg mx-auto my-6 animate-in fade-in">
              <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center mx-auto shadow-2xs">
                <ShieldCheck className="w-8 h-8" />
              </div>

              <div className="space-y-2">
                <h2 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight">
                  No Active Emergency
                </h2>
                <p className="text-sm sm:text-base text-slate-700 font-medium leading-relaxed max-w-md mx-auto">
                  You don't have an active emergency request right now.
                </p>
                <p className="text-xs sm:text-sm text-slate-600 max-w-sm mx-auto">
                  All previous emergency requests have been safely completed or cancelled. If you or someone nearby needs emergency assistance, you can report a new emergency at any time.
                </p>
              </div>

              <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setIsTrackingViewOpen(false);
                    setHasNoActiveEmergency(false);
                  }}
                  className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold text-sm shadow-sm transition active:scale-95 cursor-pointer flex items-center justify-center gap-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span>Back to Emergency Home</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    handleResetForNewSos();
                    setIsTrackingViewOpen(false);
                    setHasNoActiveEmergency(false);
                  }}
                  className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 font-bold text-sm transition cursor-pointer"
                >
                  Report New Emergency
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6 py-2">
              {/* Top Navigation Bar for Tracking View */}
              <div className="flex items-center justify-between pb-1">
                <button
                  type="button"
                  onClick={() => setIsTrackingViewOpen(false)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs sm:text-sm font-bold text-slate-800 transition shadow-2xs cursor-pointer active:scale-95"
                >
                  <ArrowLeft className="w-4 h-4 text-slate-600" />
                  <span>Back to Emergency Home</span>
                </button>

                <div className="flex items-center gap-2">
                  <span className="text-xs sm:text-sm font-extrabold text-slate-800">
                    My Emergency
                  </span>
                  <button
                    type="button"
                    onClick={() => fetchActiveIncident(true)}
                    disabled={isRefreshingTracking}
                    className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition cursor-pointer"
                    title="Refresh tracking status"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingTracking ? "animate-spin text-blue-600" : ""}`} />
                  </button>
                </div>
              </div>

              {/* 1. Reassuring Request Confirmation & Status Card */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center space-y-4 shadow-xs">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold tracking-wide border bg-emerald-50 border-emerald-200 text-emerald-800">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>Live Tracking Active</span>
                  </span>

                  <span
                    className={`text-xs sm:text-sm font-extrabold px-3 py-1 rounded-full border ${
                      activeIncident.status === "CANCELLED"
                        ? "bg-slate-100 border-slate-200 text-slate-800"
                        : activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED"
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : activeDispatch?.status === "AT_HOSPITAL"
                        ? "bg-purple-50 border-purple-200 text-purple-800"
                        : activeDispatch?.status === "ON_SCENE"
                        ? "bg-blue-50 border-blue-200 text-blue-800"
                        : activeDispatch?.status === "EN_ROUTE_INCIDENT"
                        ? "bg-blue-50 border-blue-200 text-blue-800"
                        : activeDispatch?.status === "ASSIGNED"
                        ? "bg-blue-50 border-blue-200 text-blue-800"
                        : "bg-red-50 border-red-200 text-red-800"
                    }`}
                  >
                    {activeIncident.status === "CANCELLED"
                      ? "Cancelled"
                      : activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED"
                      ? "Care Completed"
                      : activeDispatch?.status === "AT_HOSPITAL"
                      ? "At Hospital"
                      : activeDispatch?.status === "ON_SCENE"
                      ? "Responders On Scene"
                      : activeDispatch?.status === "EN_ROUTE_INCIDENT"
                      ? "Ambulance En Route"
                      : activeDispatch?.status === "ASSIGNED"
                      ? "Ambulance Assigned"
                      : "Dispatching Ambulance"}
                  </span>
                </div>

                <div>
                  <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                    {activeIncident.status === "CANCELLED"
                      ? "Emergency Request Cancelled"
                      : activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED"
                      ? "Emergency Care Completed"
                      : activeDispatch?.status === "ON_SCENE"
                      ? "Help Has Arrived On Scene"
                      : activeDispatch?.status === "EN_ROUTE_INCIDENT"
                      ? "Help Is On The Way"
                      : activeDispatch?.status === "ASSIGNED"
                      ? "Ambulance Dispatched"
                      : "Emergency Assistance"}
                  </h1>
                  <p className="text-sm sm:text-base text-slate-700 mt-1 max-w-md mx-auto font-medium">
                    {activeIncident.status === "CANCELLED"
                      ? "This emergency request was cancelled. Emergency resources have been returned to service."
                      : activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED"
                      ? "Patient safely transferred to emergency department care."
                      : activeDispatch?.status === "ON_SCENE"
                      ? "Paramedics are with the patient providing emergency medical care."
                      : activeDispatch?.status === "EN_ROUTE_INCIDENT"
                      ? `Ambulance ${activeDispatch.ambulance_call_sign || ""} is traveling directly to your location.`
                      : activeDispatch?.status === "ASSIGNED"
                      ? `Ambulance ${activeDispatch.ambulance_call_sign || ""} assigned. Crew preparing to respond.`
                      : "Your emergency request is registered and responders are mobilized."}
                  </p>
                </div>

                <div className="pt-3 border-t border-slate-100 text-left space-y-2 text-sm">
                  <div className="flex items-start gap-2 text-slate-800">
                    <MapPin className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                    <span className="font-bold text-slate-900">{activeIncident.location_address}</span>
                  </div>
                  <div className="flex items-start gap-2 text-slate-700 pl-6">
                    <span>
                      <strong>Emergency:</strong> {activeIncident.chief_complaint}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-slate-700 pl-6 text-xs sm:text-sm">
                    <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    <span>
                      <strong>Requested Time:</strong> {formatIST(activeIncident.created_at)}
                    </span>
                  </div>
                  <div className="text-xs font-semibold text-slate-600 pl-6">
                    Reference: #{activeIncident.id}
                  </div>
                </div>
              </div>

              {/* 2. Interactive Live Map */}
              <div className="space-y-1.5">
                <span className="text-xs sm:text-sm font-bold text-slate-900 uppercase tracking-wider block">
                  Emergency Location & Route Map
                </span>
                <DynamicCitizenTrackingMap
                  incidentLat={activeIncident.latitude}
                  incidentLng={activeIncident.longitude}
                  incidentAddress={activeIncident.location_address}
                  ambulanceLat={activeDispatch?.ambulance_current_latitude}
                  ambulanceLng={activeDispatch?.ambulance_current_longitude}
                  ambulanceCallSign={activeDispatch?.ambulance_call_sign}
                  ambulanceType={activeDispatch?.ambulance_vehicle_type}
                  hospitalLat={activeDispatch?.destination_hospital_latitude}
                  hospitalLng={activeDispatch?.destination_hospital_longitude}
                  hospitalName={activeDispatch?.destination_hospital_name}
                />
              </div>

              {/* 3. Resource Allocation Cards (Ambulance & Hospital) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Assigned Ambulance */}
                <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 shrink-0">
                        <Ambulance className="w-5 h-5" />
                      </div>
                      <div>
                        <span className="text-xs font-bold text-slate-600 uppercase tracking-wider block">
                          Assigned Ambulance
                        </span>
                        <p className="text-base font-black text-slate-900">
                          {activeDispatch?.ambulance_call_sign || "Matching closest ambulance..."}
                        </p>
                      </div>
                    </div>
                    {activeDispatch?.ambulance_vehicle_type && (
                      <span className="text-xs font-extrabold px-2.5 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-200 uppercase">
                        {activeDispatch.ambulance_vehicle_type}
                      </span>
                    )}
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs sm:text-sm font-semibold text-slate-800 flex items-center justify-between">
                    <span>Unit Status:</span>
                    <span className="font-bold text-blue-700">
                      {activeDispatch?.status === "ON_SCENE"
                        ? "Arrived On Scene"
                        : activeDispatch?.status === "EN_ROUTE_INCIDENT"
                        ? "En Route to Location"
                        : activeDispatch?.status === "EN_ROUTE_HOSPITAL"
                        ? "Transporting to Hospital"
                        : activeDispatch?.status === "AT_HOSPITAL"
                        ? "Arrived at Hospital"
                        : activeDispatch?.status === "ASSIGNED"
                        ? "Assigned • Preparing"
                        : "Locating Unit"}
                    </span>
                  </div>

                  {/* Actual ETA */}
                  {activeDispatch?.estimated_eta_seconds && activeDispatch.estimated_eta_seconds > 0 ? (
                    <div className="p-2.5 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-between text-xs sm:text-sm font-semibold text-blue-900">
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-4 h-4 text-blue-600" />
                        <span>Estimated Arrival:</span>
                      </span>
                      <span className="font-black font-mono text-base text-blue-700">
                        ~{Math.round(activeDispatch.estimated_eta_seconds / 60)} mins
                      </span>
                    </div>
                  ) : (
                    <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs sm:text-sm text-slate-700 font-medium flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-slate-500 shrink-0" />
                      <span>ETA: Calculated upon crew route activation</span>
                    </div>
                  )}

                  {activeDispatch?.ambulance_current_latitude && activeDispatch?.ambulance_current_longitude && (
                    <div className="p-2 rounded-lg bg-emerald-50/70 border border-emerald-100 text-xs text-emerald-900 font-medium flex items-center justify-between font-mono">
                      <span className="flex items-center gap-1 font-semibold">
                        <Navigation className="w-3.5 h-3.5 text-emerald-600" />
                        GPS Telemetry:
                      </span>
                      <span>
                        {activeDispatch.ambulance_current_latitude.toFixed(4)},{" "}
                        {activeDispatch.ambulance_current_longitude.toFixed(4)}
                      </span>
                    </div>
                  )}
                </div>

                {/* Destination Hospital */}
                <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 shrink-0">
                      <Building2 className="w-5 h-5" />
                    </div>
                    <div>
                      <span className="text-xs font-bold text-slate-600 uppercase tracking-wider block">
                        Destination Hospital
                      </span>
                      <p className="text-base font-black text-slate-900 truncate max-w-[200px]">
                        {activeDispatch?.destination_hospital_name || "Coordinating hospital facility..."}
                      </p>
                    </div>
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs sm:text-sm text-slate-800 font-medium flex items-center justify-between">
                    <span>Bed Reservation:</span>
                    <strong
                      className={`font-bold ${
                        activeDispatch?.hospital_confirmation_status === "ACCEPTED"
                          ? "text-emerald-700"
                          : "text-amber-700"
                      }`}
                    >
                      {activeDispatch?.hospital_confirmation_status === "ACCEPTED"
                        ? "Bed Reserved & ER Ready"
                        : "Awaiting ER Confirmation"}
                    </strong>
                  </div>

                  {activeDispatch?.destination_hospital_address && (
                    <p className="text-xs sm:text-sm text-slate-700 truncate flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>{activeDispatch.destination_hospital_address}</span>
                    </p>
                  )}
                </div>
              </div>

              {/* 4. Response Timeline */}
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs sm:text-sm font-bold text-slate-900 uppercase tracking-wider block">
                    Response Progress
                  </span>
                  <span className="text-xs font-bold text-slate-600">Step {currentStage} of 6</span>
                </div>

                <div className="relative flex items-center justify-between pt-2">
                  <div className="absolute left-6 right-6 top-6 h-1 bg-slate-100 z-0" />
                  <div
                    className="absolute left-6 top-6 h-1 bg-emerald-500 z-0 transition-all duration-500"
                    style={{ width: `${((currentStage - 1) / 5) * 88}%` }}
                  />

                  {[
                    { num: 1, label: "Request Received" },
                    { num: 2, label: "Ambulance Dispatched" },
                    { num: 3, label: "En Route to Scene" },
                    { num: 4, label: "Arrived on Scene" },
                    { num: 5, label: "In Transit to Hospital" },
                    { num: 6, label: "Hospital ER Care" },
                  ].map((step) => {
                    const isDone = currentStage >= step.num;
                    const isCurrent = currentStage === step.num;
                    return (
                      <div key={step.num} className="relative z-10 flex flex-col items-center">
                        <div
                          className={`w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center font-bold text-xs transition-all ${
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
                          className={`text-[11px] sm:text-xs font-bold mt-2 text-center max-w-[55px] sm:max-w-none leading-tight ${
                            isCurrent ? "text-blue-700" : isDone ? "text-slate-800" : "text-slate-500"
                          }`}
                        >
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 p-4 rounded-xl bg-blue-50/70 border border-blue-100 flex items-start gap-2.5 text-xs sm:text-sm text-blue-900 leading-relaxed">
                  <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-blue-950 block">Current Status</span>
                    <span className="font-medium">
                      {activeIncident.status === "CANCELLED"
                        ? "This emergency request was cancelled. Emergency resources have been returned to service."
                        : activeIncident.status === "RESOLVED" || activeIncident.status === "CLOSED"
                        ? "Patient safely transferred to emergency department care. Mission concluded."
                        : currentStage === 1
                        ? "Request received and triaged. Identifying nearest available ambulance and suitable emergency hospital."
                        : currentStage === 2
                        ? `Ambulance ${activeDispatch?.ambulance_call_sign || "assigned"}. Emergency department bed reserved.`
                        : currentStage === 3
                        ? `Ambulance ${activeDispatch?.ambulance_call_sign || "assigned"} is actively on the way to your location.`
                        : currentStage === 4
                        ? "Paramedic crew has arrived at your location and is providing emergency stabilization."
                        : currentStage === 5
                        ? `Patient secured. Inbound to ${activeDispatch?.destination_hospital_name || "receiving emergency department"}.`
                        : "Patient transferred to hospital emergency care."}
                    </span>
                  </div>
                </div>

                {/* Chronological Milestone Timeline */}
                <div className="pt-3 border-t border-slate-100 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 uppercase tracking-wider block">
                      Chronological Timeline (IST)
                    </span>
                    <span className="text-[11px] font-semibold text-slate-500">
                      {timelineEvents.length} Recorded Milestone{timelineEvents.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {timelineEvents.length > 0 ? (
                      timelineEvents.map((evt, idx) => (
                        <div
                          key={evt.id || idx}
                          className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-start justify-between gap-3 text-xs"
                        >
                          <div className="space-y-0.5">
                            <span className="font-bold text-slate-900 block">{evt.event_title}</span>
                            <p className="text-slate-600 text-[11px] leading-relaxed">{evt.event_description}</p>
                          </div>
                          <span className="text-slate-700 font-semibold shrink-0 text-right font-mono text-[11px] bg-white px-2 py-0.5 rounded border border-slate-200">
                            {formatIST(evt.created_at)}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs">
                        <div>
                          <span className="font-bold text-slate-900 block">Emergency SOS Registered</span>
                          <p className="text-slate-600 text-[11px]">Request logged and dispatched to regional CAD operators.</p>
                        </div>
                        <span className="text-slate-700 font-semibold font-mono text-[11px] bg-white px-2 py-0.5 rounded border border-slate-200">
                          {formatIST(activeIncident.created_at)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* 5. Tracking Actions */}
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => fetchActiveIncident(true)}
                  disabled={isRefreshingTracking}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs sm:text-sm font-bold text-slate-800 transition flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingTracking ? "animate-spin text-blue-600" : ""}`} />
                  <span>{isRefreshingTracking ? "Refreshing..." : "Refresh Tracking"}</span>
                </button>

                {activeIncident.status !== "CANCELLED" &&
                  activeIncident.status !== "RESOLVED" &&
                  activeIncident.status !== "CLOSED" && (
                    <button
                      type="button"
                      onClick={() => setIsCancelModalOpen(true)}
                      className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-xs sm:text-sm font-bold text-red-700 transition cursor-pointer"
                    >
                      Cancel Emergency Request
                    </button>
                  )}

                <button
                  type="button"
                  onClick={() => setIsTrackingViewOpen(false)}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs sm:text-sm font-bold text-slate-800 transition cursor-pointer"
                >
                  Back to Emergency Home
                </button>

                <button
                  type="button"
                  onClick={handleResetForNewSos}
                  className="w-full sm:w-auto px-4 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs sm:text-sm font-semibold text-slate-700 transition cursor-pointer"
                >
                  Report Another Emergency / Start Over
                </button>
              </div>
            </div>
          )
        ) : (
          /* ============================================================== */
          /* CITIZEN HOMEPAGE — MINIMAL REPORTING INTERFACE               */
          /* ============================================================== */
          <div className="space-y-6 py-4">
            {/* 1. Main Heading */}
            <div className="text-center space-y-1">
              <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
                Emergency Assistance
              </h1>
              <p className="text-sm sm:text-base text-slate-700 max-w-md mx-auto font-medium">
                Tap Call 112 to speak or select Text SOS to type your emergency.
              </p>
            </div>

            {/* 2. PRIMARY ACTION — CALL 112 (Speech-to-Text Prototype) */}
            <div className="flex flex-col items-center justify-center pt-2 pb-1">
              <button
                type="button"
                onClick={handleSimulatedCall112}
                aria-label="Call 112 emergency intake"
                className={`group relative w-44 h-44 sm:w-48 sm:h-48 rounded-full text-white flex flex-col items-center justify-center transition-all duration-200 active:scale-95 cursor-pointer focus:outline-none focus:ring-4 focus:ring-red-200 ${
                  voiceState === "LISTENING"
                    ? "bg-red-700 shadow-2xl shadow-red-300 ring-4 ring-red-400"
                    : "bg-red-600 hover:bg-red-700 shadow-xl shadow-red-200/80"
                }`}
              >
                <span
                  className={`absolute -inset-2 rounded-full border-2 border-red-400/40 pointer-events-none ${
                    voiceState === "LISTENING" ? "animate-ping opacity-75" : "animate-pulse"
                  }`}
                />

                <div className="flex flex-col items-center gap-1 z-10">
                  {voiceState === "LISTENING" ? (
                    <Mic className="w-12 h-12 stroke-[2.2] animate-bounce text-white" />
                  ) : (
                    <Phone className="w-12 h-12 stroke-[2.2] group-hover:scale-105 transition-transform" />
                  )}
                  <span className="text-3xl sm:text-4xl font-black tracking-tight mt-1">Call 112</span>
                  {voiceState === "LISTENING" && (
                    <span className="text-xs font-bold text-red-100 uppercase tracking-widest mt-1">
                      Listening...
                    </span>
                  )}
                </div>
              </button>

              {/* Readable prototype disclaimer */}
              <p className="text-xs sm:text-sm text-slate-600 font-medium mt-3 text-center">
                Prototype demonstration — does not dial real emergency services.
              </p>
            </div>

            {/* 3. SECONDARY ACTION — TEXT SOS */}
            <div className="flex items-center justify-center max-w-xs mx-auto w-full pt-1">
              <button
                type="button"
                onClick={handleTextSosClick}
                className="w-full py-2.5 px-4 rounded-xl border border-blue-200 bg-blue-50/70 hover:bg-blue-100 text-blue-900 text-sm sm:text-base font-bold shadow-2xs flex items-center justify-center gap-2 transition cursor-pointer active:scale-[0.98]"
              >
                <MessageSquare className="w-4 h-4 text-blue-600" />
                <span>Text SOS</span>
              </button>
            </div>

            {/* ============================================================ */}
            {/* UNIFIED EMERGENCY REPORT FORM (SAME SCREEN)                  */}
            {/* ============================================================ */}
            <div className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 shadow-sm space-y-5">
              {/* Emergency Description Field (Hidden by default; revealed on Text SOS or Voice Input) */}
              {isDescriptionVisible && (
                <div className="space-y-1.5 animate-in fade-in duration-200">
                  <div className="flex items-center justify-between">
                    <label className="text-xs sm:text-sm font-bold text-slate-900 uppercase tracking-wider block">
                      Emergency Description <span className="text-red-600">*</span>
                    </label>
                    <span className="text-xs font-semibold text-slate-600 font-mono">
                      {incidentDescription.length} / {MAX_DESCRIPTION_LENGTH}
                    </span>
                  </div>
                  <textarea
                    ref={descriptionInputRef}
                    value={incidentDescription}
                    onChange={(e) => setIncidentDescription(e.target.value.slice(0, MAX_DESCRIPTION_LENGTH))}
                    placeholder="Describe what happened, patient symptoms or condition..."
                    rows={3}
                    maxLength={MAX_DESCRIPTION_LENGTH}
                    className="w-full px-3.5 py-2.5 text-sm sm:text-base rounded-xl border border-slate-200 bg-slate-50 text-slate-900 placeholder-slate-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 transition"
                  />
                </div>
              )}

              {/* Emergency Category Selector (Same Screen) */}
              <div className="space-y-2">
                <label className="text-xs sm:text-sm font-bold text-slate-900 uppercase tracking-wider block">
                  Select Emergency Category <span className="text-red-600">*</span>
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {EMERGENCY_CATEGORIES.map((category) => {
                    const IconComp = category.icon;
                    const isSelected = selectedCategory === category.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        onClick={() => setSelectedCategory(category.id)}
                        className={`p-3 rounded-xl border text-left transition flex items-center gap-2.5 cursor-pointer ${
                          isSelected
                            ? "bg-red-50 border-red-500 text-red-900 ring-2 ring-red-300 font-bold shadow-2xs"
                            : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50 font-medium"
                        }`}
                      >
                        <div
                          className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                            isSelected ? "bg-red-600 text-white" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          <IconComp className="w-4 h-4" />
                        </div>
                        <span className="text-sm font-bold leading-tight">{category.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Specific Emergency Type Input (Revealed only when 'Other' is selected) */}
                {selectedCategory === "OTHER" && (
                  <div className="pt-2 space-y-1 animate-in fade-in slide-in-from-top-1 duration-150">
                    <label className="text-xs sm:text-sm font-bold text-slate-800 block">
                      Specify emergency type <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      value={customOtherType}
                      onChange={(e) => setCustomOtherType(e.target.value)}
                      placeholder="e.g. Hazardous chemical spill, drowning, structure fire..."
                      className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 bg-white text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 transition"
                    />
                  </div>
                )}
              </div>

              {/* Automatic GPS Location Status & Manual Fallback */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0">
                      <MapPin className="w-4 h-4 text-red-600" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold border ${locationBadge.color}`}
                        >
                          {locationBadge.icon}
                          <span>{locationBadge.text}</span>
                        </span>
                      </div>
                      <p className="text-sm font-semibold text-slate-900 truncate mt-0.5">
                        {selectedAddress || "Detecting live GPS location..."}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setIsManualLocationOpen((prev) => !prev)}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-800 text-xs sm:text-sm font-bold transition shrink-0 cursor-pointer"
                  >
                    {isManualLocationOpen ? "Close" : "Change Location"}
                  </button>
                </div>

                {/* Auto-revealed if GPS fails, or toggled by Change Location */}
                {(isManualLocationOpen ||
                  gpsStatus === "DENIED" ||
                  gpsStatus === "UNAVAILABLE" ||
                  gpsStatus === "TIMEOUT") && (
                  <div className="pt-2 border-t border-slate-200 space-y-2 animate-in fade-in duration-150">
                    <label className="text-xs sm:text-sm font-bold text-slate-800 block">
                      Address, area or landmark in Mangaluru:
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={manualInput}
                        onChange={(e) => {
                          setManualInput(e.target.value);
                          setSelectedAddress(e.target.value);
                        }}
                        placeholder="e.g. Hampankatta Circle, KMC Hospital Ambedkar Road..."
                        className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-slate-300 bg-white text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                      <MapPin className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    </div>

                    <div className="space-y-1 pt-1">
                      <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block">
                        Quick select landmark:
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {MANGALURU_LANDMARKS.map((landmark) => (
                          <button
                            key={landmark.name}
                            type="button"
                            onClick={() => handleSelectLandmark(landmark)}
                            className="px-2.5 py-1 rounded-md text-xs font-medium border border-slate-200 bg-white hover:bg-slate-100 text-slate-800 transition cursor-pointer"
                          >
                            {landmark.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="pt-1 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={acquireGps}
                        className="text-xs font-bold text-blue-700 hover:text-blue-900 flex items-center gap-1 cursor-pointer"
                      >
                        <Crosshair className={`w-3.5 h-3.5 ${gpsStatus === "ACQUIRING" ? "animate-spin" : ""}`} />
                        <span>Detect Live GPS Again</span>
                      </button>

                      {manualInput.trim() && (
                        <button
                          type="button"
                          onClick={handleConfirmManualLocation}
                          className="px-3.5 py-1.5 bg-red-600 text-white rounded-md text-xs font-bold shadow-2xs cursor-pointer hover:bg-red-700"
                        >
                          Confirm
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Collapsible Additional Details (Optional) */}
              <div className="border border-slate-200 rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdditionalInfo((prev) => !prev)}
                  className="w-full p-3 bg-slate-50 hover:bg-slate-100 flex items-center justify-between text-xs sm:text-sm font-bold text-slate-800 transition text-left cursor-pointer"
                >
                  <span>Additional Details (Optional)</span>
                  {showAdditionalInfo ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>

                {showAdditionalInfo && (
                  <div className="p-4 bg-white space-y-3.5 border-t border-slate-200">
                    <div className="space-y-1">
                      <label className="text-xs sm:text-sm font-semibold text-slate-800 block">
                        Specific floor, building or nearby landmark
                      </label>
                      <input
                        type="text"
                        value={specificLandmark}
                        onChange={(e) => setSpecificLandmark(e.target.value)}
                        placeholder="e.g. 2nd floor, opposite bus stand, near signal..."
                        className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500"
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs sm:text-sm font-semibold text-slate-800 block">Number of injured people</label>
                      <div className="grid grid-cols-4 gap-2">
                        {["1", "2", "3+", "Unknown"].map((count) => (
                          <button
                            key={count}
                            type="button"
                            onClick={() => setInjuredCount(count)}
                            className={`py-1.5 px-2 rounded-lg border text-xs sm:text-sm font-bold transition text-center cursor-pointer ${
                              injuredCount === count
                                ? "bg-blue-50 border-blue-500 text-blue-900 ring-1 ring-blue-300"
                                : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                            }`}
                          >
                            {count === "Unknown" ? "Unknown" : `${count} ${count === "1" ? "person" : "people"}`}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs sm:text-sm font-semibold text-slate-800 block">Critical Condition Flags</label>
                      <div className="grid grid-cols-2 gap-2 text-xs sm:text-sm">
                        <label className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer text-slate-800 font-medium">
                          <input
                            type="checkbox"
                            checked={flagUnconscious}
                            onChange={(e) => setFlagUnconscious(e.target.checked)}
                            className="rounded text-red-600 focus:ring-red-500 w-4 h-4"
                          />
                          <span>Patient Unconscious</span>
                        </label>
                        <label className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer text-slate-800 font-medium">
                          <input
                            type="checkbox"
                            checked={flagBreathing}
                            onChange={(e) => setFlagBreathing(e.target.checked)}
                            className="rounded text-red-600 focus:ring-red-500 w-4 h-4"
                          />
                          <span>Breathing Difficulty</span>
                        </label>
                        <label className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer text-slate-800 font-medium">
                          <input
                            type="checkbox"
                            checked={flagSevereBleeding}
                            onChange={(e) => setFlagSevereBleeding(e.target.checked)}
                            className="rounded text-red-600 focus:ring-red-500 w-4 h-4"
                          />
                          <span>Severe Bleeding</span>
                        </label>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Primary Emergency Submission Button (Duplicate Click Protection) */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleSubmitEmergency}
                  disabled={!isFormValid || isSubmitting}
                  className={`w-full py-4 px-6 rounded-xl font-black text-sm sm:text-base flex items-center justify-center gap-2.5 transition active:scale-[0.99] shadow-md ${
                    isFormValid && !isSubmitting
                      ? "bg-red-600 hover:bg-red-700 text-white shadow-red-200/80 cursor-pointer"
                      : "bg-slate-200 text-slate-400 cursor-not-allowed shadow-none"
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
                {!isFormValid && (
                  <p className="text-xs sm:text-sm text-slate-600 font-medium text-center mt-2">
                    {!incidentDescription.trim()
                      ? "Select Call 112 to speak or Text SOS to provide emergency details."
                      : selectedCategory === "OTHER" && !customOtherType.trim()
                      ? "Please specify the custom emergency type."
                      : !isLocationValid
                      ? "Please confirm emergency location."
                      : "Complete required fields to send emergency SOS."}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ============================================================== */}
      {/* CANCELLATION MODAL                                             */}
      {/* ============================================================== */}
      {isCancelModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs font-sans">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <h3 className="text-base font-bold text-slate-900">Cancel Emergency Request?</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsCancelModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 p-1 rounded-lg cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              Canceling will notify dispatchers and immediately release any dispatched ambulance crew and reserved hospital trauma beds back into public service.
            </p>
            <div className="space-y-1.5">
              <label className="text-xs sm:text-sm font-semibold text-slate-700 block">
                Reason for cancellation (optional):
              </label>
              <select
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full px-3 py-2 text-xs sm:text-sm rounded-xl border border-slate-200 bg-slate-50 text-slate-800 focus:outline-none focus:ring-2 focus:ring-red-500"
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
                className="px-4 py-2 text-xs sm:text-sm font-semibold rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 transition cursor-pointer"
              >
                Keep Active
              </button>
              <button
                type="button"
                onClick={handleCancelIncident}
                disabled={isCancelling}
                className="px-4 py-2 text-xs sm:text-sm font-bold rounded-xl bg-red-600 hover:bg-red-700 text-white transition flex items-center gap-1.5 cursor-pointer"
              >
                {isCancelling ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
                <span>Confirm Cancellation</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white py-3 px-4 text-center text-xs text-slate-600 font-medium">
        ResQFlow Emergency Response Platform • Mangaluru District Administration & Health Services
      </footer>
    </div>
  );
}
