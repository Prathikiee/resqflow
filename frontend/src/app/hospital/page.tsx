"use client";

import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  Ambulance,
  Bed,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Droplet,
  ExternalLink,
  Eye,
  FileText,
  Filter,
  Flame,
  Heart,
  HeartPulse,
  History,
  LayoutDashboard,
  LogOut,
  MapPin,
  Minus,
  Phone,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  Syringe,
  Thermometer,
  Trash2,
  User,
  UserCheck,
  UserPlus,
  Users,
  Wind,
  X,
} from "lucide-react";
import Sidebar, { NavItem } from "@/components/layout/Sidebar";
import TopNav from "@/components/layout/TopNav";
import { formatDistance, formatDuration } from "@/lib/utils";

// =============================================================================
// TYPES & INTERFACES
// =============================================================================
interface Doctor {
  id: string;
  name: string;
  specialty: string;
  department: string;
  designation?: string;
  shift: string;
  shift_type?: "MORNING" | "EVENING" | "NIGHT" | "CUSTOM" | "ON_CALL" | string;
  shift_start?: string;
  shift_end?: string;
  working_days?: string[];
  status: "AVAILABLE" | "BUSY" | "OFF_DUTY" | "UNAVAILABLE" | "ON_LEAVE" | string;
  effective_status?: string;
  is_on_duty?: boolean;
  is_available?: boolean;
  duty_reason?: string;
  emergency_coverage?: boolean;
  contact_number?: string;
  is_active?: boolean;
  last_updated?: string;
}

interface Department {
  id: string;
  name: string;
  operational_status: "ACTIVE" | "LIMITED" | "TEMPORARILY_CLOSED" | string;
  operating_hours: string;
  emergency_coverage: boolean;
  specialty_availability: string[];
  notes?: string;
}

interface BedCategoryData {
  name: string;
  total: number;
  occupied: number;
  reserved: number;
  unavailable: number;
  available: number;
}

interface CrashAlertRecord {
  id: number;
  ambulance_id: number;
  ambulance_call_sign?: string;
  incident_id?: number;
  hospital_id: number;
  hospital_name?: string;
  dispatch_id?: number;
  source: string;
  severity: "MINOR" | "MODERATE" | "SEVERE" | "CRITICAL" | string;
  latitude: number;
  longitude: number;
  location_description?: string;
  sensor_data: Record<string, any>;
  status: "TRIGGERED" | "ACKNOWLEDGED" | "TEAM_NOTIFIED" | "BACKUP_REQUESTED" | "RESOLVED" | string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  response_notes?: string;
  created_at: string;
}

interface CollisionAlertRecord {
  id: number;
  caller_name: string;
  caller_phone?: string;
  location_address: string;
  latitude: number;
  longitude: number;
  chief_complaint: string;
  triage_level: string;
  triage_color: string;
  status: string;
  is_collision_alert?: boolean;
  incident_source?: string;
  created_at: string;
  updated_at: string;
}

interface VitalsRecord {
  id: number;
  dispatch_id: number;
  incident_id: number;
  recorded_by_user_id?: number;
  heart_rate: number;
  blood_pressure_systolic: number;
  blood_pressure_diastolic: number;
  oxygen_saturation: number;
  respiratory_rate: number;
  notes?: string | null;
  blood_pressure_display?: string;
  recorded_at: string;
  created_at?: string;
}

interface DispatchRecord {
  id: number;
  incident_id: number;
  ambulance_id: number;
  ambulance_call_sign?: string;
  destination_hospital_name?: string;
  destination_hospital_id: number;
  coordination_status: string;
  ambulance_confirmation_status: string;
  hospital_confirmation_status: string;
  status: string;
  attempt_number: number;
  reservation_expires_at?: string;
  estimated_eta_seconds?: number;
  route_distance_meters?: number;
  hospital_preparation_status?: string;
  hospital_preparation_notes?: string;
  hospital_acknowledged_at?: string;
  patient_arrived_hospital_confirmed_at?: string;
  created_at?: string;
  incident?: {
    id: number;
    caller_name: string;
    caller_phone: string;
    location_address: string;
    chief_complaint: string;
    triage_level: string;
    triage_color: string;
    triage_score?: number;
    triage_justifications?: string[];
    status: string;
    patient_age?: number;
    patient_gender?: string;
    consciousness_level?: string;
    breathing_status?: string;
    severe_bleeding?: boolean;
    chest_pain?: boolean;
    suspected_stroke?: boolean;
    severe_trauma?: boolean;
    required_ambulance_type?: string;
  };
  handover_packet?: any;
  vitals?: VitalsRecord[];
  latest_vitals?: VitalsRecord;
}

export default function HospitalPortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [hospital, setHospital] = useState<any>(null);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [crashAlerts, setCrashAlerts] = useState<CrashAlertRecord[]>([]);
  const [collisionAlerts, setCollisionAlerts] = useState<CollisionAlertRecord[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [currentNav, setCurrentNav] = useState<string>("overview");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

  // Reservation countdown timer
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // Modals & Selected items state
  const [selectedIncidentModal, setSelectedIncidentModal] = useState<DispatchRecord | null>(null);
  const [activeHandoverModal, setActiveHandoverModal] = useState<any | null>(null);
  const [showModalVitalsHistory, setShowModalVitalsHistory] = useState(false);
  const [handoverClinicianName, setHandoverClinicianName] = useState("");
  const [handoverNotesInput, setHandoverNotesInput] = useState("");
  const [rejectModalDispatch, setRejectModalDispatch] = useState<DispatchRecord | null>(null);
  const [rejectionReason, setRejectionReason] = useState("Trauma Bay Overcapacity / Divert Active");

  // Doctor Management modal state
  const [isAddDoctorModalOpen, setIsAddDoctorModalOpen] = useState(false);
  const [editingDoctor, setEditingDoctor] = useState<Doctor | null>(null);
  const [doctorForm, setDoctorForm] = useState({
    name: "",
    specialty: "Emergency Medicine",
    department: "Emergency Medicine",
    designation: "Consultant Emergency Physician",
    shift_type: "MORNING",
    shift_start: "08:00",
    shift_end: "16:00",
    working_days: ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
    status: "AVAILABLE",
    emergency_coverage: true,
    contact_number: "Ext. 101",
  });
  const [doctorSearch, setDoctorSearch] = useState("");
  const [doctorDeptFilter, setDoctorDeptFilter] = useState("ALL");
  const [doctorStatusFilter, setDoctorStatusFilter] = useState("ALL");

  // Bed Capacity Form state
  const [bedCapacityForm, setBedCapacityForm] = useState<{ [category: string]: BedCategoryData }>({});
  const [bedFormError, setBedFormError] = useState<string | null>(null);

  // Departments & Capabilities Form state
  const [capabilitiesTab, setCapabilitiesTab] = useState<"DEPARTMENTS" | "CAPABILITIES">("DEPARTMENTS");
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);
  const [capabilitiesState, setCapabilitiesState] = useState<{ [key: string]: string }>({});

  // Incoming Patients Filter
  const [patientsFilter, setPatientsFilter] = useState<"ALL" | "PRIORITY_1" | "INCOMING" | "ARRIVING_SOON" | "HANDOVER_PENDING">("ALL");

  // Handover & History Tabs & Filters
  const [historyTab, setHistoryTab] = useState<"HANDOVERS" | "HISTORY">("HANDOVERS");
  const [historySearch, setHistorySearch] = useState("");

  // Facility Settings / Profile state
  const [profileForm, setProfileForm] = useState({
    name: "",
    address: "",
    latitude: 12.875,
    longitude: 74.845,
    contact_number: "",
    facility_type: "Tertiary Multi-Specialty Hospital",
    emergency_department_hours: "24/7 Rapid Response",
    emergency_contact_person: "",
    readiness_status: "READY",
    accepting_emergencies: true,
  });

  // Crash Alert Response note
  const [crashNoteInput, setCrashNoteInput] = useState<{ [alertId: number]: string }>({});
  // Prep status note
  const [prepNoteInput, setPrepNoteInput] = useState<{ [dispatchId: number]: string }>({});

  const isActionInProgressRef = useRef(false);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // =============================================================================
  // DATA FETCHING & SYNCHRONIZATION
  // =============================================================================
  const fetchHospitalData = useCallback(async () => {
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
      if (!handoverClinicianName) setHandoverClinicianName(userData.full_name || "ER Triage Officer");

      if (userData.hospital_id) {
        // 1. Fetch Hospital Record
        const hospResp = await fetch(`${backendUrl}/api/hospitals/${userData.hospital_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (hospResp.ok) {
          const hData = await hospResp.json();
          setHospital(hData);
          setCapabilitiesState(hData.capabilities || {});
          setBedCapacityForm(hData.bed_capacity_breakdown || {});
          setProfileForm({
            name: hData.name || "",
            address: hData.address || "",
            latitude: hData.latitude || 12.875,
            longitude: hData.longitude || 74.845,
            contact_number: hData.contact_number || "",
            facility_type: hData.facility_type || "Tertiary Multi-Specialty Hospital",
            emergency_department_hours: hData.emergency_department_hours || "24/7 Rapid Response",
            emergency_contact_person: hData.emergency_contact_person || "",
            readiness_status: hData.readiness_status || "READY",
            accepting_emergencies: hData.accepting_emergencies ?? true,
          });
        }

        // 2. Fetch Hospital Doctors with live shift evaluation
        const docResp = await fetch(`${backendUrl}/api/hospitals/${userData.hospital_id}/doctors`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (docResp.ok) {
          setDoctors(await docResp.json());
        }

        // 3. Fetch Allocated Incidents
        const dispResp = await fetch(`${backendUrl}/api/hospitals/${userData.hospital_id}/allocated-incidents`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (dispResp.ok) {
          setDispatches(await dispResp.json());
        }

        // 4. Fetch Crash Alerts
        const crashResp = await fetch(`${backendUrl}/api/crash-alerts`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (crashResp.ok) {
          setCrashAlerts(await crashResp.json());
        }

        // 5. Fetch Dedicated Ambulance Collision Alerts (ESP32 Simulator)
        try {
          const colResp = await fetch(`${backendUrl}/api/incidents/collision-alerts`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (colResp.ok) {
            setCollisionAlerts(await colResp.json());
          }
        } catch (colErr) {
          console.warn("Collision alerts fetch error:", colErr);
        }
      }
    } catch (err: any) {
      console.warn("Hospital data fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router, handoverClinicianName]);

  // WebSocket Subscription
  useEffect(() => {
    fetchHospitalData();

    const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
    if (!token) return;

    const wsUrl = backendUrl.replace(/^http/, "ws") + `/ws/live?token=${encodeURIComponent(token)}`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data);
          const type = envelope.event || envelope.event_type || envelope.type;
          const relevantTypes = [
            "DISPATCH_CONFIRMATION_UPDATED",
            "DISPATCH_CREATED",
            "DISPATCH_REASSIGNED",
            "DISPATCH_ESCALATED",
            "HOSPITAL_CAPACITY_UPDATED",
            "HOSPITAL_DOCTOR_UPDATED",
            "HOSPITAL_DEPARTMENTS_UPDATED",
            "HOSPITAL_CAPABILITIES_UPDATED",
            "HOSPITAL_PROFILE_UPDATED",
            "PREPARATION_UPDATED",
            "PATIENT_ARRIVED_AT_HOSPITAL",
            "PATIENT_ARRIVED_HOSPITAL",
            "HANDOVER_ACKNOWLEDGED",
            "HANDOVER_REVIEWED",
            "HANDOVER_COMPLETED",
            "PATIENT_VITALS_RECORDED",
            "AMBULANCE_CRASH_DETECTED",
            "AMBULANCE_COLLISION_ALERT",
            "INCIDENT_CREATED",
          ];
          if (relevantTypes.includes(type)) {
            fetchHospitalData();
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        setWsConnected(false);
      };
    };

    connect();

    const pollInterval = setInterval(fetchHospitalData, 5000);

    return () => {
      clearInterval(pollInterval);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [backendUrl, fetchHospitalData]);

  // =============================================================================
  // DERIVED METRICS & FILTERED DISPATCHES
  // =============================================================================
  const pendingRequests = useMemo(() => {
    return dispatches.filter(
      (d) => d.coordination_status === "PENDING_CONFIRMATIONS" && d.hospital_confirmation_status === "PENDING"
    );
  }, [dispatches]);

  const activeInboundPatients = useMemo(() => {
    return dispatches.filter(
      (d) => d.coordination_status === "CONFIRMED" && d.status !== "COMPLETED" && d.status !== "CANCELLED"
    );
  }, [dispatches]);

  const filteredInboundPatients = useMemo(() => {
    return activeInboundPatients.filter((disp) => {
      if (patientsFilter === "PRIORITY_1") {
        return disp.incident?.triage_color === "RED" || disp.incident?.triage_level === "Priority 1";
      }
      if (patientsFilter === "ARRIVING_SOON") {
        return (disp.estimated_eta_seconds ?? 9999) <= 300 || disp.status === "EN_ROUTE_HOSPITAL";
      }
      return true;
    });
  }, [activeInboundPatients, patientsFilter]);

  const completedIncidents = useMemo(() => {
    return dispatches.filter((d) => d.status === "COMPLETED");
  }, [dispatches]);

  const activeCrashAlerts = useMemo(() => {
    return crashAlerts.filter((c) => c.status !== "RESOLVED");
  }, [crashAlerts]);

  // Active pending request countdown
  const primaryPendingRequest = pendingRequests[0];
  useEffect(() => {
    if (!primaryPendingRequest?.reservation_expires_at) {
      setRemainingSeconds(null);
      return;
    }

    const updateTimer = () => {
      const expMs = new Date(primaryPendingRequest.reservation_expires_at!).getTime();
      const nowMs = Date.now();
      const diffSec = Math.max(0, Math.floor((expMs - nowMs) / 1000));
      setRemainingSeconds(diffSec);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [primaryPendingRequest]);

  // Doctors On Duty calculation
  const onDutyDoctors = useMemo(() => {
    return doctors.filter((d) => d.is_on_duty);
  }, [doctors]);

  const availableDoctors = useMemo(() => {
    return doctors.filter((d) => d.is_available);
  }, [doctors]);

  // Bed Metrics
  const erBeds = hospital?.bed_capacity_breakdown?.emergency || {
    total: hospital?.total_emergency_beds ?? 20,
    available: hospital?.available_emergency_beds ?? 10,
    occupied: (hospital?.total_emergency_beds ?? 20) - (hospital?.available_emergency_beds ?? 10),
    reserved: hospital?.reserved_emergency_beds ?? 0,
    unavailable: 0,
  };

  const icuBeds = hospital?.bed_capacity_breakdown?.icu || {
    total: hospital?.total_icu_beds ?? 10,
    available: hospital?.available_icu_beds ?? 5,
    occupied: (hospital?.total_icu_beds ?? 10) - (hospital?.available_icu_beds ?? 5),
    reserved: 0,
    unavailable: 0,
  };

  // =============================================================================
  // ACTIONS & HANDLERS
  // =============================================================================

  // 1. Dual confirmation decision (Accept / Reject)
  const handleDecideReservation = async (dispatchId: number, decision: "ACCEPTED" | "REJECTED", reason?: string) => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm/hospital`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision,
          reason: decision === "REJECTED" ? reason || rejectionReason : undefined,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `Failed to record decision (${resp.status})`);
      }

      setFeedbackMsg({
        text: `Emergency reservation #${dispatchId} successfully ${decision.toLowerCase()}!`,
        type: decision === "ACCEPTED" ? "success" : "info",
      });
      setRejectModalDispatch(null);
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Reservation error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  // 2. Preparation status update
  const handleUpdatePreparation = async (dispatchId: number, prepStatus: string) => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");
    const notes = prepNoteInput[dispatchId] || "";

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/preparation`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          preparation_status: prepStatus,
          preparation_notes: notes.trim() || undefined,
          acknowledged_by: user?.full_name || handoverClinicianName,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to update hospital preparation");
      }

      setFeedbackMsg({
        text: `Trauma preparation advanced to '${prepStatus}'! Synchronized across network.`,
        type: "success",
      });
      setPrepNoteInput((prev) => ({ ...prev, [dispatchId]: "" }));
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Preparation update error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  // 3. Confirm Patient Arrival at ER Bay
  const handleConfirmArrival = async (dispatchId: number) => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm-arrival`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to confirm patient arrival");
      }

      setFeedbackMsg({
        text: `Patient arrival confirmed! Received into Emergency Trauma Bay.`,
        type: "success",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Arrival confirmation error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  // 4. SBAR Handover Lifecycle Handlers (Review, Acknowledge, Complete)
  const handleOpenHandover = async (dispatchId: number) => {
    setShowModalVitalsHistory(false);
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/handover`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const packet = await resp.json();
        setActiveHandoverModal(packet);
        setHandoverNotesInput(packet.receiving_notes || "");
      } else {
        const disp = dispatches.find((d) => d.id === dispatchId);
        setActiveHandoverModal({
          dispatch_id: dispatchId,
          incident_id: disp?.incident_id,
          status: "NOT_RECEIVED",
          ambulance_call_sign: disp?.ambulance_call_sign || "Unit",
          chief_complaint: disp?.incident?.chief_complaint || "Emergency medical condition",
          triage_priority: disp?.incident?.triage_level || "Priority 1",
          triage_color: disp?.incident?.triage_color || "RED",
          patient_age: disp?.incident?.patient_age,
          patient_gender: disp?.incident?.patient_gender,
          incident_address: disp?.incident?.location_address,
          latest_vitals: disp?.latest_vitals,
          vitals: disp?.vitals || [],
          mission_status: disp?.status,
          incident_status: disp?.incident?.status,
        });
      }
    } catch (_) {}
  };

  const handleReviewHandover = async (dispatchId: number) => {
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/handover/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reviewed_by: handoverClinicianName,
          receiving_notes: handoverNotesInput.trim() || undefined,
        }),
      });
      if (!resp.ok) throw new Error("Failed to review handover");
      const updated = await resp.json();
      setActiveHandoverModal(updated);
      setFeedbackMsg({ text: "SBAR handover marked as reviewed by clinician.", type: "success" });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: err.message, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleAcknowledgeHandover = async (dispatchId: number) => {
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/handover/acknowledge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          acknowledged_by: handoverClinicianName,
          receiving_clinician: handoverClinicianName,
          receiving_notes: handoverNotesInput.trim() || undefined,
        }),
      });
      if (!resp.ok) throw new Error("Failed to acknowledge handover");
      const updated = await resp.json();
      setActiveHandoverModal(updated);
      setFeedbackMsg({ text: `Handover formally acknowledged by ${handoverClinicianName}!`, type: "success" });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: err.message, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleCompleteHandover = async (dispatchId: number) => {
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/handover/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          completed_by: handoverClinicianName,
          receiving_notes: handoverNotesInput.trim() || undefined,
        }),
      });
      if (!resp.ok) throw new Error("Failed to complete handover");
      const updated = await resp.json();
      setActiveHandoverModal(updated);
      setFeedbackMsg({ text: "Clinical receiving workflow completed and signed off.", type: "success" });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: err.message, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  // 5. Doctor Management (Add, Edit, Status Toggle, Deactivate)
  const handleSaveDoctor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hospital?.id) return;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      let shiftText = `${doctorForm.shift_type} (${doctorForm.shift_start} - ${doctorForm.shift_end})`;
      if (doctorForm.shift_type === "ON_CALL") shiftText = "On-Call (24h Rapid Response)";

      const payload = {
        name: doctorForm.name,
        specialty: doctorForm.specialty,
        department: doctorForm.department,
        designation: doctorForm.designation,
        shift: shiftText,
        shift_type: doctorForm.shift_type,
        shift_start: doctorForm.shift_start,
        shift_end: doctorForm.shift_end,
        working_days: doctorForm.working_days,
        status: doctorForm.status,
        emergency_coverage: doctorForm.emergency_coverage,
        contact_number: doctorForm.contact_number,
      };

      let resp;
      if (editingDoctor) {
        resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/doctors/${editingDoctor.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
      } else {
        resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/doctors`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });
      }

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to save doctor");
      }

      setFeedbackMsg({
        text: `Doctor ${editingDoctor ? "updated" : "added"} to clinical roster successfully!`,
        type: "success",
      });
      setIsAddDoctorModalOpen(false);
      setEditingDoctor(null);
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Doctor save error: ${err.message}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateDoctorStatus = async (doctorId: string, newStatus: string) => {
    if (!hospital?.id) return;
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/doctors/${doctorId}/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: newStatus }),
      });
      if (resp.ok) {
        setFeedbackMsg({ text: `Doctor status updated to ${newStatus}.`, type: "success" });
        await fetchHospitalData();
      }
    } catch (_) {}
  };

  const handleDeleteDoctor = async (doctorId: string, doctorName: string) => {
    if (!hospital?.id) return;
    if (!confirm(`Are you sure you want to remove Dr. ${doctorName} from the roster?`)) return;
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/doctors/${doctorId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        setFeedbackMsg({ text: `Dr. ${doctorName} removed from roster.`, type: "info" });
        await fetchHospitalData();
      }
    } catch (_) {}
  };

  // 6. Bed Capacity Save
  const handleSaveBedCapacity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hospital?.id) return;
    setBedFormError(null);

    // Validate each category: occupied + reserved + unavailable <= total
    for (const [cat, data] of Object.entries(bedCapacityForm)) {
      const tot = Number(data.total) || 0;
      const occ = Number(data.occupied) || 0;
      const res = Number(data.reserved) || 0;
      const unavail = Number(data.unavailable) || 0;

      if (tot < 0 || occ < 0 || res < 0 || unavail < 0) {
        setBedFormError(`Counts for ${data.name || cat} cannot be negative.`);
        return;
      }
      if (occ + res + unavail > tot) {
        setBedFormError(
          `For ${data.name || cat}: Occupied (${occ}) + Reserved (${res}) + Unavailable (${unavail}) exceeds Total (${tot}).`
        );
        return;
      }
    }

    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/bed-capacity`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bedCapacityForm),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to update bed capacity");
      }

      setFeedbackMsg({
        text: "Multi-tier bed capacity successfully synchronized across regional emergency grid!",
        type: "success",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setBedFormError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // 7. Departments & Capabilities
  const handleUpdateDepartment = async (deptId: string, updates: any) => {
    if (!hospital?.id) return;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/departments/${deptId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(updates),
      });
      if (resp.ok) {
        setFeedbackMsg({ text: "Department status updated.", type: "success" });
        setEditingDepartment(null);
        await fetchHospitalData();
      }
    } catch (_) {
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateCapability = async (capabilityKey: string, newValue: string) => {
    if (!hospital?.id) return;
    const token = localStorage.getItem("lifelink_token");
    try {
      const updatedCaps = { ...capabilitiesState, [capabilityKey]: newValue };
      setCapabilitiesState(updatedCaps);

      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/capabilities`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ [capabilityKey]: newValue }),
      });
      if (resp.ok) {
        setFeedbackMsg({ text: `Capability '${capabilityKey.replace("_", " ")}' updated to ${newValue}.`, type: "success" });
        await fetchHospitalData();
      }
    } catch (_) {}
  };

  // 8. Hospital Settings / Profile Save
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hospital?.id) return;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: profileForm.name,
          address: profileForm.address,
          latitude: Number(profileForm.latitude),
          longitude: Number(profileForm.longitude),
          contact_number: profileForm.contact_number,
          facility_type: profileForm.facility_type,
          emergency_department_hours: profileForm.emergency_department_hours,
          emergency_contact_person: profileForm.emergency_contact_person,
          readiness_status: profileForm.readiness_status,
          accepting_emergencies: profileForm.accepting_emergencies,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to update hospital profile");
      }

      setFeedbackMsg({ text: "Hospital facility profile and settings saved successfully!", type: "success" });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Profile save error: ${err.message}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  // 9. Crash Alert Handlers (Simulation & Response)
  const handleSimulateCrash = async () => {
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/crash-alerts/simulate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          severity: "CRITICAL",
          location_description: `MG Road / Bunts Hostel Intersection near ${hospital?.name || "Hospital"}`,
        }),
      });
      if (resp.ok) {
        const alert = await resp.json();
        setFeedbackMsg({
          text: `CRASH ALERT SIMULATED: Unit ${alert.ambulance_call_sign || `#${alert.ambulance_id}`} reported critical impact!`,
          type: "error",
        });
        await fetchHospitalData();
      }
    } catch (_) {
    } finally {
      setActionLoading(false);
    }
  };

  const handleRespondCrashAlert = async (alertId: number, status: string) => {
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");
    const notes = crashNoteInput[alertId] || "";

    try {
      const resp = await fetch(`${backendUrl}/api/crash-alerts/${alertId}/respond`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          status,
          response_notes: notes.trim() || undefined,
          acknowledged_by: user?.full_name || handoverClinicianName,
        }),
      });
      if (resp.ok) {
        setFeedbackMsg({ text: `Crash Alert #${alertId} updated to '${status}'.`, type: "success" });
        setCrashNoteInput((prev) => ({ ...prev, [alertId]: "" }));
        await fetchHospitalData();
      }
    } catch (_) {
    } finally {
      setActionLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("lifelink_token");
    localStorage.removeItem("lifelink_user");
    router.push("/login");
  };

  // =============================================================================
  // SIDEBAR NAVIGATION ITEMS (The 8 Required Sections)
  // =============================================================================
  const sidebarNavItems: NavItem[] = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    {
      id: "requests",
      label: "Incoming Requests",
      icon: Radio,
      count: pendingRequests.length > 0 ? pendingRequests.length : undefined,
    },
    {
      id: "patients",
      label: "Incoming Patients",
      icon: Ambulance,
      count: activeInboundPatients.length > 0 ? activeInboundPatients.length : undefined,
    },
    {
      id: "doctors",
      label: "Doctors & Shifts",
      icon: Stethoscope,
      count: onDutyDoctors.length > 0 ? onDutyDoctors.length : undefined,
    },
    { id: "beds", label: "Bed Capacity", icon: Bed },
    { id: "capabilities", label: "Departments & Capabilities", icon: Building2 },
    { id: "handover_history", label: "Handover & History", icon: History },
    { id: "settings", label: "Hospital Settings", icon: Shield },
  ];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4 font-sans">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-600" />
          <span className="text-xs font-bold text-slate-700">Connecting to Hospital Operations Console...</span>
        </div>
      </div>
    );
  }

  const currentReadiness = hospital?.readiness_status || "READY";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex font-sans">
      {/* 1. PERSISTENT LEFT SIDEBAR */}
      <Sidebar
        role="HOSPITAL"
        roleLabel="Hospital Staff"
        user={user}
        currentNav={currentNav}
        onNavChange={(id) => {
          setCurrentNav(id);
          setIsMobileMenuOpen(false);
        }}
        navItems={sidebarNavItems}
        isOpenMobile={isMobileMenuOpen}
        onCloseMobile={() => setIsMobileMenuOpen(false)}
        onLogout={handleLogout}
        entityName={hospital?.name || "Mangaluru Medical Center"}
      />

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0">
        {/* Top Minimal Navigation Bar */}
        <TopNav
          title={hospital?.name || "Emergency Operations Portal"}
          subtitle={`Facility Code: ${hospital?.facility_code || "KMC-AMB-01"} • ${hospital?.address || "Mangaluru"}`}
          wsConnected={wsConnected}
          onMenuToggle={() => setIsMobileMenuOpen(true)}
          actions={
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-slate-500 hidden sm:inline">Readiness:</span>
              <span
                className={`text-xs font-bold px-2.5 py-0.5 rounded-full uppercase border ${
                  currentReadiness === "READY"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                    : currentReadiness === "BUSY"
                    ? "bg-amber-50 text-amber-700 border-amber-300"
                    : "bg-red-50 text-red-700 border-red-300"
                }`}
              >
                {currentReadiness}
              </span>
              <button
                onClick={fetchHospitalData}
                disabled={isLoading}
                className="p-1.5 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors"
                title="Refresh Hospital Data"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
              </button>
            </div>
          }
        />

        {/* Global Feedback Banner */}
        {feedbackMsg && (
          <div
            className={`mx-4 sm:mx-6 mt-4 p-3 rounded-lg border text-xs font-medium flex items-center justify-between transition-all ${
              feedbackMsg.type === "success"
                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                : feedbackMsg.type === "error"
                ? "bg-red-50 text-red-800 border-red-200"
                : "bg-blue-50 text-blue-800 border-blue-200"
            }`}
          >
            <span>{feedbackMsg.text}</span>
            <button onClick={() => setFeedbackMsg(null)} className="text-slate-400 hover:text-slate-700 ml-2">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* CRITICAL OPERATIONAL ALERT: Active Crash Alerts Banner */}
        {activeCrashAlerts.length > 0 && (
          <div className="mx-4 sm:mx-6 mt-4 p-4 rounded-xl border-2 border-red-500 bg-red-50 shadow-sm animate-pulse">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
                <div>
                  <h4 className="text-sm font-bold text-red-900">
                    CRITICAL COLLISION TELEMETRY: {activeCrashAlerts.length} Ambulance Crash Alert(s) Detected!
                  </h4>
                  <p className="text-xs text-red-700 mt-0.5">
                    Impact sensors triggered on unit(s) transporting to this facility. Immediate emergency response protocol required.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setCurrentNav("overview")}
                className="text-xs font-bold px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                View Telemetry
              </button>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* MAIN BODY ROUTED BY CURRENTNAV                                            */}
        {/* ========================================================================= */}
        <main className="p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">

          {/* SECTION 1: OVERVIEW */}
          {currentNav === "overview" && (
            <div className="space-y-6">
              {/* Top Operational Metrics */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-xs font-semibold uppercase tracking-wider">Incoming Patients</span>
                    <Ambulance className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900">{activeInboundPatients.length}</div>
                  <div className="text-[11px] text-slate-500 mt-1">Confirmed en route to ER</div>
                </div>

                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-xs font-semibold uppercase tracking-wider">Pending Requests</span>
                    <Radio className="w-4 h-4 text-amber-500" />
                  </div>
                  <div className="text-2xl font-bold text-amber-600">{pendingRequests.length}</div>
                  <div className="text-[11px] text-slate-500 mt-1">90s confirmation TTL</div>
                </div>

                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-xs font-semibold uppercase tracking-wider">Available Bays</span>
                    <Bed className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900">
                    {erBeds.available} <span className="text-xs text-slate-400 font-normal">/ {erBeds.total} ER</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1">{icuBeds.available} ICU beds vacant</div>
                </div>

                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-slate-500 mb-1">
                    <span className="text-xs font-semibold uppercase tracking-wider">Doctors On Duty</span>
                    <Stethoscope className="w-4 h-4 text-purple-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-900">
                    {onDutyDoctors.length} <span className="text-xs text-slate-400 font-normal">/ {doctors.length}</span>
                  </div>
                  <div className="text-[11px] text-emerald-600 font-medium mt-1">
                    {availableDoctors.length} currently available
                  </div>
                </div>
              </div>

              {/* Dedicated AMBULANCE COLLISION ALERTS Section */}
              <div className="bg-white rounded-xl border border-red-200 shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-red-100 pb-2">
                  <div className="flex items-center gap-2 text-red-700 font-bold text-sm">
                    <ShieldAlert className="w-4 h-4 text-red-600 animate-pulse" />
                    <span>AMBULANCE COLLISION ALERTS</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-100 text-amber-900 border border-amber-300 rounded-full tracking-wide">
                      SIMULATED
                    </span>
                    <span className="text-xs font-semibold px-2 py-0.5 bg-red-100 text-red-800 rounded-full">
                      {collisionAlerts.length} Event{collisionAlerts.length === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>

                {collisionAlerts.length === 0 ? (
                  <div className="p-4 bg-slate-50 border border-dashed border-slate-200 rounded-lg text-center text-slate-500 text-xs">
                    <Radio className="w-4 h-4 text-slate-400 mx-auto mb-1 animate-pulse" />
                    No active ambulance collision alerts detected. System is actively listening for ESP32 hardware triggers.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {collisionAlerts.map((alert) => {
                      const detectedDate = new Date(alert.created_at);
                      const formattedDate = detectedDate.toLocaleDateString([], {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      });
                      const formattedTime = detectedDate.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: true,
                      });
                      const mapUrl = `https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`;
                      const osmUrl = `https://www.openstreetmap.org/?mlat=${alert.latitude}&mlon=${alert.longitude}#map=16/${alert.latitude}/${alert.longitude}`;

                      return (
                        <div
                          key={alert.id}
                          className="p-4 bg-gradient-to-r from-red-50/80 via-white to-red-50/40 rounded-xl border-2 border-red-300 shadow-sm space-y-3"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-red-100 pb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-lg">🚨</span>
                              <span className="text-sm font-extrabold text-red-900 tracking-tight">
                                Ambulance Collision Detected
                              </span>
                              <span className="text-[11px] font-black px-2 py-0.5 bg-amber-200 text-amber-950 border border-amber-400 rounded uppercase tracking-wider">
                                SIMULATED
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                                Incident ID: #{alert.id}
                              </span>
                              <span className="text-xs font-bold px-2 py-0.5 bg-red-600 text-white rounded">
                                {alert.status}
                              </span>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                            <div className="space-y-1 bg-white/80 p-2.5 rounded-lg border border-red-100">
                              <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                                Detection Date & Time
                              </div>
                              <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5 text-red-600" />
                                <span>{formattedDate} at {formattedTime}</span>
                              </div>
                              <div className="text-[11px] text-slate-500">
                                Source: {alert.caller_name || "ESP32 Collision Simulator"}
                              </div>
                            </div>

                            <div className="space-y-1 bg-white/80 p-2.5 rounded-lg border border-red-100">
                              <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">
                                Fixed Collision Coordinates & Site
                              </div>
                              <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                                <MapPin className="w-3.5 h-3.5 text-red-600" />
                                <span>{alert.location_address || "Canara Engineering College"}</span>
                              </div>
                              <div className="flex items-center justify-between text-[11px] text-slate-600">
                                <span className="font-mono">Lat: {alert.latitude.toFixed(6)}, Lon: {alert.longitude.toFixed(6)}</span>
                                <div className="flex items-center gap-2">
                                  <a
                                    href={mapUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-bold text-blue-600 hover:text-blue-800 underline flex items-center gap-0.5"
                                  >
                                    Google Maps <ExternalLink className="w-3 h-3 inline" />
                                  </a>
                                  <span className="text-slate-300">•</span>
                                  <a
                                    href={osmUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-bold text-blue-600 hover:text-blue-800 underline flex items-center gap-0.5"
                                  >
                                    OSM <ExternalLink className="w-3 h-3 inline" />
                                  </a>
                                </div>
                              </div>
                            </div>
                          </div>

                          {alert.chief_complaint && (
                            <div className="text-xs bg-red-100/60 p-2 rounded-lg text-red-950 font-medium border border-red-200/60">
                              {alert.chief_complaint}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Crash Alerts Telemetry Card if present */}
              {activeCrashAlerts.length > 0 && (
                <div className="bg-white rounded-xl border border-red-200 shadow-sm p-4 space-y-3">
                  <div className="flex items-center justify-between border-b border-red-100 pb-2">
                    <div className="flex items-center gap-2 text-red-700 font-bold text-sm">
                      <AlertTriangle className="w-4 h-4" />
                      Active Crash & Impact Events
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 bg-red-100 text-red-800 rounded-full">
                      {activeCrashAlerts.length} Unresolved
                    </span>
                  </div>
                  <div className="space-y-3">
                    {activeCrashAlerts.map((alert) => (
                      <div key={alert.id} className="p-3 bg-red-50/50 rounded-lg border border-red-100 space-y-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-bold text-red-900">
                            Unit #{alert.ambulance_id} ({alert.ambulance_call_sign || "ALS Unit"})
                          </span>
                          <span className="text-red-700 font-semibold">{alert.severity} IMPACT</span>
                        </div>
                        <p className="text-xs text-slate-600">{alert.location_description || "Near Hospital Route"}</p>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            onClick={() => handleRespondCrashAlert(alert.id, "ACKNOWLEDGED")}
                            className="text-xs px-2.5 py-1 bg-white border border-slate-300 rounded font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Acknowledge
                          </button>
                          <button
                            onClick={() => handleRespondCrashAlert(alert.id, "TEAM_NOTIFIED")}
                            className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded font-semibold hover:bg-blue-700"
                          >
                            Notify Trauma Team
                          </button>
                          <button
                            onClick={() => handleRespondCrashAlert(alert.id, "BACKUP_REQUESTED")}
                            className="text-xs px-2.5 py-1 bg-amber-600 text-white rounded font-semibold hover:bg-amber-700"
                          >
                            Request Backup Unit
                          </button>
                          <button
                            onClick={() => handleRespondCrashAlert(alert.id, "RESOLVED")}
                            className="text-xs px-2.5 py-1 bg-emerald-600 text-white rounded font-semibold hover:bg-emerald-700"
                          >
                            Mark Resolved
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Pending Actions Alert Box */}
              {pendingRequests.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Radio className="w-5 h-5 text-amber-600 animate-pulse" />
                      <div>
                        <h4 className="text-sm font-bold text-amber-900">
                          {pendingRequests.length} Provisional Bed Reservation Request(s) Awaiting Decision
                        </h4>
                        <p className="text-xs text-amber-700 mt-0.5">
                          Dual confirmation required. Review incident requirements and respond before countdown expires.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {primaryPendingRequest && (
                        <button
                          onClick={() => handleDecideReservation(primaryPendingRequest.id, "ACCEPTED")}
                          disabled={actionLoading}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow-sm flex items-center gap-1 transition"
                        >
                          <Check className="w-3.5 h-3.5" /> Accept Bed Reservation
                        </button>
                      )}
                      <button
                        onClick={() => setCurrentNav("requests")}
                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-lg shadow-sm"
                      >
                        Review Requests
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Compact Incoming Emergency Queue */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Ambulance className="w-4 h-4 text-blue-600" />
                    <h3 className="text-sm font-bold text-slate-900">Inbound Emergency Queue</h3>
                  </div>
                  <button
                    onClick={() => setCurrentNav("patients")}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex items-center gap-1"
                  >
                    View All Patients <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>

                {activeInboundPatients.length === 0 ? (
                  <div className="p-8 text-center text-slate-400 text-xs">
                    No active inbound patients en route at this moment.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {activeInboundPatients.slice(0, 3).map((disp) => (
                      <div key={disp.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-slate-900">
                              Incident #{disp.incident_id} • Unit {disp.ambulance_call_sign || `#${disp.ambulance_id}`}
                            </span>
                            <span
                              className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                                disp.incident?.triage_color === "RED"
                                  ? "bg-red-100 text-red-800"
                                  : disp.incident?.triage_color === "YELLOW"
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-emerald-100 text-emerald-800"
                              }`}
                            >
                              {disp.incident?.triage_level || "Priority 1"}
                            </span>
                          </div>
                          <p className="text-xs text-slate-600 line-clamp-1">
                            {disp.incident?.chief_complaint || "Emergency trauma response"}
                          </p>
                          <div className="text-[11px] text-slate-400 flex items-center gap-3">
                            <span>Status: {disp.status}</span>
                            <span>•</span>
                            <span>Prep: {disp.hospital_preparation_status || "NOT_STARTED"}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleOpenHandover(disp.id)}
                            className="text-xs px-2.5 py-1.5 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 font-semibold"
                          >
                            SBAR Handover
                          </button>
                          <button
                            onClick={() => handleConfirmArrival(disp.id)}
                            disabled={disp.status !== "AT_HOSPITAL" && !disp.patient_arrived_hospital_confirmed_at}
                            className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold shadow-sm disabled:opacity-40"
                          >
                            Confirm Arrival
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Two Column Summaries: Bed Utilization & Doctor Duty */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Capacity Summary */}
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-2">
                      <Bed className="w-4 h-4 text-slate-600" /> Multi-Tier Bed Capacity
                    </span>
                    <button
                      onClick={() => setCurrentNav("beds")}
                      className="text-xs text-blue-600 hover:text-blue-700 font-semibold"
                    >
                      Manage
                    </button>
                  </div>
                  <div className="space-y-2 text-xs">
                    {Object.entries(hospital?.bed_capacity_breakdown || {}).slice(0, 4).map(([key, item]: [string, any]) => (
                      <div key={key} className="space-y-1">
                        <div className="flex justify-between text-slate-700">
                          <span className="font-medium">{item.name}</span>
                          <span className="font-bold">
                            {item.available} / {item.total} available
                          </span>
                        </div>
                        <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${
                              item.available === 0
                                ? "bg-red-500"
                                : item.available <= 2
                                ? "bg-amber-500"
                                : "bg-emerald-500"
                            }`}
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round(((item.occupied + item.reserved) / Math.max(1, item.total)) * 100)
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Doctors On Shift Summary */}
                <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-3">
                  <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                    <span className="text-xs font-bold text-slate-900 flex items-center gap-2">
                      <Stethoscope className="w-4 h-4 text-purple-600" /> Doctors On Duty Now
                    </span>
                    <button
                      onClick={() => setCurrentNav("doctors")}
                      className="text-xs text-blue-600 hover:text-blue-700 font-semibold"
                    >
                      Roster
                    </button>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {onDutyDoctors.slice(0, 4).map((doc) => (
                      <div key={doc.id} className="py-2 flex items-center justify-between text-xs">
                        <div>
                          <div className="font-bold text-slate-900">{doc.name}</div>
                          <div className="text-[11px] text-slate-500">
                            {doc.specialty} • {doc.department}
                          </div>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            doc.effective_status === "AVAILABLE"
                              ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              : "bg-amber-50 text-amber-700 border border-amber-200"
                          }`}
                        >
                          {doc.effective_status}
                        </span>
                      </div>
                    ))}
                    {onDutyDoctors.length === 0 && (
                      <div className="py-4 text-center text-slate-400 text-xs">
                        No doctors currently on active shift schedule.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Demo Simulation Controls for Hackathon */}
              <div className="p-4 bg-slate-100/70 border border-slate-200 rounded-xl flex items-center justify-between text-xs text-slate-600">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-amber-600" />
                  <span>
                    <strong>Hackathon Live Simulation:</strong> Test real-time hardware telemetry and collision handling.
                  </span>
                </div>
                <button
                  onClick={handleSimulateCrash}
                  disabled={actionLoading}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg shadow-sm"
                >
                  Simulate Ambulance Crash
                </button>
              </div>
            </div>
          )}

          {/* SECTION 2: INCOMING REQUESTS */}
          {currentNav === "requests" && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Incoming Reservation Requests</h2>
                  <p className="text-xs text-slate-500">
                    Provisional emergency bed reservations awaiting dual confirmation from hospital clinical staff.
                  </p>
                </div>
                <span className="text-xs font-bold px-2.5 py-1 bg-amber-50 text-amber-800 border border-amber-200 rounded-lg">
                  {pendingRequests.length} Pending
                </span>
              </div>

              {pendingRequests.length === 0 ? (
                <div className="bg-white p-12 rounded-xl border border-slate-200 text-center space-y-3">
                  <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <h3 className="text-sm font-bold text-slate-800">No Pending Requests</h3>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto">
                    All emergency dispatches have been handled or no incoming requests are currently awaiting your facility's response.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {pendingRequests.map((req) => (
                    <div
                      key={req.id}
                      className="bg-white rounded-xl border-2 border-amber-300 shadow-sm p-5 space-y-4"
                    >
                      {/* Top Header & Countdown */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-xs font-bold px-2.5 py-1 rounded-md ${
                              req.incident?.triage_color === "RED"
                                ? "bg-red-100 text-red-800"
                                : req.incident?.triage_color === "YELLOW"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-emerald-100 text-emerald-800"
                            }`}
                          >
                            {req.incident?.triage_level || "Priority 1"}
                          </span>
                          <span className="text-sm font-bold text-slate-900">
                            Incident #{req.incident_id} • Unit {req.ambulance_call_sign || `#${req.ambulance_id}`}
                          </span>
                        </div>

                        {remainingSeconds !== null && (
                          <div className="flex items-center gap-2 text-xs font-bold text-amber-700 bg-amber-50 px-3 py-1 rounded-full border border-amber-200">
                            <Clock className="w-3.5 h-3.5" />
                            <span>TTL: {remainingSeconds}s Remaining</span>
                          </div>
                        )}
                      </div>

                      {/* Incident & Patient Breakdown */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                        <div className="space-y-1">
                          <span className="text-slate-400 font-semibold uppercase text-[10px]">Chief Complaint</span>
                          <p className="font-bold text-slate-900">{req.incident?.chief_complaint || "Acute medical distress"}</p>
                          <p className="text-slate-500 text-[11px]">{req.incident?.location_address || "Mangaluru Metro"}</p>
                        </div>

                        <div className="space-y-1">
                          <span className="text-slate-400 font-semibold uppercase text-[10px]">Patient & Vitals</span>
                          <p className="font-medium text-slate-800">
                            Age: {req.incident?.patient_age ?? "Unknown"} • Gender: {req.incident?.patient_gender ?? "Unknown"}
                          </p>
                          <p className="text-slate-600 text-[11px]">
                            Consciousness: {req.incident?.consciousness_level || "Normal"} • Breathing: {req.incident?.breathing_status || "Normal"}
                          </p>
                        </div>

                        <div className="space-y-1">
                          <span className="text-slate-400 font-semibold uppercase text-[10px]">Hospital Capacity Check</span>
                          <p className="font-medium text-slate-800">
                            ER Bays Open: <strong className="text-emerald-600">{erBeds.available}</strong>
                          </p>
                          <p className="text-slate-600 text-[11px]">
                            ICU Beds Open: <strong className="text-blue-600">{icuBeds.available}</strong>
                          </p>
                        </div>
                      </div>

                      {/* Working Actions */}
                      <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
                        <button
                          onClick={() => setSelectedIncidentModal(req)}
                          className="text-xs font-semibold text-slate-600 hover:text-slate-900 flex items-center gap-1.5"
                        >
                          <Eye className="w-3.5 h-3.5" /> View Incident Details
                        </button>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => setRejectModalDispatch(req)}
                            disabled={actionLoading}
                            className="px-4 py-2 bg-white border border-red-300 text-red-700 hover:bg-red-50 text-xs font-bold rounded-lg transition-colors"
                          >
                            Reject / Divert
                          </button>
                          <button
                            onClick={() => handleDecideReservation(req.id, "ACCEPTED")}
                            disabled={actionLoading}
                            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
                          >
                            <Check className="w-4 h-4" /> Accept Bed Reservation
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* SECTION 3: INCOMING PATIENTS */}
          {currentNav === "patients" && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Incoming Patients & Active Emergencies</h2>
                  <p className="text-xs text-slate-500">
                    Live tracking of confirmed en-route ambulances, pre-arrival preparation, and clinical handovers.
                  </p>
                </div>

                {/* Filter Pills */}
                <div className="flex flex-wrap items-center gap-1.5 bg-white p-1 rounded-lg border border-slate-200">
                  <button
                    onClick={() => setPatientsFilter("ALL")}
                    className={`text-xs px-2.5 py-1 rounded font-semibold ${
                      patientsFilter === "ALL" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    All ({activeInboundPatients.length})
                  </button>
                  <button
                    onClick={() => setPatientsFilter("PRIORITY_1")}
                    className={`text-xs px-2.5 py-1 rounded font-semibold ${
                      patientsFilter === "PRIORITY_1" ? "bg-red-600 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Priority 1
                  </button>
                  <button
                    onClick={() => setPatientsFilter("ARRIVING_SOON")}
                    className={`text-xs px-2.5 py-1 rounded font-semibold ${
                      patientsFilter === "ARRIVING_SOON" ? "bg-amber-600 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Arriving Soon
                  </button>
                </div>
              </div>

              {filteredInboundPatients.length === 0 ? (
                <div className="bg-white p-12 rounded-xl border border-slate-200 text-center space-y-3">
                  <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto">
                    <Ambulance className="w-6 h-6" />
                  </div>
                  <h3 className="text-sm font-bold text-slate-800">
                    {patientsFilter === "ALL"
                      ? "No Active Inbound Patients"
                      : patientsFilter === "PRIORITY_1"
                      ? "No Priority 1 Inbound Patients"
                      : "No Patients Arriving Soon"}
                  </h3>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto">
                    {patientsFilter === "ALL"
                      ? "There are no confirmed ambulances transporting to your facility right now."
                      : "No active inbound patients match the selected filter criteria."}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredInboundPatients.map((disp) => {
                    const prepStatus = disp.hospital_preparation_status || "NOT_STARTED";
                    const isArrived = disp.status === "AT_HOSPITAL" || !!disp.patient_arrived_hospital_confirmed_at;

                    return (
                      <div key={disp.id} className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-bold px-2 py-0.5 rounded ${
                                disp.incident?.triage_color === "RED"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-amber-100 text-amber-800"
                              }`}
                            >
                              {disp.incident?.triage_level || "Priority 1"}
                            </span>
                            <span className="text-sm font-bold text-slate-900">
                              Incident #{disp.incident_id} • Unit {disp.ambulance_call_sign || `#${disp.ambulance_id}`}
                            </span>
                          </div>

                          <div className="flex items-center gap-3 text-xs">
                            <span className="font-semibold text-slate-500">Lifecycle:</span>
                            <span className="font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                              {disp.status}
                            </span>
                          </div>
                        </div>

                        {/* Patient info & Preparation Stepper */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                          <div className="space-y-1.5 text-xs">
                            <div className="font-bold text-slate-900">{disp.incident?.chief_complaint}</div>
                            <div className="text-slate-600">{disp.incident?.location_address}</div>
                            <div className="text-slate-500 text-[11px]">
                              Patient: {disp.incident?.patient_age ?? "Unknown"}y / {disp.incident?.patient_gender ?? "Unknown"} • Ambulance Type: {disp.incident?.required_ambulance_type || "ALS"}
                            </div>
                          </div>

                          {/* Trauma Preparation Stepper */}
                          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold text-slate-700">Trauma Bay Preparation:</span>
                              <span className="font-bold text-blue-600">{prepStatus}</span>
                            </div>

                            <div className="flex items-center gap-1">
                              {["NOT_STARTED", "TEAM_NOTIFIED", "BAY_PREPARED", "SPECIALISTS_STANDBY", "READY_FOR_ARRIVAL"].map((step, idx) => {
                                const stepIdx = ["NOT_STARTED", "TEAM_NOTIFIED", "BAY_PREPARED", "SPECIALISTS_STANDBY", "READY_FOR_ARRIVAL"].indexOf(prepStatus);
                                const isDone = stepIdx >= idx;
                                return (
                                  <div
                                    key={step}
                                    className={`flex-1 h-1.5 rounded-full ${isDone ? "bg-blue-600" : "bg-slate-200"}`}
                                  />
                                );
                              })}
                            </div>

                            <div className="flex items-center gap-2 pt-1">
                              <input
                                type="text"
                                placeholder="Preparation notes (e.g. Bay 1 ready)..."
                                value={prepNoteInput[disp.id] || ""}
                                onChange={(e) => setPrepNoteInput({ ...prepNoteInput, [disp.id]: e.target.value })}
                                className="flex-1 text-xs px-2 py-1 bg-white border border-slate-300 rounded"
                              />
                              <button
                                onClick={() => {
                                  const steps = ["NOT_STARTED", "TEAM_NOTIFIED", "BAY_PREPARED", "SPECIALISTS_STANDBY", "READY_FOR_ARRIVAL"];
                                  const nextIdx = Math.min(steps.length - 1, steps.indexOf(prepStatus) + 1);
                                  handleUpdatePreparation(disp.id, steps[nextIdx]);
                                }}
                                disabled={prepStatus === "READY_FOR_ARRIVAL" || actionLoading}
                                className="text-xs px-2.5 py-1 bg-blue-600 text-white font-semibold rounded hover:bg-blue-700 disabled:opacity-40"
                              >
                                Advance
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Live Vitals Telemetry Chip Bar (Phase 2 Handover Integration) */}
                        {disp.latest_vitals && (
                          <div className="bg-rose-50/60 border border-rose-200/90 rounded-lg p-3 space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-bold text-rose-950 flex items-center gap-1.5">
                                <Activity className="w-3.5 h-3.5 text-rose-600" />
                                <span>In-Transit Patient Vitals (Field Telemetry)</span>
                              </span>
                              <span className="text-[10px] text-slate-500 font-mono">
                                Recorded at {new Date(disp.latest_vitals.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                              <div className="bg-white p-2 rounded border border-rose-100">
                                <span className="text-[10px] font-medium text-slate-500 block">Heart Rate</span>
                                <span className="font-mono font-black text-rose-950 text-base">{disp.latest_vitals.heart_rate}</span>
                                <span className="text-[10px] text-rose-600 block">bpm</span>
                              </div>
                              <div className="bg-white p-2 rounded border border-indigo-100">
                                <span className="text-[10px] font-medium text-slate-500 block">Blood Pressure</span>
                                <span className="font-mono font-black text-indigo-950 text-base">{disp.latest_vitals.blood_pressure_systolic}/{disp.latest_vitals.blood_pressure_diastolic}</span>
                                <span className="text-[10px] text-indigo-600 block">mmHg</span>
                              </div>
                              <div className="bg-white p-2 rounded border border-sky-100">
                                <span className="text-[10px] font-medium text-slate-500 block">Oxygen (SpO2)</span>
                                <span className="font-mono font-black text-sky-950 text-base">{disp.latest_vitals.oxygen_saturation}%</span>
                                <span className="text-[10px] text-sky-600 block">sat</span>
                              </div>
                              <div className="bg-white p-2 rounded border border-emerald-100">
                                <span className="text-[10px] font-medium text-slate-500 block">Resp. Rate</span>
                                <span className="font-mono font-black text-emerald-950 text-base">{disp.latest_vitals.respiratory_rate}</span>
                                <span className="text-[10px] text-emerald-600 block">/min</span>
                              </div>
                            </div>

                            {disp.latest_vitals.notes && (
                              <p className="text-[11px] text-slate-700 bg-white/90 p-2 rounded border border-rose-100">
                                <span className="font-bold text-slate-900">Paramedic Notes: </span>
                                {disp.latest_vitals.notes}
                              </p>
                            )}
                          </div>
                        )}

                        {/* Working Actions Bar */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setSelectedIncidentModal(disp)}
                              className="text-xs px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 font-semibold"
                            >
                              Incident Info
                            </button>
                            <button
                              onClick={() => handleOpenHandover(disp.id)}
                              className="text-xs px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 font-semibold"
                            >
                              SBAR Clinical Handover
                            </button>
                          </div>

                          <button
                            onClick={() => handleConfirmArrival(disp.id)}
                            disabled={isArrived && !!disp.patient_arrived_hospital_confirmed_at}
                            className={`text-xs px-4 py-1.5 rounded-lg font-bold shadow-sm ${
                              isArrived
                                ? "bg-emerald-100 text-emerald-800 border border-emerald-300 cursor-default"
                                : "bg-emerald-600 hover:bg-emerald-700 text-white"
                            }`}
                          >
                            {disp.patient_arrived_hospital_confirmed_at ? "Arrival Confirmed ✓" : "Confirm ER Arrival"}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* SECTION 4: DOCTORS & SHIFTS */}
          {currentNav === "doctors" && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Doctor Rostering & Shift Management</h2>
                  <p className="text-xs text-slate-500">
                    Schedule working shifts, assign departments, configure working days, and manage real-time duty status.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setEditingDoctor(null);
                    setDoctorForm({
                      name: "",
                      specialty: "Emergency Medicine",
                      department: "Emergency Medicine",
                      designation: "Consultant Emergency Physician",
                      shift_type: "MORNING",
                      shift_start: "08:00",
                      shift_end: "16:00",
                      working_days: ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
                      status: "AVAILABLE",
                      emergency_coverage: true,
                      contact_number: "Ext. 101",
                    });
                    setIsAddDoctorModalOpen(true);
                  }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Add Doctor
                </button>
              </div>

              {/* Roster Controls: Search & Filters */}
              <div className="bg-white p-3 rounded-xl border border-slate-200 flex flex-wrap items-center gap-3">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Search doctor by name or specialty..."
                    value={doctorSearch}
                    onChange={(e) => setDoctorSearch(e.target.value)}
                    className="w-full text-xs pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <select
                  value={doctorDeptFilter}
                  onChange={(e) => setDoctorDeptFilter(e.target.value)}
                  className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-700"
                >
                  <option value="ALL">All Departments</option>
                  {Array.from(new Set(doctors.map((d) => d.department))).map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                </select>

                <select
                  value={doctorStatusFilter}
                  onChange={(e) => setDoctorStatusFilter(e.target.value)}
                  className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-700"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="ON_DUTY">On Duty Now</option>
                  <option value="AVAILABLE">Available</option>
                  <option value="BUSY">Busy</option>
                  <option value="OFF_DUTY">Off Duty</option>
                  <option value="ON_LEAVE">On Leave</option>
                </select>
              </div>

              {/* Doctors Table */}
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase text-[10px]">
                        <th className="p-3 pl-4">Doctor Name & Title</th>
                        <th className="p-3">Department & Specialty</th>
                        <th className="p-3">Shift Schedule</th>
                        <th className="p-3">Working Days</th>
                        <th className="p-3">Duty Status</th>
                        <th className="p-3">Contact</th>
                        <th className="p-3 pr-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {doctors
                        .filter((doc) => {
                          const matchesSearch =
                            doc.name.toLowerCase().includes(doctorSearch.toLowerCase()) ||
                            doc.specialty.toLowerCase().includes(doctorSearch.toLowerCase());
                          const matchesDept = doctorDeptFilter === "ALL" || doc.department === doctorDeptFilter;
                          let matchesStatus = true;
                          if (doctorStatusFilter === "ON_DUTY") matchesStatus = !!doc.is_on_duty;
                          else if (doctorStatusFilter !== "ALL") matchesStatus = doc.effective_status === doctorStatusFilter;
                          return matchesSearch && matchesDept && matchesStatus;
                        })
                        .map((doc) => (
                          <tr key={doc.id} className="hover:bg-slate-50/70">
                            <td className="p-3 pl-4">
                              <div className="font-bold text-slate-900">{doc.name}</div>
                              <div className="text-[11px] text-slate-400">{doc.designation || "Medical Officer"}</div>
                            </td>
                            <td className="p-3">
                              <div className="font-medium text-slate-800">{doc.department}</div>
                              <div className="text-[11px] text-slate-500">{doc.specialty}</div>
                            </td>
                            <td className="p-3">
                              <div className="font-medium text-slate-800">
                                {doc.shift_start && doc.shift_end ? `${doc.shift_start} - ${doc.shift_end}` : doc.shift}
                              </div>
                              <div className="text-[11px] text-slate-400 capitalize">{doc.shift_type || "Day"}</div>
                            </td>
                            <td className="p-3">
                              <span className="text-[11px] text-slate-600 font-mono">
                                {(doc.working_days || ["MON", "TUE", "WED", "THU", "FRI", "SAT"]).join(", ")}
                              </span>
                            </td>
                            <td className="p-3">
                              <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                  doc.effective_status === "AVAILABLE"
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                    : doc.effective_status === "BUSY"
                                    ? "bg-amber-50 text-amber-700 border-amber-200"
                                    : doc.effective_status === "ON_LEAVE"
                                    ? "bg-purple-50 text-purple-700 border-purple-200"
                                    : "bg-slate-100 text-slate-600 border-slate-200"
                                }`}
                              >
                                {doc.effective_status || doc.status}
                              </span>
                              <div className="text-[10px] text-slate-400 mt-0.5">{doc.duty_reason}</div>
                            </td>
                            <td className="p-3 font-mono text-slate-600">{doc.contact_number || "—"}</td>
                            <td className="p-3 pr-4 text-right">
                              <div className="flex items-center justify-end gap-1.5">
                                <select
                                  value={doc.status}
                                  onChange={(e) => handleUpdateDoctorStatus(doc.id, e.target.value)}
                                  className="text-[11px] px-2 py-1 bg-white border border-slate-200 rounded font-medium"
                                >
                                  <option value="AVAILABLE">Available</option>
                                  <option value="BUSY">Busy</option>
                                  <option value="OFF_DUTY">Off Duty</option>
                                  <option value="ON_LEAVE">On Leave</option>
                                  <option value="UNAVAILABLE">Unavailable</option>
                                </select>
                                <button
                                  onClick={() => {
                                    setEditingDoctor(doc);
                                    setDoctorForm({
                                      name: doc.name,
                                      specialty: doc.specialty,
                                      department: doc.department,
                                      designation: doc.designation || "Consultant Physician",
                                      shift_type: doc.shift_type || "MORNING",
                                      shift_start: doc.shift_start || "08:00",
                                      shift_end: doc.shift_end || "16:00",
                                      working_days: doc.working_days || ["MON", "TUE", "WED", "THU", "FRI", "SAT"],
                                      status: doc.status,
                                      emergency_coverage: doc.emergency_coverage ?? true,
                                      contact_number: doc.contact_number || "",
                                    });
                                    setIsAddDoctorModalOpen(true);
                                  }}
                                  className="p-1 text-slate-500 hover:text-blue-600 rounded"
                                  title="Edit Doctor Details"
                                >
                                  <Eye className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeleteDoctor(doc.id, doc.name)}
                                  className="p-1 text-slate-400 hover:text-red-600 rounded"
                                  title="Remove Doctor"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* SECTION 5: BED CAPACITY */}
          {currentNav === "beds" && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Bed Capacity & Ward Allocation Engine</h2>
                  <p className="text-xs text-slate-500">
                    Live bed availability computed strictly as: Available = Total - Occupied - Reserved - Unavailable.
                  </p>
                </div>
              </div>

              {bedFormError && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-800 text-xs rounded-lg font-medium flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{bedFormError}</span>
                </div>
              )}

              <form onSubmit={handleSaveBedCapacity} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Object.entries(bedCapacityForm).map(([catKey, catData]) => {
                    const total = Number(catData.total) || 0;
                    const occupied = Number(catData.occupied) || 0;
                    const reserved = Number(catData.reserved) || 0;
                    const unavailable = Number(catData.unavailable) || 0;
                    const available = Math.max(0, total - occupied - reserved - unavailable);

                    return (
                      <div key={catKey} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm space-y-3">
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="font-bold text-slate-900 text-sm">{catData.name || catKey}</span>
                          <span
                            className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                              available === 0
                                ? "bg-red-50 text-red-700 border border-red-200"
                                : available <= 2
                                ? "bg-amber-50 text-amber-700 border border-amber-200"
                                : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            }`}
                          >
                            {available} Available
                          </span>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <label className="text-[11px] font-semibold text-slate-500 block mb-1">Total Beds</label>
                            <input
                              type="number"
                              min="0"
                              value={catData.total}
                              onChange={(e) =>
                                setBedCapacityForm({
                                  ...bedCapacityForm,
                                  [catKey]: { ...catData, total: Number(e.target.value) },
                                })
                              }
                              className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-900 font-bold"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-semibold text-slate-500 block mb-1">Occupied</label>
                            <input
                              type="number"
                              min="0"
                              value={catData.occupied}
                              onChange={(e) =>
                                setBedCapacityForm({
                                  ...bedCapacityForm,
                                  [catKey]: { ...catData, occupied: Number(e.target.value) },
                                })
                              }
                              className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-900 font-bold"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-semibold text-slate-500 block mb-1">
                              Reserved {catKey === "emergency" ? "(Auto-linked)" : ""}
                            </label>
                            <input
                              type="number"
                              min="0"
                              value={catData.reserved}
                              onChange={(e) =>
                                setBedCapacityForm({
                                  ...bedCapacityForm,
                                  [catKey]: { ...catData, reserved: Number(e.target.value) },
                                })
                              }
                              className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-700 font-mono"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-semibold text-slate-500 block mb-1">Unavailable / Maint.</label>
                            <input
                              type="number"
                              min="0"
                              value={catData.unavailable}
                              onChange={(e) =>
                                setBedCapacityForm({
                                  ...bedCapacityForm,
                                  [catKey]: { ...catData, unavailable: Number(e.target.value) },
                                })
                              }
                              className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded text-slate-700 font-mono"
                            />
                          </div>
                        </div>

                        {/* Visual Utilization Bar */}
                        <div className="pt-2 border-t border-slate-50">
                          <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600"
                              style={{
                                width: `${Math.min(100, Math.round(((occupied + reserved) / Math.max(1, total)) * 100))}%`,
                              }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    type="submit"
                    disabled={actionLoading}
                    className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm transition-colors"
                  >
                    Save & Broadcast Bed Counts
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* SECTION 6: DEPARTMENTS & CAPABILITIES */}
          {currentNav === "capabilities" && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Clinical Departments & Hospital Capabilities</h2>
                  <p className="text-xs text-slate-500">
                    Maintain operational hours, clinical specialties, and facility indicators used by the dispatch allocation engine.
                  </p>
                </div>

                {/* Sub-tabs */}
                <div className="flex items-center gap-1 bg-white p-1 rounded-lg border border-slate-200">
                  <button
                    onClick={() => setCapabilitiesTab("DEPARTMENTS")}
                    className={`text-xs px-3 py-1.5 rounded font-semibold ${
                      capabilitiesTab === "DEPARTMENTS" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Departments ({hospital?.departments?.length || 0})
                  </button>
                  <button
                    onClick={() => setCapabilitiesTab("CAPABILITIES")}
                    className={`text-xs px-3 py-1.5 rounded font-semibold ${
                      capabilitiesTab === "CAPABILITIES" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Facility Indicators
                  </button>
                </div>
              </div>

              {/* Tab 1: Departments */}
              {capabilitiesTab === "DEPARTMENTS" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(hospital?.departments || []).map((dept: Department) => (
                    <div key={dept.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm space-y-3">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                        <div className="font-bold text-sm text-slate-900">{dept.name}</div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                            dept.operational_status === "ACTIVE"
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : dept.operational_status === "LIMITED"
                              ? "bg-amber-50 text-amber-700 border-amber-200"
                              : "bg-red-50 text-red-700 border-red-200"
                          }`}
                        >
                          {dept.operational_status}
                        </span>
                      </div>

                      <div className="text-xs space-y-1.5 text-slate-600">
                        <div>
                          <strong>Hours:</strong> {dept.operating_hours || "24/7"} •{" "}
                          <strong>Emergency Routing:</strong> {dept.emergency_coverage ? "Enabled" : "Disabled"}
                        </div>
                        {dept.notes && <div className="text-slate-500 italic">Notes: {dept.notes}</div>}
                        <div className="flex flex-wrap gap-1 pt-1">
                          {(dept.specialty_availability || []).map((spec) => (
                            <span key={spec} className="text-[10px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded">
                              {spec}
                            </span>
                          ))}
                        </div>
                      </div>

                      <div className="flex justify-end gap-2 pt-2 border-t border-slate-50">
                        <button
                          onClick={() => setEditingDepartment(dept)}
                          className="text-xs font-semibold text-blue-600 hover:text-blue-700"
                        >
                          Edit Status & Notes
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Tab 2: Capabilities Matrix */}
              {capabilitiesTab === "CAPABILITIES" && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
                  <div className="border-b border-slate-100 pb-3">
                    <h3 className="text-sm font-bold text-slate-900">Hospital-Reported Capability Matrix</h3>
                    <p className="text-xs text-slate-500">
                      Toggle operational status for key clinical capabilities. Evaluated in ambulance triage recommendations.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    {[
                      { key: "cardiac_emergency", label: "Cardiac Emergency Support (Cath Lab / PCI)" },
                      { key: "trauma_capability", label: "Polytrauma Resuscitation Capability" },
                      { key: "icu_availability", label: "Critical Care / High-Flow ICU" },
                      { key: "ventilator_availability", label: "Mechanical Ventilator Inventory" },
                      { key: "defibrillator_availability", label: "Defibrillation & Emergency Pacing" },
                      { key: "emergency_imaging", label: "24/7 Emergency CT & Diagnostics" },
                      { key: "operating_theatre", label: "Emergency Surgical Operating Theatre" },
                      { key: "blood_bank", label: "Emergency Blood Bank Reserve" },
                    ].map(({ key, label }) => {
                      const currentVal = capabilitiesState[key] || "AVAILABLE";

                      return (
                        <div key={key} className="p-3 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                          <span className="font-semibold text-slate-800">{label}</span>
                          <select
                            value={currentVal}
                            onChange={(e) => handleUpdateCapability(key, e.target.value)}
                            className={`text-xs px-2.5 py-1 rounded font-bold border ${
                              currentVal === "AVAILABLE"
                                ? "bg-emerald-50 text-emerald-800 border-emerald-300"
                                : currentVal === "LIMITED"
                                ? "bg-amber-50 text-amber-800 border-amber-300"
                                : "bg-red-50 text-red-800 border-red-300"
                            }`}
                          >
                            <option value="AVAILABLE">AVAILABLE</option>
                            <option value="LIMITED">LIMITED</option>
                            <option value="UNAVAILABLE">UNAVAILABLE</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SECTION 7: HANDOVER & HISTORY */}
          {currentNav === "handover_history" && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-900">Clinical Handover & Patient History</h2>
                  <p className="text-xs text-slate-500">
                    SBAR clinical receiving documentation, formal acknowledgments, and hospital-scoped audit trails.
                  </p>
                </div>

                <div className="flex items-center gap-1 bg-white p-1 rounded-lg border border-slate-200">
                  <button
                    onClick={() => setHistoryTab("HANDOVERS")}
                    className={`text-xs px-3 py-1.5 rounded font-semibold ${
                      historyTab === "HANDOVERS" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Active Handovers
                  </button>
                  <button
                    onClick={() => setHistoryTab("HISTORY")}
                    className={`text-xs px-3 py-1.5 rounded font-semibold ${
                      historyTab === "HISTORY" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    Historical Records ({completedIncidents.length})
                  </button>
                </div>
              </div>

              {historyTab === "HANDOVERS" && (
                <div className="space-y-4">
                  {activeInboundPatients.length === 0 ? (
                    <div className="bg-white p-12 rounded-xl border border-slate-200 text-center text-slate-400 text-xs">
                      No active inbound cases currently requiring clinical handover.
                    </div>
                  ) : (
                    activeInboundPatients.map((disp) => (
                      <div key={disp.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm flex items-center justify-between">
                        <div className="space-y-1 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">Incident #{disp.incident_id}</span>
                            <span className="text-slate-500">• Unit {disp.ambulance_call_sign || `#${disp.ambulance_id}`}</span>
                          </div>
                          <div className="text-slate-700">{disp.incident?.chief_complaint}</div>
                          <div className="text-[11px] text-slate-400">
                            Status: {disp.handover_packet?.status || "PENDING / SENT"}
                          </div>
                        </div>

                        <button
                          onClick={() => handleOpenHandover(disp.id)}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm"
                        >
                          Open SBAR Workspace
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}

              {historyTab === "HISTORY" && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <div className="p-3 border-b border-slate-100">
                    <input
                      type="text"
                      placeholder="Search incident history by complaint or ambulance..."
                      value={historySearch}
                      onChange={(e) => setHistorySearch(e.target.value)}
                      className="w-full text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none"
                    />
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold uppercase text-[10px]">
                          <th className="p-3 pl-4">Incident ID</th>
                          <th className="p-3">Priority</th>
                          <th className="p-3">Chief Complaint</th>
                          <th className="p-3">Ambulance</th>
                          <th className="p-3">Arrival Confirmed</th>
                          <th className="p-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {completedIncidents
                          .filter((d) => {
                            const complaint = d.incident?.chief_complaint || "";
                            const callSign = d.ambulance_call_sign || "";
                            return (
                              complaint.toLowerCase().includes(historySearch.toLowerCase()) ||
                              callSign.toLowerCase().includes(historySearch.toLowerCase())
                            );
                          })
                          .map((disp) => (
                            <tr key={disp.id} className="hover:bg-slate-50">
                              <td className="p-3 pl-4 font-bold text-slate-900">#{disp.incident_id}</td>
                              <td className="p-3 font-semibold text-slate-700">{disp.incident?.triage_level || "P1"}</td>
                              <td className="p-3 text-slate-800">{disp.incident?.chief_complaint}</td>
                              <td className="p-3 font-mono">{disp.ambulance_call_sign || `#${disp.ambulance_id}`}</td>
                              <td className="p-3 text-slate-500">
                                {disp.patient_arrived_hospital_confirmed_at
                                  ? new Date(disp.patient_arrived_hospital_confirmed_at).toLocaleTimeString()
                                  : "Completed"}
                              </td>
                              <td className="p-3 font-bold text-emerald-600">COMPLETED</td>
                            </tr>
                          ))}
                        {completedIncidents.length === 0 && (
                          <tr>
                            <td colSpan={6} className="p-8 text-center text-slate-400">
                              No archived incident history found for this facility.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SECTION 8: HOSPITAL SETTINGS / PROFILE */}
          {currentNav === "settings" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-bold text-slate-900">Hospital Facility Profile & Operations Settings</h2>
                <p className="text-xs text-slate-500">
                  Update facility contact info, emergency response hours, geographic coordinates, and operational state.
                </p>
              </div>

              <form onSubmit={handleSaveProfile} className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Facility Name</label>
                    <input
                      type="text"
                      value={profileForm.name}
                      onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-bold"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Facility Code (System ID)</label>
                    <input
                      type="text"
                      disabled
                      value={hospital?.facility_code || "HOSP-01"}
                      className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded font-mono text-slate-500 cursor-not-allowed"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Address / Landmark</label>
                    <input
                      type="text"
                      value={profileForm.address}
                      onChange={(e) => setProfileForm({ ...profileForm, address: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Latitude Coordinate</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={profileForm.latitude}
                      onChange={(e) => setProfileForm({ ...profileForm, latitude: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Longitude Coordinate</label>
                    <input
                      type="number"
                      step="0.0001"
                      value={profileForm.longitude}
                      onChange={(e) => setProfileForm({ ...profileForm, longitude: Number(e.target.value) })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Facility Classification</label>
                    <input
                      type="text"
                      value={profileForm.facility_type}
                      onChange={(e) => setProfileForm({ ...profileForm, facility_type: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Emergency Department Hours</label>
                    <input
                      type="text"
                      value={profileForm.emergency_department_hours}
                      onChange={(e) => setProfileForm({ ...profileForm, emergency_department_hours: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Priority ER Phone Contact</label>
                    <input
                      type="text"
                      value={profileForm.contact_number}
                      onChange={(e) => setProfileForm({ ...profileForm, contact_number: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Emergency Officer In-Charge</label>
                    <input
                      type="text"
                      value={profileForm.emergency_contact_person}
                      onChange={(e) => setProfileForm({ ...profileForm, emergency_contact_person: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">Operational Readiness Status</label>
                    <select
                      value={profileForm.readiness_status}
                      onChange={(e) => setProfileForm({ ...profileForm, readiness_status: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-bold"
                    >
                      <option value="READY">READY (Accepting All Emergencies)</option>
                      <option value="BUSY">BUSY (High Turnaround / Near Saturation)</option>
                      <option value="DIVERT">DIVERT (Temporary Critical Divert)</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2 pt-6">
                    <input
                      type="checkbox"
                      id="acceptEmergencies"
                      checked={profileForm.accepting_emergencies}
                      onChange={(e) => setProfileForm({ ...profileForm, accepting_emergencies: e.target.checked })}
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                    />
                    <label htmlFor="acceptEmergencies" className="text-xs font-bold text-slate-800">
                      Eligible for Regional Emergency Dispatch
                    </label>
                  </div>
                </div>

                <div className="flex justify-end pt-3 border-t border-slate-100">
                  <button
                    type="submit"
                    disabled={actionLoading}
                    className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm transition-colors"
                  >
                    Save Facility Profile & Settings
                  </button>
                </div>
              </form>
            </div>
          )}
        </main>
      </div>

      {/* ========================================================================= */}
      {/* MODALS & DIALOGS                                                          */}
      {/* ========================================================================= */}

      {/* 1. ADD / EDIT DOCTOR MODAL */}
      {isAddDoctorModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full overflow-hidden animate-in fade-in zoom-in-95">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                {editingDoctor ? "Edit Doctor Schedule & Details" : "Add Doctor to Clinical Roster"}
              </h3>
              <button
                onClick={() => setIsAddDoctorModalOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveDoctor} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Doctor Name</label>
                  <input
                    type="text"
                    required
                    placeholder="Dr. Full Name"
                    value={doctorForm.name}
                    onChange={(e) => setDoctorForm({ ...doctorForm, name: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-semibold text-slate-900"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Department</label>
                  <input
                    type="text"
                    required
                    value={doctorForm.department}
                    onChange={(e) => setDoctorForm({ ...doctorForm, department: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Specialty</label>
                  <input
                    type="text"
                    required
                    value={doctorForm.specialty}
                    onChange={(e) => setDoctorForm({ ...doctorForm, specialty: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Designation</label>
                  <input
                    type="text"
                    value={doctorForm.designation}
                    onChange={(e) => setDoctorForm({ ...doctorForm, designation: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Contact Extension</label>
                  <input
                    type="text"
                    value={doctorForm.contact_number}
                    onChange={(e) => setDoctorForm({ ...doctorForm, contact_number: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-mono"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Shift Type</label>
                  <select
                    value={doctorForm.shift_type}
                    onChange={(e) => {
                      const st = e.target.value;
                      let s = "08:00";
                      let end = "16:00";
                      if (st === "EVENING") {
                        s = "16:00";
                        end = "00:00";
                      } else if (st === "NIGHT") {
                        s = "20:00";
                        end = "08:00";
                      } else if (st === "ON_CALL") {
                        s = "00:00";
                        end = "23:59";
                      }
                      setDoctorForm({ ...doctorForm, shift_type: st, shift_start: s, shift_end: end });
                    }}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-semibold"
                  >
                    <option value="MORNING">Morning Shift (08:00 - 16:00)</option>
                    <option value="EVENING">Evening Shift (16:00 - 00:00)</option>
                    <option value="NIGHT">Night Shift (20:00 - 08:00 overnight)</option>
                    <option value="ON_CALL">On-Call (24h Emergency Response)</option>
                    <option value="CUSTOM">Custom Shift Timing</option>
                  </select>
                </div>

                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">Shift Start</label>
                    <input
                      type="text"
                      placeholder="08:00"
                      value={doctorForm.shift_start}
                      onChange={(e) => setDoctorForm({ ...doctorForm, shift_start: e.target.value })}
                      className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">Shift End</label>
                    <input
                      type="text"
                      placeholder="16:00"
                      value={doctorForm.shift_end}
                      onChange={(e) => setDoctorForm({ ...doctorForm, shift_end: e.target.value })}
                      className="w-full px-2 py-2 bg-slate-50 border border-slate-200 rounded font-mono"
                    />
                  </div>
                </div>

                <div className="col-span-2">
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Working Days</label>
                  <div className="flex flex-wrap gap-1.5">
                    {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((day) => {
                      const isSel = (doctorForm.working_days || []).includes(day);
                      return (
                        <button
                          type="button"
                          key={day}
                          onClick={() => {
                            const cur = doctorForm.working_days || [];
                            const upd = isSel ? cur.filter((d) => d !== day) : [...cur, day];
                            setDoctorForm({ ...doctorForm, working_days: upd });
                          }}
                          className={`text-xs px-2.5 py-1 rounded font-bold border ${
                            isSel
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                          }`}
                        >
                          {day}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Initial Status</label>
                  <select
                    value={doctorForm.status}
                    onChange={(e) => setDoctorForm({ ...doctorForm, status: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded font-semibold"
                  >
                    <option value="AVAILABLE">Available</option>
                    <option value="BUSY">Busy</option>
                    <option value="OFF_DUTY">Off Duty</option>
                    <option value="ON_LEAVE">On Leave</option>
                    <option value="UNAVAILABLE">Unavailable</option>
                  </select>
                </div>

                <div className="flex items-center gap-2 pt-6">
                  <input
                    type="checkbox"
                    id="emergCov"
                    checked={doctorForm.emergency_coverage}
                    onChange={(e) => setDoctorForm({ ...doctorForm, emergency_coverage: e.target.checked })}
                    className="rounded text-blue-600"
                  />
                  <label htmlFor="emergCov" className="text-xs font-semibold text-slate-800">
                    Emergency Coverage Eligible
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddDoctorModalOpen(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-50 font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg shadow-sm"
                >
                  {editingDoctor ? "Save Changes" : "Add to Roster"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 2. REJECT / DIVERT MODAL */}
      {rejectModalDispatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-sm font-bold text-red-700 flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-red-600" /> Reject / Divert Emergency Request
              </h3>
              <button onClick={() => setRejectModalDispatch(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600">
              Rejecting incident #{rejectModalDispatch.incident_id} releases this hospital's provisional reservation and
              triggers regional escalation to reassign to the next suitable medical facility.
            </p>

            <div className="space-y-2 text-xs">
              <label className="font-bold text-slate-700 block">Select Rejection / Divert Reason:</label>
              <select
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded font-medium text-slate-800"
              >
                <option value="Emergency Department Divert / Capacity Exhausted">
                  Emergency Department Divert / Capacity Exhausted
                </option>
                <option value="No Intensive Care Beds Available (ICU Full)">
                  No Intensive Care Beds Available (ICU Full)
                </option>
                <option value="Specialist Clinical Staff Unavailable for Target Trauma">
                  Specialist Clinical Staff Unavailable for Target Trauma
                </option>
                <option value="Diagnostic CT / Cath Lab Equipment Maintenance">
                  Diagnostic CT / Cath Lab Equipment Maintenance
                </option>
                <option value="Mass Casualty Internal Disaster Protocol Active">
                  Mass Casualty Internal Disaster Protocol Active
                </option>
              </select>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setRejectModalDispatch(null)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDecideReservation(rejectModalDispatch.id, "REJECTED", rejectionReason)}
                disabled={actionLoading}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-bold shadow-sm"
              >
                Confirm Divert & Release
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. SBAR HANDOVER WORKSPACE MODAL */}
      {activeHandoverModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-600" />
                <h3 className="text-sm font-bold text-slate-900">
                  Clinical SBAR Handover • Dispatch #{activeHandoverModal.dispatch_id}
                </h3>
              </div>
              <button onClick={() => setActiveHandoverModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              {/* Handover State & Mission Context Indicators */}
              <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-blue-900">Handover State:</span>
                    <span className="font-mono font-bold text-blue-700 uppercase">
                      {activeHandoverModal.status || "SENT"}
                    </span>
                  </div>
                  {activeHandoverModal.acknowledged_at && (
                    <span className="text-[11px] text-blue-800 font-medium">
                      Ack: {new Date(activeHandoverModal.acknowledged_at).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* Identification & Status Chips */}
                <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-blue-200/60 text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-white text-slate-700 border border-blue-200 font-mono font-semibold">
                    Incident #{activeHandoverModal.incident_id}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-white text-slate-700 border border-blue-200 font-mono font-semibold">
                    Dispatch #{activeHandoverModal.dispatch_id}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-white text-blue-700 border border-blue-200 font-bold">
                    Unit: {activeHandoverModal.ambulance_call_sign || "ALS Unit"}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-900 font-bold uppercase">
                    Mission: {activeHandoverModal.mission_status || "EN_ROUTE_HOSPITAL"}
                  </span>
                  {activeHandoverModal.incident_status && (
                    <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium uppercase">
                      Incident: {activeHandoverModal.incident_status}
                    </span>
                  )}
                </div>
              </div>

              {/* PRE-HOSPITAL CLINICAL VITALS TELEMETRY SECTION */}
              <div className="p-3.5 bg-rose-50/50 border border-rose-200 rounded-lg space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded bg-rose-100 text-rose-700 flex items-center justify-center">
                      <Activity className="w-3.5 h-3.5" />
                    </div>
                    <h4 className="font-bold text-slate-900 text-xs">Pre-Hospital Patient Vitals Telemetry</h4>
                  </div>

                  {activeHandoverModal.vitals && activeHandoverModal.vitals.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setShowModalVitalsHistory(!showModalVitalsHistory)}
                      className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1"
                    >
                      <span>{showModalVitalsHistory ? "Hide Vitals Log" : `View All (${activeHandoverModal.vitals.length})`}</span>
                      {showModalVitalsHistory ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                  )}
                </div>

                {activeHandoverModal.latest_vitals ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                      {/* HR */}
                      <div className="bg-white p-2 rounded-lg border border-rose-200">
                        <div className="flex items-center justify-center gap-1 text-rose-700 text-[10px] font-bold">
                          <Heart className="w-3 h-3" />
                          <span>Heart Rate</span>
                        </div>
                        <span className="font-mono font-black text-rose-950 text-base block mt-0.5">
                          {activeHandoverModal.latest_vitals.heart_rate}
                        </span>
                        <span className="text-[10px] text-rose-600 font-medium">bpm</span>
                      </div>

                      {/* BP */}
                      <div className="bg-white p-2 rounded-lg border border-indigo-200">
                        <div className="flex items-center justify-center gap-1 text-indigo-700 text-[10px] font-bold">
                          <Droplet className="w-3 h-3" />
                          <span>Blood Pressure</span>
                        </div>
                        <span className="font-mono font-black text-indigo-950 text-base block mt-0.5">
                          {activeHandoverModal.latest_vitals.blood_pressure_systolic}/{activeHandoverModal.latest_vitals.blood_pressure_diastolic}
                        </span>
                        <span className="text-[10px] text-indigo-600 font-medium">mmHg</span>
                      </div>

                      {/* SpO2 */}
                      <div className="bg-white p-2 rounded-lg border border-sky-200">
                        <div className="flex items-center justify-center gap-1 text-sky-700 text-[10px] font-bold">
                          <Wind className="w-3 h-3" />
                          <span>Oxygen (SpO2)</span>
                        </div>
                        <span className="font-mono font-black text-sky-950 text-base block mt-0.5">
                          {activeHandoverModal.latest_vitals.oxygen_saturation}%
                        </span>
                        <span className="text-[10px] text-sky-600 font-medium">sat</span>
                      </div>

                      {/* RR */}
                      <div className="bg-white p-2 rounded-lg border border-emerald-200">
                        <div className="flex items-center justify-center gap-1 text-emerald-700 text-[10px] font-bold">
                          <Activity className="w-3 h-3" />
                          <span>Resp. Rate</span>
                        </div>
                        <span className="font-mono font-black text-emerald-950 text-base block mt-0.5">
                          {activeHandoverModal.latest_vitals.respiratory_rate}
                        </span>
                        <span className="text-[10px] text-emerald-600 font-medium">/min</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between text-[11px] text-slate-500 pt-1">
                      <span>Recorded at: <strong>{new Date(activeHandoverModal.latest_vitals.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong></span>
                      {activeHandoverModal.latest_vitals.notes && (
                        <span className="italic text-slate-700 bg-white/80 px-2 py-0.5 rounded border border-rose-100">
                          &ldquo;{activeHandoverModal.latest_vitals.notes}&rdquo;
                        </span>
                      )}
                    </div>

                    {/* Expandable Vitals Timeline */}
                    {showModalVitalsHistory && activeHandoverModal.vitals && activeHandoverModal.vitals.length > 1 && (
                      <div className="border border-slate-200 rounded-lg overflow-hidden bg-white mt-2">
                        <div className="px-2.5 py-1.5 bg-slate-50 border-b border-slate-200 font-bold text-[10px] text-slate-600 uppercase">
                          Pre-Hospital Vitals History ({activeHandoverModal.vitals.length} records)
                        </div>
                        <div className="overflow-x-auto max-h-36">
                          <table className="w-full text-left text-xs">
                            <thead className="bg-slate-50 text-[10px] text-slate-500 font-mono uppercase border-b border-slate-200">
                              <tr>
                                <th className="py-1.5 px-2">Time</th>
                                <th className="py-1.5 px-2">HR</th>
                                <th className="py-1.5 px-2">BP</th>
                                <th className="py-1.5 px-2">SpO2</th>
                                <th className="py-1.5 px-2">RR</th>
                                <th className="py-1.5 px-2">Notes</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                              {activeHandoverModal.vitals.map((v: VitalsRecord) => (
                                <tr key={v.id} className="hover:bg-slate-50">
                                  <td className="py-1 px-2 font-mono text-[11px] text-slate-600">
                                    {new Date(v.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  </td>
                                  <td className="py-1 px-2 font-mono font-bold text-rose-700">{v.heart_rate}</td>
                                  <td className="py-1 px-2 font-mono font-semibold text-indigo-700">{v.blood_pressure_systolic}/{v.blood_pressure_diastolic}</td>
                                  <td className="py-1 px-2 font-mono font-semibold text-sky-700">{v.oxygen_saturation}%</td>
                                  <td className="py-1 px-2 font-mono text-emerald-700">{v.respiratory_rate}</td>
                                  <td className="py-1 px-2 text-slate-600 truncate max-w-xs">{v.notes || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-3 bg-white rounded-lg border border-dashed border-rose-200 text-center text-slate-500 text-xs">
                    Ambulance crew has not yet recorded field vitals telemetry. Live readings will appear here once saved.
                  </div>
                )}
              </div>

              {/* SBAR Sections */}
              <div className="space-y-3">
                {/* S - Situation */}
                <div className="p-3 bg-slate-50 border-l-4 border-blue-600 rounded">
                  <h4 className="font-bold text-slate-900 mb-1">S — Situation</h4>
                  <p className="text-slate-700">
                    Chief Complaint: <strong>{activeHandoverModal.chief_complaint}</strong>
                  </p>
                  <p className="text-slate-500 text-[11px] mt-0.5">
                    Priority: {activeHandoverModal.triage_priority} • Unit: {activeHandoverModal.ambulance_call_sign}
                  </p>
                </div>

                {/* B - Background */}
                <div className="p-3 bg-slate-50 border-l-4 border-purple-600 rounded">
                  <h4 className="font-bold text-slate-900 mb-1">B — Background</h4>
                  <p className="text-slate-700">
                    Patient: {activeHandoverModal.patient_age ?? "Unknown"}y / {activeHandoverModal.patient_gender ?? "Unknown"}
                  </p>
                  <p className="text-slate-600 text-[11px] mt-0.5">
                    Location: {activeHandoverModal.incident_address || "Scene location recorded"}
                  </p>
                </div>

                {/* A - Assessment */}
                <div className="p-3 bg-slate-50 border-l-4 border-amber-500 rounded">
                  <h4 className="font-bold text-slate-900 mb-1">A — Assessment</h4>
                  <p className="text-slate-700">
                    Reported Symptoms: {(activeHandoverModal.reported_symptoms || []).join(", ") || "Stable vital parameters"}
                  </p>
                  {activeHandoverModal.triage_justifications?.length > 0 && (
                    <p className="text-slate-500 text-[11px] mt-0.5">
                      Clinical Justifications: {activeHandoverModal.triage_justifications.join(" • ")}
                    </p>
                  )}
                </div>

                {/* R - Recommendation */}
                <div className="p-3 bg-slate-50 border-l-4 border-emerald-600 rounded">
                  <h4 className="font-bold text-slate-900 mb-1">R — Recommendation</h4>
                  <p className="text-slate-700">
                    Immediate trauma reception bay assignment and specialist consultation standby.
                  </p>
                </div>
              </div>

              {/* Receiving Clinician Input & Notes */}
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">Receiving Clinician Name</label>
                    <input
                      type="text"
                      value={handoverClinicianName}
                      onChange={(e) => setHandoverClinicianName(e.target.value)}
                      className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded font-semibold text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">Signed Off By</label>
                    <input
                      type="text"
                      disabled
                      value={activeHandoverModal.acknowledged_by || activeHandoverModal.receiving_clinician || "Pending sign-off"}
                      className="w-full px-2.5 py-1.5 bg-slate-100 border border-slate-200 rounded font-mono text-slate-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">Clinical Receiving Notes</label>
                  <textarea
                    rows={2}
                    placeholder="Enter intake orders, trauma bay assignments, or clinical instructions..."
                    value={handoverNotesInput}
                    onChange={(e) => setHandoverNotesInput(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded text-slate-900"
                  />
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 bg-slate-50">
              <button
                type="button"
                onClick={() => setActiveHandoverModal(null)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-100"
              >
                Close
              </button>

              <div className="flex items-center gap-2">
                {(() => {
                  const disp = dispatches.find((d) => d.id === activeHandoverModal.dispatch_id);
                  const isArrived = disp?.status === "AT_HOSPITAL" || !!disp?.patient_arrived_hospital_confirmed_at;
                  return (
                    <button
                      type="button"
                      onClick={async () => {
                        await handleConfirmArrival(activeHandoverModal.dispatch_id);
                        await handleOpenHandover(activeHandoverModal.dispatch_id);
                      }}
                      disabled={actionLoading || isArrived}
                      className={`px-3 py-2 rounded-lg text-xs font-bold shadow-xs flex items-center gap-1.5 transition ${
                        isArrived
                          ? "bg-emerald-50 text-emerald-800 border border-emerald-300 cursor-default"
                          : "bg-emerald-600 hover:bg-emerald-700 text-white"
                      }`}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{isArrived ? "Arrival Confirmed ✓" : "Confirm ER Arrival"}</span>
                    </button>
                  );
                })()}

                <button
                  type="button"
                  onClick={() => handleReviewHandover(activeHandoverModal.dispatch_id)}
                  disabled={actionLoading}
                  className="px-3 py-2 bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs font-bold rounded-lg"
                >
                  Mark Reviewed
                </button>
                <button
                  type="button"
                  onClick={() => handleAcknowledgeHandover(activeHandoverModal.dispatch_id)}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold rounded-lg shadow-sm"
                >
                  Acknowledge Intake
                </button>
                <button
                  type="button"
                  onClick={() => handleCompleteHandover(activeHandoverModal.dispatch_id)}
                  disabled={actionLoading}
                  className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg shadow-sm"
                >
                  Sign Off & Complete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. INCIDENT DETAILS MODAL */}
      {selectedIncidentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-sm font-bold text-slate-900">
                Incident #{selectedIncidentModal.incident_id} Full Clinical Details
              </h3>
              <button onClick={() => setSelectedIncidentModal(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-500">Triage Priority:</span>
                <span
                  className={`font-bold px-2 py-0.5 rounded ${
                    selectedIncidentModal.incident?.triage_color === "RED"
                      ? "bg-red-100 text-red-800"
                      : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {selectedIncidentModal.incident?.triage_level || "Priority 1"}
                </span>
              </div>

              <div>
                <span className="font-semibold text-slate-500 block mb-0.5">Chief Complaint:</span>
                <p className="font-bold text-slate-900 bg-slate-50 p-2 rounded">
                  {selectedIncidentModal.incident?.chief_complaint}
                </p>
              </div>

              <div>
                <span className="font-semibold text-slate-500 block mb-0.5">Location:</span>
                <p className="text-slate-700">{selectedIncidentModal.incident?.location_address}</p>
              </div>

              <div className="grid grid-cols-2 gap-2 p-2.5 bg-slate-50 rounded">
                <div>
                  <span className="text-slate-500 block text-[10px]">Patient Age / Gender</span>
                  <span className="font-bold text-slate-800">
                    {selectedIncidentModal.incident?.patient_age ?? "Unknown"}y /{" "}
                    {selectedIncidentModal.incident?.patient_gender ?? "Unknown"}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px]">Consciousness Level</span>
                  <span className="font-bold text-slate-800">
                    {selectedIncidentModal.incident?.consciousness_level || "Alert"}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px]">Breathing Status</span>
                  <span className="font-bold text-slate-800">
                    {selectedIncidentModal.incident?.breathing_status || "Normal"}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px]">Ambulance Call Sign</span>
                  <span className="font-bold text-slate-800">
                    {selectedIncidentModal.ambulance_call_sign || `#${selectedIncidentModal.ambulance_id}`}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setSelectedIncidentModal(null)}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-slate-800"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. EDIT DEPARTMENT MODAL */}
      {editingDepartment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
              <h3 className="text-sm font-bold text-slate-900">Edit Department: {editingDepartment.name}</h3>
              <button onClick={() => setEditingDepartment(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Operational Status</label>
                <select
                  value={editingDepartment.operational_status}
                  onChange={(e) => setEditingDepartment({ ...editingDepartment, operational_status: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded font-semibold text-slate-800"
                >
                  <option value="ACTIVE">ACTIVE (Full Emergency Operation)</option>
                  <option value="LIMITED">LIMITED (Partial Capacity / Restrictions)</option>
                  <option value="TEMPORARILY_CLOSED">TEMPORARILY_CLOSED (Divert / Maintenance)</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Operating Hours</label>
                <input
                  type="text"
                  value={editingDepartment.operating_hours}
                  onChange={(e) => setEditingDepartment({ ...editingDepartment, operating_hours: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="deptEmerg"
                  checked={editingDepartment.emergency_coverage}
                  onChange={(e) => setEditingDepartment({ ...editingDepartment, emergency_coverage: e.target.checked })}
                  className="rounded text-blue-600"
                />
                <label htmlFor="deptEmerg" className="text-xs font-semibold text-slate-800">
                  Active in Ambulance Routing Algorithm
                </label>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Operational Notes / Restrictions</label>
                <textarea
                  rows={2}
                  value={editingDepartment.notes || ""}
                  onChange={(e) => setEditingDepartment({ ...editingDepartment, notes: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setEditingDepartment(null)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  handleUpdateDepartment(editingDepartment.id, {
                    operational_status: editingDepartment.operational_status,
                    operating_hours: editingDepartment.operating_hours,
                    emergency_coverage: editingDepartment.emergency_coverage,
                    notes: editingDepartment.notes,
                  })
                }
                disabled={actionLoading}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold"
              >
                Save Department
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
