"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { formatIST, getRemainingSeconds } from "@/lib/utils";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Ambulance,
  ArrowRight,
  Battery,
  Bell,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Compass,
  Copy,
  ExternalLink,
  FileText,
  Fuel,
  Heart,
  History,
  LifeBuoy,
  LogOut,
  MapPin,
  Navigation,
  Phone,
  PhoneCall,
  Radio,
  RefreshCw,
  Send,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  Truck,
  User,
  Volume2,
  VolumeX,
  Wind,
  Wrench,
  X,
} from "lucide-react";
import { formatDistance, formatDuration } from "@/lib/utils";
import AmbulanceMapWrapper from "@/components/AmbulanceMapWrapper";

interface VitalsRecord {
  id: number;
  dispatch_id: number;
  incident_id: number;
  heart_rate: number;
  blood_pressure_systolic: number;
  blood_pressure_diastolic: number;
  oxygen_saturation: number;
  respiratory_rate: number;
  notes?: string | null;
  recorded_at: string;
}

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
  vitals?: VitalsRecord[];
}

interface AmbulanceEntity {
  id: number;
  call_sign: string;
  vehicle_type: string;
  equipment: string[];
  paramedic_level: string;
  status: string;
  base_station: string;
  current_latitude: number;
  current_longitude: number;
  fuel_level_percent: number;
  is_active: boolean;
}

// -------------------------------------------------------------
// Web Audio API Emergency Alarm (Triple Dual-Tone Medical Sequence)
// -------------------------------------------------------------
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtxClass) return null;
  if (!sharedAudioContext || sharedAudioContext.state === "closed") {
    sharedAudioContext = new AudioCtxClass();
  }
  return sharedAudioContext;
}

function playEmergencyAlarm(durationSeconds = 4): () => void {
  try {
    const audioCtx = getSharedAudioContext();
    if (!audioCtx) return () => {};

    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch((err) => {
        console.warn("Autoplay blocked: user interaction required to unmute chime", err);
      });
    }

    let isStopped = false;
    let timerId: any = null;

    const stopAlarm = () => {
      isStopped = true;
      if (timerId) clearTimeout(timerId);
    };

    const playBeepTriple = (timeOffset: number) => {
      if (isStopped || audioCtx.state !== "running") return;
      [0, 0.26, 0.52].forEach((delay, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const freq = idx === 2 ? 1046.5 : 880;
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime + timeOffset + delay);
        gain.gain.setValueAtTime(0.28, audioCtx.currentTime + timeOffset + delay);
        gain.gain.exponentialRampToValueAtTime(0.005, audioCtx.currentTime + timeOffset + delay + 0.17);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + timeOffset + delay);
        osc.stop(audioCtx.currentTime + timeOffset + delay + 0.19);
      });
    };

    playBeepTriple(0);
    playBeepTriple(1.1);
    playBeepTriple(2.2);

    timerId = setTimeout(stopAlarm, durationSeconds * 1000);
    return stopAlarm;
  } catch (err) {
    console.warn("Autoplay audio blocked or AudioContext unavailable:", err);
    return () => {};
  }
}

export default function AmbulancePortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(() => {
    if (typeof window !== "undefined") {
      try {
        const cached = localStorage.getItem("lifelink_user");
        return cached ? JSON.parse(cached) : null;
      } catch {
        return null;
      }
    }
    return null;
  });
  const [ambulance, setAmbulance] = useState<AmbulanceEntity | null>(null);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [currentTab, setCurrentTab] = useState<
    "home" | "missions" | "vehicle" | "support"
  >("home");
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{
    text: string;
    type: "success" | "error" | "info";
  } | null>(null);

  // Modals state
  const [showPickupModal, setShowPickupModal] = useState(false);
  const [showAssistanceModal, setShowAssistanceModal] = useState(false);
  const [showReportIssueModal, setShowReportIssueModal] = useState(false);
  const [selectedMissionDetails, setSelectedMissionDetails] =
    useState<DispatchRecord | null>(null);

  // Assistance form state
  const [assistanceType, setAssistanceType] = useState<string>("POLICE");
  const [assistanceNotes, setAssistanceNotes] = useState<string>("");

  // Report issue form state
  const [issueType, setIssueType] = useState<string>("MECHANICAL");
  const [issueNotes, setIssueNotes] = useState<string>("");
  const [issueMarkMaintenance, setIssueMarkMaintenance] =
    useState<boolean>(false);

  // Patient vitals state
  const [missionVitals, setMissionVitals] = useState<VitalsRecord[]>([]);
  const [showVitalsForm, setShowVitalsForm] = useState(false);
  const [vitalsSubmitting, setVitalsSubmitting] = useState(false);
  const [vitalsError, setVitalsError] = useState<string | null>(null);
  const [vitalsSuccess, setVitalsSuccess] = useState<string | null>(null);
  const [vitalsForm, setVitalsForm] = useState({
    heartRate: "",
    bpSystolic: "",
    bpDiastolic: "",
    oxygenSat: "",
    respRate: "",
    notes: "",
  });

  // Countdown state for incoming pending assignment
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);

  // Toast / copy feedback
  const [copyToast, setCopyToast] = useState<string | null>(null);

  const isActionInProgressRef = useRef(false);
  const processedEventsRef = useRef<Set<string>>(new Set());
  const alertedDispatchIdsRef = useRef<Set<string>>(new Set());
  const alarmStopRef = useRef<(() => void) | null>(null);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Test/unlock audio on user gesture
  const handleUnlockAudio = () => {
    const ctx = getSharedAudioContext();
    if (ctx) {
      ctx.resume().then(() => {
        setAudioUnlocked(true);
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(440, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
          gain.gain.setValueAtTime(0.2, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.15);
        } catch (_) {}
      }).catch(() => {});
    }
  };

  useEffect(() => {
    const onUserGesture = () => {
      const ctx = getSharedAudioContext();
      if (ctx && ctx.state === "suspended") {
        ctx.resume().then(() => setAudioUnlocked(true)).catch(() => {});
      } else if (ctx && ctx.state === "running") {
        setAudioUnlocked(true);
      }
    };
    window.addEventListener("click", onUserGesture, { once: true });
    window.addEventListener("keydown", onUserGesture, { once: true });
    return () => {
      window.removeEventListener("click", onUserGesture);
      window.removeEventListener("keydown", onUserGesture);
    };
  }, []);

  // Data fetching
  const fetchMissionVitals = useCallback(
    async (dispatchId: number) => {
      const token =
        typeof window !== "undefined"
          ? localStorage.getItem("lifelink_token")
          : null;
      if (!token) return;
      try {
        const resp = await fetch(
          `${backendUrl}/api/dispatch/${dispatchId}/vitals`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (resp.ok) {
          const data: VitalsRecord[] = await resp.json();
          setMissionVitals(data);
        }
      } catch (err) {
        console.warn("Failed to fetch mission vitals:", err);
      }
    },
    [backendUrl]
  );

  const fetchAmbulanceData = useCallback(async () => {
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("lifelink_token")
        : null;
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
        const ambResp = await fetch(
          `${backendUrl}/api/ambulances/${userData.ambulance_id}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        if (ambResp.ok) {
          setAmbulance(await ambResp.json());
        }
      }

      const dispResp = await fetch(`${backendUrl}/api/dispatch`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (dispResp.ok) {
        const allDispatches: DispatchRecord[] = await dispResp.json();
        const targetAmbId = userData?.ambulance_id ?? user?.ambulance_id;
        const myDispatches = targetAmbId
          ? allDispatches.filter(
              (d) => Number(d.ambulance_id) === Number(targetAmbId)
            )
          : allDispatches;
        setDispatches(myDispatches);
      }
    } catch (err: any) {
      console.warn("Ambulance fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router]);

  // WebSocket Live Subscription
  useEffect(() => {
    fetchAmbulanceData();

    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("lifelink_token")
        : null;
    if (!token) return;

    const wsUrl =
      backendUrl.replace(/^http/, "ws") +
      `/ws/live?token=${encodeURIComponent(token)}`;
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
            if (
              data.event &&
              data.event !== "PONG" &&
              data.event !== "HANDSHAKE"
            ) {
              if (data.event === "DISPATCH_CREATED") {
                setFeedbackMsg({
                  text: "Incoming Emergency Mission Assignment received!",
                  type: "info",
                });
              } else if (data.event === "DISPATCH_REASSIGNED" || data.event === "DISPATCH_ESCALATED") {
                const targetAmbId = user?.ambulance_id;
                if (targetAmbId && Number(data.payload?.new_ambulance_id) === Number(targetAmbId)) {
                  setFeedbackMsg({
                    text: `🚨 Reassigned Emergency Mission Assignment (Attempt #${data.payload?.attempt_number || 1}) received!`,
                    type: "info",
                  });
                } else if (targetAmbId && Number(data.payload?.previous_ambulance_id) === Number(targetAmbId)) {
                  setFeedbackMsg({
                    text: "Previous provisional assignment was reassigned to another unit.",
                    type: "info",
                  });
                }
              } else if (data.event === "DISPATCH_ESCALATION_FAILED") {
                setFeedbackMsg({
                  text: "Provisional reservation expired. Awaiting Dispatcher reassignment.",
                  type: "info",
                });
              } else if (data.event === "PATIENT_PICKED_UP") {
                setFeedbackMsg({
                  text: "Patient pickup confirmed. En route to receiving hospital ER.",
                  type: "success",
                });
              } else if (data.event === "PATIENT_ARRIVED_HOSPITAL") {
                setFeedbackMsg({
                  text: "Patient arrival at hospital trauma bay registered.",
                  type: "success",
                });
              } else if (data.event === "ASSISTANCE_REQUESTED") {
                setFeedbackMsg({
                  text: "Operational assistance request broadcasted to Control Room.",
                  type: "info",
                });
              }
              fetchAmbulanceData();
            }
          } catch (_) {}
        };
      } catch (_) {}
    }

    connect();
    const pollInterval = setInterval(fetchAmbulanceData, 6000);

    return () => {
      clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
      if (alarmStopRef.current) {
        alarmStopRef.current();
        alarmStopRef.current = null;
      }
    };
  }, [backendUrl, fetchAmbulanceData]);

  // Dispatches classifications
  const pendingDispatch = dispatches.find(
    (d) =>
      d.coordination_status === "PENDING_CONFIRMATIONS" &&
      d.ambulance_confirmation_status === "PENDING"
  );

  const awaitingHospitalDispatch = dispatches.find(
    (d) =>
      d.coordination_status === "PENDING_CONFIRMATIONS" &&
      d.ambulance_confirmation_status === "ACCEPTED"
  );

  const activeMission = dispatches.find(
    (d) =>
      d.coordination_status === "CONFIRMED" &&
      d.status !== "COMPLETED" &&
      d.status !== "CANCELLED"
  );

  // Incoming alert audio trigger
  useEffect(() => {
    if (pendingDispatch) {
      const alertKey = `${pendingDispatch.id}_${pendingDispatch.attempt_number || 1}`;
      if (!alertedDispatchIdsRef.current.has(alertKey)) {
        alertedDispatchIdsRef.current.add(alertKey);
        const stop = playEmergencyAlarm(4);
        alarmStopRef.current = stop;
      }
    }
    if (!pendingDispatch && alarmStopRef.current) {
      alarmStopRef.current();
      alarmStopRef.current = null;
    }
  }, [pendingDispatch]);

  // Reservation countdown with UTC normalization
  useEffect(() => {
    if (!pendingDispatch) {
      setRemainingSeconds(null);
      return;
    }

    const updateTimer = () => {
      if (!pendingDispatch.reservation_expires_at) {
        setRemainingSeconds(90);
        return;
      }
      const diffSecs = getRemainingSeconds(pendingDispatch.reservation_expires_at);
      setRemainingSeconds(diffSecs);
    };

    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [pendingDispatch]);

  // Auto-fetch vitals on active mission change
  useEffect(() => {
    if (activeMission?.id) {
      fetchMissionVitals(activeMission.id);
    } else {
      setMissionVitals([]);
    }
  }, [activeMission?.id, fetchMissionVitals]);

  // Handlers
  const handleCopy = (textToCopy: string, label: string) => {
    navigator.clipboard?.writeText(textToCopy);
    setCopyToast(`${label} copied to clipboard!`);
    setTimeout(() => setCopyToast(null), 3000);
  };

  const handleConfirmMission = async (
    dispatchId: number,
    decision: "ACCEPTED" | "REJECTED",
    attemptNumber?: number
  ) => {
    if (alarmStopRef.current) {
      alarmStopRef.current();
      alarmStopRef.current = null;
    }

    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    setFeedbackMsg(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(
        `${backendUrl}/api/dispatch/${dispatchId}/confirm/ambulance`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ decision, attempt_number: attemptNumber }),
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to confirm mission");
      }

      setFeedbackMsg({
        text: `Mission assignment #${dispatchId} ${
          decision === "ACCEPTED" ? "acknowledged" : "declined"
        }.`,
        type: decision === "ACCEPTED" ? "success" : "info",
      });
      await fetchAmbulanceData();
    } catch (err: any) {
      setFeedbackMsg({
        text: `Confirmation error: ${err.message}`,
        type: "error",
      });
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
      const resp = await fetch(
        `${backendUrl}/api/dispatch/${dispatchId}/step`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to advance mission lifecycle");
      }

      const updated = await resp.json();
      setFeedbackMsg({
        text: `Mission stage updated to: ${updated.status.replace(/_/g, " ")}`,
        type: "success",
      });
      await fetchAmbulanceData();
    } catch (err: any) {
      setFeedbackMsg({
        text: `Lifecycle error: ${err.message}`,
        type: "error",
      });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  const handleConfirmPatientPickup = async () => {
    if (!activeMission) return;
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    setShowPickupModal(false);
    setFeedbackMsg(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(
        `${backendUrl}/api/dispatch/${activeMission.id}/confirm-patient-pickup`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to confirm patient pickup");
      }

      setFeedbackMsg({
        text: "Patient pickup confirmed. En route to receiving hospital ER.",
        type: "success",
      });
      await fetchAmbulanceData();
    } catch (err: any) {
      setFeedbackMsg({
        text: `Pickup confirmation error: ${err.message}`,
        type: "error",
      });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  const handleConfirmArrivalHospital = async () => {
    if (!activeMission) return;
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    setFeedbackMsg(null);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(
        `${backendUrl}/api/dispatch/${activeMission.id}/confirm-arrival`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to confirm hospital arrival");
      }

      setFeedbackMsg({
        text: "Ambulance arrived at Hospital ER trauma bay.",
        type: "success",
      });
      await fetchAmbulanceData();
    } catch (err: any) {
      setFeedbackMsg({
        text: `Hospital arrival error: ${err.message}`,
        type: "error",
      });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  const handleToggleDutyStatus = async () => {
    if (!ambulance?.id) return;
    const isCurrentlyOnDuty = ambulance.status !== "OFF_DUTY";

    if (isCurrentlyOnDuty && activeMission) {
      setFeedbackMsg({
        text: "Cannot go Off Duty while an active emergency mission is in progress.",
        type: "error",
      });
      return;
    }

    const targetStatus = isCurrentlyOnDuty ? "OFF_DUTY" : "AVAILABLE";
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(
        `${backendUrl}/api/ambulances/${ambulance.id}/status?status=${targetStatus}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to update duty status");
      }

      const updated = await resp.json();
      setAmbulance(updated);
      setFeedbackMsg({
        text:
          targetStatus === "AVAILABLE"
            ? "Unit is now On Duty & available for dispatch."
            : "Unit marked Off Duty.",
        type: "info",
      });
    } catch (err: any) {
      setFeedbackMsg({ text: err.message, type: "error" });
    }
  };

  const handleRequestAssistance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMission) return;
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(
        `${backendUrl}/api/dispatch/${activeMission.id}/request-assistance`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            assistance_type: assistanceType,
            notes: assistanceNotes.trim() || undefined,
          }),
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to request assistance");
      }

      setShowAssistanceModal(false);
      setAssistanceNotes("");
      setFeedbackMsg({
        text: `Emergency ${assistanceType.replace(
          /_/g,
          " "
        )} backup requested. Control Room notified.`,
        type: "success",
      });
    } catch (err: any) {
      setFeedbackMsg({ text: err.message, type: "error" });
    }
  };

  const handleReportIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ambulance?.id) return;
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(
        `${backendUrl}/api/ambulances/${ambulance.id}/report-issue`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            issue_type: issueType,
            notes: issueNotes.trim() || undefined,
            mark_maintenance: issueMarkMaintenance,
          }),
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to submit vehicle report");
      }

      setShowReportIssueModal(false);
      setIssueNotes("");
      setFeedbackMsg({
        text: `Vehicle issue reported to Fleet Management.${
          issueMarkMaintenance ? " Unit marked for Maintenance." : ""
        }`,
        type: "info",
      });
      await fetchAmbulanceData();
    } catch (err: any) {
      setFeedbackMsg({ text: err.message, type: "error" });
    }
  };

  const handleSubmitVitals = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMission) return;

    setVitalsError(null);
    setVitalsSuccess(null);

    const hr = parseInt(vitalsForm.heartRate, 10);
    const sys = parseInt(vitalsForm.bpSystolic, 10);
    const dia = parseInt(vitalsForm.bpDiastolic, 10);
    const spo2 = parseInt(vitalsForm.oxygenSat, 10);
    const rr = parseInt(vitalsForm.respRate, 10);

    if (isNaN(hr) || isNaN(sys) || isNaN(dia) || isNaN(spo2) || isNaN(rr)) {
      setVitalsError("Please fill out all numeric physiological vital fields.");
      return;
    }
    if (hr < 30 || hr > 250) {
      setVitalsError("Heart rate must be between 30 and 250 bpm.");
      return;
    }
    if (sys < 50 || sys > 260) {
      setVitalsError("Systolic BP must be between 50 and 260 mmHg.");
      return;
    }
    if (dia < 30 || dia > 160) {
      setVitalsError("Diastolic BP must be between 30 and 160 mmHg.");
      return;
    }
    if (sys <= dia) {
      setVitalsError("Systolic must be strictly greater than diastolic.");
      return;
    }
    if (spo2 < 50 || spo2 > 100) {
      setVitalsError("SpO2 oxygen saturation must be between 50% and 100%.");
      return;
    }
    if (rr < 5 || rr > 60) {
      setVitalsError("Respiratory rate must be between 5 and 60 breaths/min.");
      return;
    }

    setVitalsSubmitting(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(
        `${backendUrl}/api/dispatch/${activeMission.id}/vitals`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            heart_rate: hr,
            blood_pressure_systolic: sys,
            blood_pressure_diastolic: dia,
            oxygen_saturation: spo2,
            respiratory_rate: rr,
            notes: vitalsForm.notes.trim() || undefined,
          }),
        }
      );

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to record patient vitals");
      }

      setVitalsSuccess("Patient vitals saved and relayed to hospital ER.");
      setVitalsForm({
        heartRate: "",
        bpSystolic: "",
        bpDiastolic: "",
        oxygenSat: "",
        respRate: "",
        notes: "",
      });
      await fetchMissionVitals(activeMission.id);
    } catch (err: any) {
      setVitalsError(err.message || "Network error submitting vitals");
    } finally {
      setVitalsSubmitting(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("lifelink_token");
    localStorage.removeItem("lifelink_user");
    document.cookie = "lifelink_token=; path=/; max-age=0;";
    router.push("/login");
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 space-y-3">
        <RefreshCw className="w-8 h-8 animate-spin text-red-600" />
        <p className="text-sm font-semibold text-slate-700">
          Connecting to Ambulance Mobile Telemetry...
        </p>
      </div>
    );
  }

  // Active mission targets & navigation
  const isEnRouteHospital =
    activeMission?.status === "EN_ROUTE_HOSPITAL" ||
    activeMission?.status === "AT_HOSPITAL";

  const targetLat = isEnRouteHospital
    ? activeMission?.destination_hospital_latitude
    : activeMission?.incident_latitude ?? activeMission?.incident?.latitude;

  const targetLng = isEnRouteHospital
    ? activeMission?.destination_hospital_longitude
    : activeMission?.incident_longitude ?? activeMission?.incident?.longitude;

  const targetLabel = isEnRouteHospital
    ? activeMission?.destination_hospital_name || "Receiving Hospital ER"
    : activeMission?.incident_address ||
      activeMission?.incident?.location_address ||
      "Emergency Scene";

  const targetType = isEnRouteHospital ? "hospital" : "incident";

  const isOnDuty = ambulance?.status !== "OFF_DUTY";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* ------------------------------------------------------------- */}
      {/* 1. TOP RESPONSIVE HEADER                                      */}
      {/* ------------------------------------------------------------- */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200 shadow-2xs">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          {/* Brand & Unit Badge */}
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-red-600 flex items-center justify-center text-white font-black text-sm shadow-xs">
              RF
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-extrabold text-base tracking-tight text-slate-900">
                  ResQFlow
                </span>
                <span className="px-2 py-0.5 rounded-md bg-red-50 text-red-700 border border-red-200 text-[10px] font-bold uppercase tracking-wider">
                  Ambulance Crew
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Paramedic:{" "}
                <span className="font-semibold text-slate-700">
                  {user?.full_name || user?.username || "Crew Member"}
                </span>
              </p>
            </div>
          </div>

          {/* Unit Call Sign & Duty Toggle */}
          <div className="flex items-center space-x-3 sm:space-x-4">
            {ambulance && (
              <div className="hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-slate-100 border border-slate-200 text-xs font-semibold text-slate-700">
                <Truck className="w-3.5 h-3.5 text-blue-600" />
                <span>Unit {ambulance.call_sign}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-white text-slate-500 border border-slate-200 uppercase font-mono">
                  {ambulance.vehicle_type}
                </span>
              </div>
            )}

            {/* On Duty / Off Duty Toggle Switch */}
            <button
              onClick={handleToggleDutyStatus}
              title={
                isOnDuty
                  ? "Click to go Off Duty"
                  : "Click to go On Duty & Available"
              }
              className={`flex items-center space-x-2 px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors shadow-2xs ${
                isOnDuty
                  ? "bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-300"
                  : "bg-slate-100 hover:bg-slate-200 text-slate-600 border-slate-300"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isOnDuty ? "bg-emerald-500 animate-pulse" : "bg-slate-400"
                }`}
              />
              <span>{isOnDuty ? "On Duty" : "Off Duty"}</span>
            </button>

            {/* Audio Alerts Unlock / Status Button */}
            <button
              onClick={handleUnlockAudio}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition shadow-2xs cursor-pointer ${
                audioUnlocked
                  ? "bg-slate-50 text-slate-700 border-slate-200"
                  : "bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-300 animate-pulse"
              }`}
              title={
                audioUnlocked
                  ? "Mission chime audio is active and ready"
                  : "Click to enable mission chime audio (required by browser autoplay policy)"
              }
            >
              {audioUnlocked ? (
                <>
                  <Volume2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span className="hidden md:inline">Audio Ready</span>
                </>
              ) : (
                <>
                  <VolumeX className="w-3.5 h-3.5 text-amber-600" />
                  <span>Enable Audio</span>
                </>
              )}
            </button>

            {/* Live Telemetry Pulse */}
            <div
              className="flex items-center space-x-1.5 text-[11px] text-slate-500"
              title={wsConnected ? "Telemetry Connected" : "Connecting..."}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  wsConnected ? "bg-emerald-500" : "bg-amber-400 animate-pulse"
                }`}
              />
              <span className="hidden md:inline font-mono">
                {wsConnected ? "Live" : "Syncing"}
              </span>
            </div>

            {/* Sign Out */}
            <button
              onClick={handleLogout}
              title="Sign Out"
              className="p-1.5 rounded-xl text-slate-500 hover:text-red-600 hover:bg-slate-100 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ------------------------------------------------------------- */}
        {/* 2. MINIMAL 4-TAB NAVIGATION BAR                              */}
        {/* ------------------------------------------------------------- */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-1 pb-2 flex items-center space-x-1 overflow-x-auto no-scrollbar">
          <button
            onClick={() => setCurrentTab("home")}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
              currentTab === "home"
                ? "bg-slate-900 text-white shadow-2xs"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>Home</span>
            {activeMission && (
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
            )}
          </button>

          <button
            onClick={() => setCurrentTab("missions")}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
              currentTab === "missions"
                ? "bg-slate-900 text-white shadow-2xs"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>My Missions</span>
            <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-200/80 text-slate-700 font-mono">
              {dispatches.length}
            </span>
          </button>

          <button
            onClick={() => setCurrentTab("vehicle")}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
              currentTab === "vehicle"
                ? "bg-slate-900 text-white shadow-2xs"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <Truck className="w-3.5 h-3.5" />
            <span>Vehicle Status</span>
          </button>

          <button
            onClick={() => setCurrentTab("support")}
            className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-colors ${
              currentTab === "support"
                ? "bg-slate-900 text-white shadow-2xs"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
            }`}
          >
            <LifeBuoy className="w-3.5 h-3.5" />
            <span>Help & Support</span>
          </button>
        </div>
      </header>

      {/* Feedback Banner */}
      {feedbackMsg && (
        <div
          className={`py-2 px-4 text-xs font-semibold text-center border-b ${
            feedbackMsg.type === "success"
              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
              : feedbackMsg.type === "error"
              ? "bg-red-50 text-red-800 border-red-200"
              : "bg-blue-50 text-blue-800 border-blue-200"
          }`}
        >
          {feedbackMsg.text}
        </div>
      )}

      {/* Copy Toast */}
      {copyToast && (
        <div className="fixed bottom-6 right-6 z-50 bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-medium shadow-lg flex items-center space-x-2">
          <Check className="w-4 h-4 text-emerald-400" />
          <span>{copyToast}</span>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 3. INCOMING PROVISIONAL MISSION ALERT OVERLAY                 */}
      {/* ------------------------------------------------------------- */}
      {pendingDispatch && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-lg w-full border-2 border-red-500 shadow-2xl p-6 sm:p-7 space-y-5 animate-in fade-in zoom-in-95 duration-200">
            {/* Alert Header */}
            <div className="flex items-start justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-12 h-12 rounded-2xl bg-red-100 border border-red-300 flex items-center justify-center text-red-600">
                  <ShieldAlert className="w-7 h-7 animate-pulse" />
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-extrabold text-lg text-slate-900">
                      Emergency Mission Alert
                    </span>
                    <span className="px-2 py-0.5 rounded-md bg-red-600 text-white font-black text-xs uppercase tracking-wider">
                      Priority
                    </span>
                    {pendingDispatch.attempt_number && pendingDispatch.attempt_number > 1 && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold text-[10px] uppercase border border-amber-300">
                        Attempt #{pendingDispatch.attempt_number}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-500">
                    Dispatch #{pendingDispatch.id} • Unit {pendingDispatch.ambulance_call_sign}
                  </p>
                  {!audioUnlocked && (
                    <button
                      type="button"
                      onClick={handleUnlockAudio}
                      className="mt-1 flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-300 rounded-lg px-2 py-0.5 transition"
                    >
                      <Volume2 className="w-3.5 h-3.5 text-amber-600" />
                      <span>Sound Siren Chime (Audio Muted)</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Countdown badge */}
              {remainingSeconds !== null && (
                <div className="px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-right">
                  <span className="text-[10px] uppercase font-bold text-amber-700 block">
                    Response Window
                  </span>
                  <span className="text-base font-extrabold font-mono text-amber-900">
                    {remainingSeconds}s
                  </span>
                </div>
              )}
            </div>

            {/* Emergency Details */}
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200 space-y-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
                  Chief Complaint
                </span>
                <p className="text-sm font-bold text-slate-900">
                  {pendingDispatch.incident?.chief_complaint ||
                    "Emergency Medical Assistance Required"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1 border-t border-slate-200">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
                    Incident Scene
                  </span>
                  <p className="text-xs font-semibold text-slate-800 line-clamp-2">
                    {pendingDispatch.incident_address ||
                      pendingDispatch.incident?.location_address ||
                      "Canara Engineering College Sector"}
                  </p>
                </div>
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">
                    Destination Hospital
                  </span>
                  <p className="text-xs font-semibold text-slate-800 line-clamp-2">
                    {pendingDispatch.destination_hospital_name}
                  </p>
                </div>
              </div>

              {/* Estimated Distance & ETA */}
              <div className="flex items-center justify-between pt-1 border-t border-slate-200 text-xs">
                <span className="text-slate-500 font-medium">Estimated En Route:</span>
                <span className="font-extrabold text-blue-700">
                  {formatDistance(pendingDispatch.route_distance_meters)} • ~
                  {formatDuration(pendingDispatch.estimated_eta_seconds)}
                </span>
              </div>
            </div>

            {/* Action Buttons: Acknowledge & Unable to Respond */}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                disabled={actionLoading}
                onClick={() =>
                  handleConfirmMission(pendingDispatch.id, "REJECTED", pendingDispatch.attempt_number)
                }
                className="w-full py-3 px-4 rounded-2xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-sm font-bold transition-colors"
              >
                Unable to Respond
              </button>

              <button
                type="button"
                disabled={actionLoading}
                onClick={() =>
                  handleConfirmMission(pendingDispatch.id, "ACCEPTED", pendingDispatch.attempt_number)
                }
                className="w-full py-3 px-4 rounded-2xl bg-red-600 hover:bg-red-700 text-white text-sm font-extrabold shadow-md flex items-center justify-center space-x-2 transition-colors"
              >
                {actionLoading ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Acknowledge</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* 4. MAIN BODY CONTAINER                                        */}
      {/* ------------------------------------------------------------- */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6">
        {/* ========================================================= */}
        {/* TAB 1: HOME (PRIMARY MISSION / CALM AVAILABLE STATE)     */}
        {/* ========================================================= */}
        {currentTab === "home" && (
          <div className="space-y-6">
            {/* AWAITING HOSPITAL CONFIRMATION BANNER */}
            {awaitingHospitalDispatch && !activeMission && (
              <div className="bg-amber-50 border border-amber-200 rounded-3xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                <div className="flex items-center space-x-3.5">
                  <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                    <Clock className="w-5 h-5 animate-spin" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-amber-900">
                      Assignment Acknowledged • Awaiting Hospital ER Confirmation
                    </h3>
                    <p className="text-xs text-amber-700">
                      Target hospital:{" "}
                      <span className="font-semibold">
                        {awaitingHospitalDispatch.destination_hospital_name}
                      </span>
                      . Stand by while trauma bay capacity is reserved.
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2 text-xs font-mono font-bold text-amber-800 bg-white/80 px-3 py-1.5 rounded-xl border border-amber-200">
                  <span>Reservation Pending</span>
                </div>
              </div>
            )}

            {/* ACTIVE MISSION VIEW */}
            {activeMission ? (
              <div className="space-y-6">
                {/* 1. MISSION PROGRESS STEPPER */}
                <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                    <div className="flex items-center space-x-2">
                      <span className="px-2.5 py-0.5 rounded-lg bg-red-100 text-red-800 text-xs font-extrabold uppercase tracking-wider">
                        {activeMission.incident?.triage_level || "RED"} • Active Mission
                      </span>
                      <span className="text-xs text-slate-500 font-mono">
                        #{activeMission.id}
                      </span>
                    </div>

                    <span className="text-xs font-semibold text-slate-600">
                      Current Stage:{" "}
                      <strong className="text-slate-900 uppercase">
                        {activeMission.status.replace(/_/g, " ")}
                      </strong>
                    </span>
                  </div>

                  {/* 5-step milestone stepper */}
                  <div className="grid grid-cols-5 gap-1.5 sm:gap-2">
                    {[
                      { key: "ASSIGNED", label: "Assigned" },
                      { key: "EN_ROUTE_INCIDENT", label: "En Route" },
                      { key: "ON_SCENE", label: "On Scene" },
                      { key: "EN_ROUTE_HOSPITAL", label: "Hospital Transport" },
                      { key: "AT_HOSPITAL", label: "ER Handover" },
                    ].map((step, idx) => {
                      const stages = [
                        "ASSIGNED",
                        "EN_ROUTE_INCIDENT",
                        "ON_SCENE",
                        "EN_ROUTE_HOSPITAL",
                        "AT_HOSPITAL",
                        "COMPLETED",
                      ];
                      const currentIdx = stages.indexOf(activeMission.status);
                      const isComplete = currentIdx > idx;
                      const isCurrent = currentIdx === idx;

                      return (
                        <div key={step.key} className="flex flex-col items-center text-center space-y-1.5">
                          <div
                            className={`w-7 h-7 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                              isComplete
                                ? "bg-emerald-600 text-white"
                                : isCurrent
                                ? "bg-blue-600 text-white ring-4 ring-blue-100"
                                : "bg-slate-100 text-slate-400"
                            }`}
                          >
                            {isComplete ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              <span>{idx + 1}</span>
                            )}
                          </div>
                          <span
                            className={`text-[10px] sm:text-xs font-medium line-clamp-1 ${
                              isCurrent
                                ? "text-slate-900 font-bold"
                                : isComplete
                                ? "text-emerald-700 font-semibold"
                                : "text-slate-400"
                            }`}
                          >
                            {step.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2. INCIDENT & TARGET DETAILS CARDS */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Incident / Patient Information */}
                  <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <AlertOctagon className="w-4 h-4 text-red-600" />
                        <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                          Incident Scene Details
                        </span>
                      </div>
                      <span className="text-xs font-bold text-red-600">
                        {activeMission.incident?.chief_complaint || "Emergency"}
                      </span>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start space-x-2">
                          <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                          <p className="text-xs font-semibold text-slate-800">
                            {activeMission.incident_address ||
                              activeMission.incident?.location_address ||
                              "Canara Engineering College Sector"}
                          </p>
                        </div>
                      </div>

                      {/* Coordinates & Copy */}
                      <div className="flex items-center justify-between bg-slate-50 rounded-xl px-3 py-2 border border-slate-100 text-[11px] font-mono text-slate-600">
                        <span>
                          {targetLat?.toFixed(6)}, {targetLng?.toFixed(6)}
                        </span>
                        <button
                          onClick={() =>
                            handleCopy(
                              `${targetLat}, ${targetLng}`,
                              "Coordinates"
                            )
                          }
                          className="hover:text-slate-900 flex items-center space-x-1"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Copy</span>
                        </button>
                      </div>

                      {/* Caller Information */}
                      <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
                        <div className="flex items-center space-x-1.5 text-slate-600">
                          <User className="w-3.5 h-3.5 text-slate-400" />
                          <span>
                            {activeMission.incident?.caller_name || "Emergency Caller"}
                          </span>
                        </div>
                        {activeMission.incident?.caller_phone && (
                          <a
                            href={`tel:${activeMission.incident.caller_phone}`}
                            className="inline-flex items-center space-x-1 text-blue-600 hover:text-blue-700 font-semibold"
                          >
                            <Phone className="w-3.5 h-3.5" />
                            <span>{activeMission.incident.caller_phone}</span>
                          </a>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Receiving Hospital Facility */}
                  <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Building2 className="w-4 h-4 text-emerald-600" />
                        <span className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                          Receiving Medical Center
                        </span>
                      </div>
                      <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold">
                        Trauma Bay Reserved
                      </span>
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-sm font-bold text-slate-900">
                        {activeMission.destination_hospital_name}
                      </h4>
                      <p className="text-xs text-slate-600">
                        {activeMission.destination_hospital_address ||
                          "Mangaluru Emergency Regional Center"}
                      </p>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs text-slate-500">
                        <span>Emergency ER Contact:</span>
                        <a
                          href="tel:08242220555"
                          className="font-semibold text-slate-800 hover:text-blue-600 inline-flex items-center space-x-1"
                        >
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span>0824-2220555</span>
                        </a>
                      </div>
                    </div>
                  </div>
                </div>

                {/* 3. FUNCTIONAL LEAFLET MAP WRAPPER */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-600 px-1">
                    <span>Live GPS Navigation & Tracking</span>
                    <span className="text-blue-600 font-mono">
                      {formatDistance(activeMission.route_distance_meters)} remaining
                    </span>
                  </div>
                  <AmbulanceMapWrapper
                    ambulanceLat={ambulance?.current_latitude}
                    ambulanceLng={ambulance?.current_longitude}
                    ambulanceCallSign={ambulance?.call_sign}
                    targetLat={targetLat}
                    targetLng={targetLng}
                    targetLabel={targetLabel}
                    targetType={targetType}
                    gpsStatus="CONNECTED"
                  />
                </div>

                {/* 4. CONTEXTUAL SINGLE PRIMARY ACTION BUTTON */}
                <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-sm space-y-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 block">
                    Next Mission Phase Action
                  </span>

                  {/* Stage 1: ASSIGNED -> EN ROUTE */}
                  {activeMission.status === "ASSIGNED" && (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={() => handleStepLifecycle(activeMission.id)}
                      className="w-full py-4 px-6 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-base shadow-md flex items-center justify-center space-x-3 transition-colors"
                    >
                      {actionLoading ? (
                        <RefreshCw className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          <Navigation className="w-5 h-5 fill-current" />
                          <span>Start Response — En Route to Scene</span>
                        </>
                      )}
                    </button>
                  )}

                  {/* Stage 2: EN_ROUTE_INCIDENT -> ON_SCENE */}
                  {activeMission.status === "EN_ROUTE_INCIDENT" && (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={() => handleStepLifecycle(activeMission.id)}
                      className="w-full py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-base shadow-md flex items-center justify-center space-x-3 transition-colors"
                    >
                      {actionLoading ? (
                        <RefreshCw className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          <MapPin className="w-5 h-5" />
                          <span>Arrived at Scene</span>
                        </>
                      )}
                    </button>
                  )}

                  {/* Stage 3: ON_SCENE -> CONFIRM PATIENT PICKUP (EXPLICIT CONFIRMATION) */}
                  {activeMission.status === "ON_SCENE" && (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-500">
                        Paramedic protocol: Arrival at scene does not automatically depart.
                        Confirm patient is safely inside the ambulance before starting hospital transport.
                      </p>
                      <button
                        type="button"
                        disabled={actionLoading}
                        onClick={() => setShowPickupModal(true)}
                        className="w-full py-4 px-6 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-base shadow-md flex items-center justify-center space-x-3 transition-colors"
                      >
                        {actionLoading ? (
                          <RefreshCw className="w-5 h-5 animate-spin" />
                        ) : (
                          <>
                            <Stethoscope className="w-5 h-5" />
                            <span>Confirm Patient Pickup & Start Transport</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {/* Stage 4: EN_ROUTE_HOSPITAL -> AT_HOSPITAL */}
                  {activeMission.status === "EN_ROUTE_HOSPITAL" && (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={handleConfirmArrivalHospital}
                      className="w-full py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-base shadow-md flex items-center justify-center space-x-3 transition-colors"
                    >
                      {actionLoading ? (
                        <RefreshCw className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          <Building2 className="w-5 h-5" />
                          <span>Arrived at Hospital ER Trauma Bay</span>
                        </>
                      )}
                    </button>
                  )}

                  {/* Stage 5: AT_HOSPITAL -> COMPLETE */}
                  {activeMission.status === "AT_HOSPITAL" && (
                    <button
                      type="button"
                      disabled={actionLoading}
                      onClick={() => handleStepLifecycle(activeMission.id)}
                      className="w-full py-4 px-6 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-base shadow-md flex items-center justify-center space-x-3 transition-colors"
                    >
                      {actionLoading ? (
                        <RefreshCw className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          <CheckCircle2 className="w-5 h-5" />
                          <span>Complete Handover & Finish Mission</span>
                        </>
                      )}
                    </button>
                  )}

                  {/* Secondary Quick Controls */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs">
                    <div className="flex items-center space-x-2">
                      <a
                        href="tel:08242220555"
                        className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold flex items-center space-x-1.5 transition-colors"
                      >
                        <PhoneCall className="w-3.5 h-3.5 text-blue-600" />
                        <span>Call Dispatcher</span>
                      </a>
                      <button
                        type="button"
                        onClick={() => setShowAssistanceModal(true)}
                        className="px-3 py-1.5 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 font-semibold flex items-center space-x-1.5 transition-colors"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        <span>Request Assistance</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowVitalsForm(!showVitalsForm)}
                      className="px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold flex items-center space-x-1.5 transition-colors"
                    >
                      <Activity className="w-3.5 h-3.5 text-emerald-600" />
                      <span>{showVitalsForm ? "Hide Vitals Logger" : "Log Patient Vitals"}</span>
                    </button>
                  </div>
                </div>

                {/* 5. PATIENT VITALS TELEMETRY SECTION (COLLAPSIBLE) */}
                {showVitalsForm && (
                  <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-2xs space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Heart className="w-4 h-4 text-red-600" />
                        <h4 className="text-sm font-bold text-slate-900">
                          Real-Time Patient Vitals Telemetry
                        </h4>
                      </div>
                      <span className="text-xs text-slate-500">
                        Synchronized live with receiving ER
                      </span>
                    </div>

                    {vitalsError && (
                      <div className="p-3 bg-red-50 text-red-700 text-xs rounded-xl border border-red-200">
                        {vitalsError}
                      </div>
                    )}
                    {vitalsSuccess && (
                      <div className="p-3 bg-emerald-50 text-emerald-700 text-xs rounded-xl border border-emerald-200">
                        {vitalsSuccess}
                      </div>
                    )}

                    <form onSubmit={handleSubmitVitals} className="space-y-4">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">
                            Heart Rate (bpm)
                          </label>
                          <input
                            type="number"
                            required
                            placeholder="75"
                            value={vitalsForm.heartRate}
                            onChange={(e) =>
                              setVitalsForm({ ...vitalsForm, heartRate: e.target.value })
                            }
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">
                            BP Systolic
                          </label>
                          <input
                            type="number"
                            required
                            placeholder="120"
                            value={vitalsForm.bpSystolic}
                            onChange={(e) =>
                              setVitalsForm({ ...vitalsForm, bpSystolic: e.target.value })
                            }
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">
                            BP Diastolic
                          </label>
                          <input
                            type="number"
                            required
                            placeholder="80"
                            value={vitalsForm.bpDiastolic}
                            onChange={(e) =>
                              setVitalsForm({ ...vitalsForm, bpDiastolic: e.target.value })
                            }
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">
                            SpO2 (%)
                          </label>
                          <input
                            type="number"
                            required
                            placeholder="98"
                            value={vitalsForm.oxygenSat}
                            onChange={(e) =>
                              setVitalsForm({ ...vitalsForm, oxygenSat: e.target.value })
                            }
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-600 mb-1">
                            Resp Rate (/min)
                          </label>
                          <input
                            type="number"
                            required
                            placeholder="16"
                            value={vitalsForm.respRate}
                            onChange={(e) =>
                              setVitalsForm({ ...vitalsForm, respRate: e.target.value })
                            }
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <input
                          type="text"
                          placeholder="Clinical observations or medication notes..."
                          value={vitalsForm.notes}
                          onChange={(e) =>
                            setVitalsForm({ ...vitalsForm, notes: e.target.value })
                          }
                          className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button
                          type="submit"
                          disabled={vitalsSubmitting}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-xl transition-colors flex items-center space-x-1.5 shrink-0"
                        >
                          {vitalsSubmitting ? (
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Send className="w-3.5 h-3.5" />
                          )}
                          <span>Record Vitals</span>
                        </button>
                      </div>
                    </form>

                    {/* Vitals History Summary */}
                    {missionVitals.length > 0 && (
                      <div className="pt-3 border-t border-slate-100">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-2">
                          Recent Recorded Telemetry ({missionVitals.length})
                        </span>
                        <div className="space-y-1.5 max-h-36 overflow-y-auto">
                          {missionVitals.map((v) => (
                            <div
                              key={v.id}
                              className="flex items-center justify-between px-3 py-1.5 bg-slate-50 rounded-xl text-xs text-slate-700"
                            >
                              <div className="space-x-2 font-mono">
                                <span>HR: <strong>{v.heart_rate}</strong></span>
                                <span>BP: <strong>{v.blood_pressure_systolic}/{v.blood_pressure_diastolic}</strong></span>
                                <span>SpO2: <strong>{v.oxygen_saturation}%</strong></span>
                                <span>RR: <strong>{v.respiratory_rate}</strong></span>
                              </div>
                              <span className="text-[10px] text-slate-500 font-mono">
                                {formatIST(v.recorded_at, { timeOnly: true })}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* CALM AVAILABLE / IDLE STATE */
              <div className="space-y-6">
                <div className="bg-white rounded-3xl border border-slate-200/80 p-8 sm:p-10 shadow-2xs text-center flex flex-col items-center max-w-xl mx-auto space-y-4">
                  <div
                    className={`w-16 h-16 rounded-3xl flex items-center justify-center ${
                      isOnDuty
                        ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                        : "bg-slate-100 text-slate-400 border border-slate-200"
                    }`}
                  >
                    {isOnDuty ? (
                      <ShieldCheck className="w-8 h-8" />
                    ) : (
                      <Shield className="w-8 h-8" />
                    )}
                  </div>

                  <div>
                    <h2 className="text-xl font-extrabold text-slate-900">
                      {isOnDuty
                        ? "Unit On Duty • Ready for Emergency Calls"
                        : "Ambulance Unit is Off Duty"}
                    </h2>
                    <p className="text-xs text-slate-500 mt-1 max-w-sm">
                      {isOnDuty
                        ? `Stationed at ${
                            ambulance?.base_station || "Mangaluru Base Station"
                          }. Live GPS telemetry active and ready for dispatch.`
                        : "Unit is currently marked off-duty. Switch duty toggle to start receiving emergency missions."}
                    </p>
                  </div>

                  <div className="flex items-center space-x-3 pt-2">
                    <button
                      onClick={handleToggleDutyStatus}
                      className={`px-5 py-2.5 rounded-xl text-xs font-bold border transition-colors shadow-2xs ${
                        isOnDuty
                          ? "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300"
                          : "bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-600"
                      }`}
                    >
                      {isOnDuty ? "Go Off Duty" : "Go On Duty (Available)"}
                    </button>

                    <button
                      onClick={() => setCurrentTab("vehicle")}
                      className="px-5 py-2.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-xs font-bold transition-colors shadow-2xs"
                    >
                      Check Equipment
                    </button>
                  </div>
                </div>

                {/* Unit Snapshot Summary Card */}
                {ambulance && (
                  <div className="max-w-2xl mx-auto bg-white rounded-3xl border border-slate-200/80 p-6 shadow-2xs space-y-4">
                    <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                      <div className="flex items-center space-x-2.5">
                        <Ambulance className="w-5 h-5 text-blue-600" />
                        <span className="font-bold text-sm text-slate-900">
                          Unit {ambulance.call_sign} Specs
                        </span>
                      </div>
                      <span className="px-2.5 py-0.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 text-xs font-bold uppercase">
                        {ambulance.paramedic_level}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                      <div>
                        <span className="text-slate-400 block text-[10px] font-bold uppercase">
                          Base Station
                        </span>
                        <span className="font-semibold text-slate-800">
                          {ambulance.base_station}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px] font-bold uppercase">
                          Vehicle Type
                        </span>
                        <span className="font-semibold text-slate-800">
                          {ambulance.vehicle_type}
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px] font-bold uppercase">
                          Fuel Level
                        </span>
                        <span className="font-semibold text-slate-800">
                          {ambulance.fuel_level_percent}% Full
                        </span>
                      </div>
                      <div>
                        <span className="text-slate-400 block text-[10px] font-bold uppercase">
                          Current Status
                        </span>
                        <span
                          className={`font-extrabold uppercase ${
                            ambulance.status === "AVAILABLE"
                              ? "text-emerald-600"
                              : ambulance.status === "OFF_DUTY"
                              ? "text-slate-500"
                              : "text-amber-600"
                          }`}
                        >
                          {ambulance.status}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ========================================================= */}
        {/* TAB 2: MY MISSIONS (HISTORY & DETAILS)                     */}
        {/* ========================================================= */}
        {currentTab === "missions" && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-extrabold text-slate-900">
                  Mission History
                </h2>
                <p className="text-xs text-slate-500">
                  Authenticated operational missions assigned to this ambulance unit.
                </p>
              </div>

              <span className="px-3 py-1 rounded-xl bg-slate-100 text-slate-700 text-xs font-mono font-bold">
                {dispatches.length} Missions Recorded
              </span>
            </div>

            {dispatches.length === 0 ? (
              <div className="bg-white rounded-3xl border border-slate-200 p-10 text-center text-slate-500 text-xs">
                No past missions found for this ambulance unit.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {dispatches.map((m) => (
                  <div
                    key={m.id}
                    className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs hover:shadow-xs transition-shadow space-y-3"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="font-bold text-sm text-slate-900">
                            Mission #{m.id}
                          </span>
                          {m.coordination_status === "REASSIGNMENT_REQUIRED" || m.coordination_status === "EXPIRED" ? (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-amber-50 text-amber-700 border border-amber-200">
                              Reservation Expired
                            </span>
                          ) : m.coordination_status === "REJECTED" ? (
                            <span className="px-2 py-0.5 rounded-md text-[10px] font-bold uppercase bg-red-50 text-red-700 border border-red-200">
                              Declined
                            </span>
                          ) : (
                            <span
                              className={`px-2 py-0.5 rounded-md text-[10px] font-bold uppercase ${
                                m.status === "COMPLETED"
                                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                  : m.status === "CANCELLED"
                                  ? "bg-slate-100 text-slate-600 border border-slate-200"
                                  : m.status === "ASSIGNED" && m.coordination_status === "PENDING_CONFIRMATIONS"
                                  ? "bg-amber-50 text-amber-700 border border-amber-200"
                                  : "bg-blue-50 text-blue-700 border border-blue-200"
                              }`}
                            >
                              {m.status === "ASSIGNED" && m.coordination_status === "PENDING_CONFIRMATIONS"
                                ? "Pending Confirmation"
                                : m.status.replace(/_/g, " ")}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {m.incident?.chief_complaint || "Emergency Response"}
                          {m.attempt_number && m.attempt_number > 1 && (
                            <span className="ml-1.5 text-[10px] font-mono text-slate-500 font-semibold bg-slate-100 px-1 py-0.5 rounded">
                              Attempt #{m.attempt_number}
                            </span>
                          )}
                        </p>
                      </div>

                      <span className="text-[10px] text-slate-400 font-mono">
                        {m.coordination_status}
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs text-slate-600 bg-slate-50 rounded-2xl p-3 border border-slate-100">
                      <div className="flex items-start space-x-2">
                        <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                        <span className="line-clamp-1">
                          {m.incident_address ||
                            m.incident?.location_address ||
                            "Canara Engineering College Sector"}
                        </span>
                      </div>
                      <div className="flex items-start space-x-2">
                        <Building2 className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                        <span className="line-clamp-1">
                          {m.destination_hospital_name}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1 text-xs">
                      <span className="text-[11px] text-slate-400">
                        Distance: {formatDistance(m.route_distance_meters)}
                      </span>
                      <button
                        onClick={() => setSelectedMissionDetails(m)}
                        className="text-blue-600 hover:text-blue-700 font-semibold inline-flex items-center space-x-1"
                      >
                        <span>View Details</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ========================================================= */}
        {/* TAB 3: VEHICLE STATUS & EQUIPMENT                         */}
        {/* ========================================================= */}
        {currentTab === "vehicle" && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-extrabold text-slate-900">
                  Vehicle Status & Medical Inventory
                </h2>
                <p className="text-xs text-slate-500">
                  Unit operational readiness, fuel levels, GPS receiver telemetry and onboard equipment.
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setShowReportIssueModal(true)}
                  className="px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold transition-colors flex items-center space-x-1.5 shadow-2xs"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  <span>Report Vehicle Issue</span>
                </button>
              </div>
            </div>

            {/* Vehicle Overview Card */}
            {ambulance && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs space-y-2">
                  <div className="flex items-center space-x-2 text-slate-500 text-xs font-bold uppercase tracking-wider">
                    <Truck className="w-4 h-4 text-blue-600" />
                    <span>Unit Registration</span>
                  </div>
                  <h3 className="text-xl font-extrabold text-slate-900">
                    Unit {ambulance.call_sign}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Type: <strong className="text-slate-800">{ambulance.vehicle_type}</strong> • Base:{" "}
                    <strong className="text-slate-800">{ambulance.base_station}</strong>
                  </p>
                </div>

                <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs space-y-2">
                  <div className="flex items-center space-x-2 text-slate-500 text-xs font-bold uppercase tracking-wider">
                    <Fuel className="w-4 h-4 text-amber-600" />
                    <span>Fuel Level</span>
                  </div>
                  <div className="flex items-baseline space-x-2">
                    <span className="text-xl font-extrabold text-slate-900">
                      {ambulance.fuel_level_percent}%
                    </span>
                    <span className="text-xs text-slate-500">Operational</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        ambulance.fuel_level_percent > 40
                          ? "bg-emerald-500"
                          : "bg-amber-500"
                      }`}
                      style={{ width: `${ambulance.fuel_level_percent}%` }}
                    />
                  </div>
                </div>

                <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs space-y-2">
                  <div className="flex items-center space-x-2 text-slate-500 text-xs font-bold uppercase tracking-wider">
                    <Radio className="w-4 h-4 text-emerald-600" />
                    <span>GPS Telemetry</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-sm font-extrabold text-slate-800">
                      Connected (12 Sats)
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-slate-500">
                    {ambulance.current_latitude?.toFixed(6)}, {ambulance.current_longitude?.toFixed(6)}
                  </p>
                </div>
              </div>
            )}

            {/* Onboard Medical & Rescue Equipment Checklist */}
            <div className="bg-white rounded-3xl border border-slate-200/80 p-6 shadow-2xs space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center space-x-2">
                  <Stethoscope className="w-4 h-4 text-emerald-600" />
                  <h3 className="font-bold text-sm text-slate-900">
                    Onboard Medical & Emergency Equipment Inventory
                  </h3>
                </div>
                <span className="text-xs text-emerald-700 font-semibold bg-emerald-50 px-2.5 py-0.5 rounded-md border border-emerald-200">
                  Verified Ready
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {(
                  ambulance?.equipment || [
                    "Defibrillator / AED",
                    "Portable Ventilator",
                    "Suction Unit",
                    "Oxygen Cylinder & Regulator",
                    "Immobilization Spine Board",
                    "ALS Medication Bag",
                    "Trauma Bandage Pack",
                    "Pulse Oximeter",
                    "Bag Valve Mask (Adult & Peds)",
                  ]
                ).map((eq, idx) => (
                  <div
                    key={idx}
                    className="flex items-center space-x-2.5 p-3 rounded-2xl bg-slate-50 border border-slate-100 text-xs font-semibold text-slate-800"
                  >
                    <div className="w-5 h-5 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3" />
                    </div>
                    <span>{eq}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* TAB 4: HELP & SUPPORT                                     */}
        {/* ========================================================= */}
        {currentTab === "support" && (
          <div className="space-y-6 max-w-3xl mx-auto">
            <div>
              <h2 className="text-lg font-extrabold text-slate-900">
                Field Help & Operational Support
              </h2>
              <p className="text-xs text-slate-500">
                Direct hotline to Mangaluru Emergency Control Room, backup requests, and breakdown procedures.
              </p>
            </div>

            {/* Direct Dispatch Hotline Card */}
            <div className="bg-white rounded-3xl border border-slate-200/80 p-6 shadow-2xs space-y-4">
              <div className="flex items-center space-x-3">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
                  <PhoneCall className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-slate-900">
                    Emergency Dispatch Control Room
                  </h3>
                  <p className="text-xs text-slate-500">
                    24/7 Priority Emergency Channel for Ambulance Field Crews
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
                <div>
                  <span className="text-[10px] font-bold text-slate-400 uppercase block">
                    Direct Phone Line
                  </span>
                  <span className="text-base font-extrabold font-mono text-slate-800">
                    0824-2220555
                  </span>
                </div>

                <a
                  href="tel:08242220555"
                  className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-2xs flex items-center space-x-2 transition-colors"
                >
                  <Phone className="w-4 h-4" />
                  <span>Call Dispatch Now</span>
                </a>
              </div>
            </div>

            {/* Operational Support Actions */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Request Police / Fire Backup */}
              <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs space-y-3">
                <div className="flex items-center space-x-2 text-red-600">
                  <ShieldAlert className="w-5 h-5" />
                  <h4 className="text-sm font-bold text-slate-900">
                    Request Emergency Backup
                  </h4>
                </div>
                <p className="text-xs text-slate-500">
                  Request immediate police traffic escort, fire rescue extraction, or a secondary ambulance unit.
                </p>
                <button
                  type="button"
                  onClick={() => setShowAssistanceModal(true)}
                  className="w-full py-2.5 px-4 rounded-xl bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold border border-red-200 transition-colors"
                >
                  Request Backup
                </button>
              </div>

              {/* Report Vehicle Breakdown */}
              <div className="bg-white rounded-3xl border border-slate-200/80 p-5 shadow-2xs space-y-3">
                <div className="flex items-center space-x-2 text-slate-700">
                  <Wrench className="w-5 h-5" />
                  <h4 className="text-sm font-bold text-slate-900">
                    Report Vehicle Breakdown
                  </h4>
                </div>
                <p className="text-xs text-slate-500">
                  Log engine trouble, tire puncture, or equipment failure and flag unit for fleet maintenance.
                </p>
                <button
                  type="button"
                  onClick={() => setShowReportIssueModal(true)}
                  className="w-full py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold border border-slate-200 transition-colors"
                >
                  Report Problem
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ------------------------------------------------------------- */}
      {/* 5. MODALS & DRAWERS                                           */}
      {/* ------------------------------------------------------------- */}

      {/* MODAL: Confirm Patient Pickup */}
      {showPickupModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full border border-slate-200 p-6 space-y-4 shadow-xl">
            <div className="flex items-center space-x-3 text-blue-600">
              <div className="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center">
                <Stethoscope className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-extrabold text-base text-slate-900">
                  Confirm Patient Pickup
                </h3>
                <p className="text-xs text-slate-500">
                  Paramedic Safety Verification
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-600">
              Confirm that the patient has been safely transferred inside the ambulance and secured on the stretcher.
              This will advance the mission status to <strong>En Route to Hospital</strong> and notify the receiving ER trauma team.
            </p>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowPickupModal(false)}
                className="w-full py-2.5 px-4 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmPatientPickup}
                className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-extrabold shadow-md transition-colors"
              >
                Yes, Patient Onboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Request Assistance */}
      {showAssistanceModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full border border-slate-200 p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2.5 text-red-600">
                <ShieldAlert className="w-5 h-5" />
                <h3 className="font-extrabold text-base text-slate-900">
                  Request Emergency Backup
                </h3>
              </div>
              <button
                onClick={() => setShowAssistanceModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleRequestAssistance} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Type of Assistance Required
                </label>
                <select
                  value={assistanceType}
                  onChange={(e) => setAssistanceType(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-red-500"
                >
                  <option value="POLICE">Police Escort / Traffic Clearance</option>
                  <option value="FIRE">Fire & Rescue / Extrication</option>
                  <option value="BACKUP_AMBULANCE">Secondary Ambulance Unit (Mass Casualty)</option>
                  <option value="CONTROL_ROOM">Supervisor Direct Callback</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Operational Notes (Optional)
                </label>
                <textarea
                  rows={3}
                  placeholder="Heavy traffic jam on NH66, or patient pinned inside wreckage..."
                  value={assistanceNotes}
                  onChange={(e) => setAssistanceNotes(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAssistanceModal(false)}
                  className="w-full py-2.5 px-4 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="w-full py-2.5 px-4 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-extrabold shadow-md transition-colors"
                >
                  Broadcast Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Report Vehicle Issue */}
      {showReportIssueModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full border border-slate-200 p-6 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2.5 text-slate-800">
                <Wrench className="w-5 h-5 text-amber-600" />
                <h3 className="font-extrabold text-base text-slate-900">
                  Report Vehicle / Equipment Problem
                </h3>
              </div>
              <button
                onClick={() => setShowReportIssueModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleReportIssue} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Issue Category
                </label>
                <select
                  value={issueType}
                  onChange={(e) => setIssueType(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                >
                  <option value="MECHANICAL">Mechanical / Engine Trouble</option>
                  <option value="MEDICAL_EQUIPMENT">Medical Equipment Failure</option>
                  <option value="FUEL">Low Fuel / Fluid Leak</option>
                  <option value="COMMUNICATIONS">Radio / GPS Telemetry Loss</option>
                  <option value="OTHER">Other Operational Defect</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1.5">
                  Description of Issue
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="Describe vehicle or equipment condition..."
                  value={issueNotes}
                  onChange={(e) => setIssueNotes(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="markMaint"
                  checked={issueMarkMaintenance}
                  onChange={(e) => setIssueMarkMaintenance(e.target.checked)}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                />
                <label
                  htmlFor="markMaint"
                  className="text-xs font-semibold text-slate-700"
                >
                  Mark unit as unavailable for MAINTENANCE
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowReportIssueModal(false)}
                  className="w-full py-2.5 px-4 rounded-xl border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-bold transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-extrabold shadow-md transition-colors"
                >
                  Submit Report
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Mission Details Drawer / Viewer */}
      {selectedMissionDetails && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-lg w-full border border-slate-200 p-6 space-y-4 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div>
                <h3 className="font-extrabold text-base text-slate-900">
                  Mission Summary #{selectedMissionDetails.id}
                </h3>
                <span className="text-xs text-slate-500">
                  Status: {selectedMissionDetails.status.replace(/_/g, " ")}
                </span>
              </div>
              <button
                onClick={() => setSelectedMissionDetails(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="bg-slate-50 p-3 rounded-2xl space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-400">
                  Chief Complaint
                </span>
                <p className="font-bold text-slate-800">
                  {selectedMissionDetails.incident?.chief_complaint || "Emergency Response"}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 p-3 rounded-2xl space-y-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400">
                    Scene Location
                  </span>
                  <p className="font-semibold text-slate-800">
                    {selectedMissionDetails.incident_address || "Canara Engineering College Sector"}
                  </p>
                </div>

                <div className="bg-slate-50 p-3 rounded-2xl space-y-1">
                  <span className="text-[10px] uppercase font-bold text-slate-400">
                    Destination Hospital
                  </span>
                  <p className="font-semibold text-slate-800">
                    {selectedMissionDetails.destination_hospital_name}
                  </p>
                </div>
              </div>

              <div className="bg-slate-50 p-3 rounded-2xl space-y-1">
                <span className="text-[10px] uppercase font-bold text-slate-400">
                  Total Route Distance
                </span>
                <p className="font-bold text-slate-800 font-mono">
                  {formatDistance(selectedMissionDetails.route_distance_meters)}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSelectedMissionDetails(null)}
              className="w-full py-2.5 px-4 rounded-xl bg-slate-900 text-white text-xs font-bold transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
