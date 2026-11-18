"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Ambulance,
  Bed,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  History,
  LayoutDashboard,
  LogOut,
  Minus,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Stethoscope,
  Trash2,
  User,
  UserCheck,
  UserPlus,
  Users,
  X,
  Phone,
  Flame,
  HeartPulse,
  Syringe,
  Wind,
} from "lucide-react";
import Sidebar, { NavItem } from "@/components/layout/Sidebar";
import TopNav from "@/components/layout/TopNav";
import { formatDistance, formatDuration } from "@/lib/utils";

interface Doctor {
  id: string;
  name: string;
  specialty: string;
  department: string;
  status: "AVAILABLE" | "BUSY" | "ON_LEAVE" | "UNAVAILABLE" | string;
  shift: string;
  contact_number?: string;
  last_updated?: string;
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
  incident?: {
    id: number;
    caller_name: string;
    caller_phone: string;
    location_address: string;
    chief_complaint: string;
    triage_level: string;
    triage_color: string;
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
}

export default function HospitalPortalPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [hospital, setHospital] = useState<any>(null);
  const [dispatches, setDispatches] = useState<DispatchRecord[]>([]);
  const [crashAlerts, setCrashAlerts] = useState<CrashAlertRecord[]>([]);
  const [currentNav, setCurrentNav] = useState<string>("overview");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [wsConnected, setWsConnected] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

  // SBAR Handover modal & clinician input
  const [activeHandoverPacket, setActiveHandoverPacket] = useState<any | null>(null);
  const [clinicianName, setClinicianName] = useState("");

  // Reservation countdown state
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // Doctor Management local state
  const [doctorSearch, setDoctorSearch] = useState("");
  const [doctorDepartmentFilter, setDoctorDepartmentFilter] = useState("ALL");
  const [isAddDoctorModalOpen, setIsAddDoctorModalOpen] = useState(false);
  const [newDoctor, setNewDoctor] = useState({
    name: "",
    specialty: "Emergency Medicine",
    department: "Emergency Department",
    shift: "Morning (08:00 - 16:00)",
    status: "AVAILABLE",
    contact_number: "+91 824 2444591",
  });

  // Ward & Bed Management local form state
  const [bedsForm, setBedsForm] = useState({
    total_emergency_beds: 10,
    occupied_emergency_beds: 3,
    total_icu_beds: 12,
    occupied_icu_beds: 4,
    total_ward_beds: 60,
    occupied_ward_beds: 35,
    total_pediatric_beds: 8,
    occupied_pediatric_beds: 2,
  });
  const [bedFormError, setBedFormError] = useState<string | null>(null);

  // Hospital Readiness local form state
  const [readinessForm, setReadinessForm] = useState({
    readiness_status: "READY",
    oxygen_status: "NORMAL",
    ventilators_total: 10,
    ventilators_available: 7,
    blood_bank: {
      prbc_units: 35,
      o_neg_emergency_units: 12,
      platelets_units: 18,
      plasma_units: 20,
    },
    equipment: {
      ct_scanner: "READY",
      mri: "READY",
      cath_lab: "READY",
      trauma_resuscitation_bay: "READY",
      decontamination_unit: "READY",
    },
    emergency_contact_person: "Dr. K. Kamath (Chief Medical Officer)",
    emergency_contact_phone: "+91 824 2444591",
  });

  // Crash Alert Response note local input
  const [crashNoteInput, setCrashNoteInput] = useState<{ [alertId: number]: string }>({});

  // Preparation Workflow note local input
  const [prepNoteInput, setPrepNoteInput] = useState<{ [dispatchId: number]: string }>({});

  const isActionInProgressRef = useRef(false);
  const processedEventsRef = useRef<Set<string>>(new Set());
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Synchronize local form states when hospital record updates
  useEffect(() => {
    if (hospital) {
      setBedsForm({
        total_emergency_beds: hospital.total_emergency_beds ?? 10,
        occupied_emergency_beds: hospital.occupied_emergency_beds ?? 0,
        total_icu_beds: hospital.total_icu_beds ?? 8,
        occupied_icu_beds: hospital.occupied_icu_beds ?? 0,
        total_ward_beds: hospital.total_ward_beds ?? 40,
        occupied_ward_beds: hospital.occupied_ward_beds ?? 0,
        total_pediatric_beds: hospital.pediatric_beds_total ?? 6,
        occupied_pediatric_beds: hospital.occupied_pediatric_beds ?? 0,
      });

      setReadinessForm({
        readiness_status: hospital.readiness_status || "READY",
        oxygen_status: hospital.oxygen_status || "NORMAL",
        ventilators_total: hospital.ventilators_total ?? 8,
        ventilators_available: hospital.ventilators_available ?? 5,
        blood_bank: {
          prbc_units: hospital.blood_bank_status?.prbc_units ?? 30,
          o_neg_emergency_units: hospital.blood_bank_status?.o_neg_emergency_units ?? 10,
          platelets_units: hospital.blood_bank_status?.platelets_units ?? 15,
          plasma_units: hospital.blood_bank_status?.plasma_units ?? 15,
        },
        equipment: {
          ct_scanner: hospital.equipment_readiness?.ct_scanner || "READY",
          mri: hospital.equipment_readiness?.mri || "READY",
          cath_lab: hospital.equipment_readiness?.cath_lab || "READY",
          trauma_resuscitation_bay: hospital.equipment_readiness?.trauma_resuscitation_bay || "READY",
          decontamination_unit: hospital.equipment_readiness?.decontamination_unit || "READY",
        },
        emergency_contact_person: hospital.emergency_contact_person || hospital.contact_phone || "ER Desk",
        emergency_contact_phone: hospital.contact_phone || "+91 824 2444591",
      });
    }
  }, [hospital]);

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
      if (!clinicianName) setClinicianName(userData.full_name || "ER Triage Officer");

      if (userData.hospital_id) {
        const hospResp = await fetch(`${backendUrl}/api/hospitals/${userData.hospital_id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (hospResp.ok) {
          setHospital(await hospResp.json());
        }

        // Fetch hospital-isolated allocated dispatches
        const dispResp = await fetch(`${backendUrl}/api/hospitals/${userData.hospital_id}/allocated-incidents`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (dispResp.ok) {
          setDispatches(await dispResp.json());
        } else {
          // Fallback to scoped /api/dispatch
          const allDispResp = await fetch(`${backendUrl}/api/dispatch`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (allDispResp.ok) {
            const list: DispatchRecord[] = await allDispResp.json();
            setDispatches(list.filter((d) => d.destination_hospital_id === userData.hospital_id));
          }
        }

        // Fetch hospital-isolated crash alerts
        const crashResp = await fetch(`${backendUrl}/api/crash-alerts`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (crashResp.ok) {
          setCrashAlerts(await crashResp.json());
        }
      }
    } catch (err: any) {
      console.warn("Hospital data fetch error:", err);
    } finally {
      setIsLoading(false);
    }
  }, [backendUrl, router, clinicianName]);

  // WebSocket Subscription
  useEffect(() => {
    fetchHospitalData();

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

            if (data.event === "DISPATCH_PROVISIONAL_RESERVATION") {
              setFeedbackMsg({ text: "URGENT: Inbound patient bed reservation request received!", type: "info" });
              fetchHospitalData();
            } else if (data.event === "AMBULANCE_CRASH_DETECTED") {
              setFeedbackMsg({
                text: `CRITICAL ALERT: Ambulance crash detected for unit ${data.payload?.ambulance_call_sign || "assigned to this hospital"}!`,
                type: "error",
              });
              fetchHospitalData();
            } else if (data.event === "CRASH_ALERT_UPDATED") {
              fetchHospitalData();
            } else if (data.event === "HOSPITAL_CAPACITY_UPDATED" || data.event === "HOSPITAL_DOCTOR_UPDATED") {
              fetchHospitalData();
            } else if (
              data.event === "DISPATCH_CONFIRMATION_UPDATED" ||
              data.event === "DISPATCH_CONFIRMED" ||
              data.event === "DISPATCH_LIFECYCLE_STEPPED" ||
              data.event === "HOSPITAL_PREPARATION_UPDATED" ||
              data.event === "PATIENT_ARRIVED_HOSPITAL" ||
              data.event === "HANDOVER_ACKNOWLEDGED" ||
              data.event === "DISPATCH_ESCALATED" ||
              data.event === "DISPATCH_EXPIRED"
            ) {
              fetchHospitalData();
            }
          } catch (_) {}
        };
      } catch (_) {}
    }

    connect();

    return () => {
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) ws.close();
    };
  }, [backendUrl, fetchHospitalData]);

  // Filtered dispatches
  const pendingDispatch = dispatches.find(
    (d) => d.coordination_status === "PENDING_CONFIRMATIONS" && d.hospital_confirmation_status === "PENDING"
  );

  const activeInboundDispatches = dispatches.filter(
    (d) => d.coordination_status === "CONFIRMED" && d.status !== "COMPLETED" && d.status !== "CANCELLED"
  );

  const completedDispatches = dispatches.filter((d) => d.status === "COMPLETED");
  const unacknowledgedCrashAlerts = crashAlerts.filter((c) => c.status === "TRIGGERED");

  // Reservation countdown timer
  useEffect(() => {
    if (!pendingDispatch?.reservation_expires_at) {
      setRemainingSeconds(null);
      return;
    }

    const updateTimer = () => {
      const expMs = new Date(pendingDispatch.reservation_expires_at!).getTime();
      const nowMs = Date.now();
      const diffSec = Math.max(0, Math.floor((expMs - nowMs) / 1000));
      setRemainingSeconds(diffSec);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [pendingDispatch]);

  // Dual confirmation decision
  const handleDecideReservation = async (dispatchId: number, decision: "ACCEPTED" | "REJECTED") => {
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/confirm-hospital`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          decision,
          rejection_reason: decision === "REJECTED" ? "Emergency Department Divert / Capacity Exhausted" : undefined,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `Failed to record decision (${resp.status})`);
      }

      setFeedbackMsg({
        text: `Hospital bed reservation #${dispatchId} successfully ${decision.toLowerCase()}!`,
        type: decision === "ACCEPTED" ? "success" : "info",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Bed confirmation error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  // Preparation status update
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
          acknowledged_by: user?.full_name || clinicianName,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to update hospital preparation");
      }

      setFeedbackMsg({
        text: `Emergency team preparation status advanced to '${prepStatus}'! Synchronized across network.`,
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

  // Confirm Patient Arrival at ER Bay
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
        text: `Patient arrival confirmed at Emergency Bay! Received into hospital care.`,
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

  // SBAR Handover modal open
  const handleInspectHandover = async (dispatchId: number) => {
    const token = localStorage.getItem("lifelink_token");
    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${dispatchId}/handover`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        setActiveHandoverPacket(await resp.json());
      }
    } catch (_) {}
  };

  // Acknowledge clinical handover
  const handleAcknowledgeHandover = async () => {
    if (!activeHandoverPacket?.dispatch_id) return;
    if (isActionInProgressRef.current) return;
    isActionInProgressRef.current = true;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/dispatch/${activeHandoverPacket.dispatch_id}/handover/acknowledge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ acknowledged_by: clinicianName }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to acknowledge handover");
      }

      const updated = await resp.json();
      setActiveHandoverPacket(updated);
      setFeedbackMsg({
        text: `Clinical handover for Dispatch #${activeHandoverPacket.dispatch_id} acknowledged by ${clinicianName}!`,
        type: "success",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Acknowledgment error: ${err.message}`, type: "error" });
    } finally {
      isActionInProgressRef.current = false;
      setActionLoading(false);
    }
  };

  // Doctor Management: Add Doctor
  const handleAddDoctor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hospital?.id) return;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/doctors`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(newDoctor),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to add doctor");
      }

      setIsAddDoctorModalOpen(false);
      setFeedbackMsg({
        text: `Dr. ${newDoctor.name} successfully registered to ${newDoctor.department}!`,
        type: "success",
      });
      setNewDoctor({
        name: "",
        specialty: "Emergency Medicine",
        department: "Emergency Department",
        shift: "Morning (08:00 - 16:00)",
        status: "AVAILABLE",
        contact_number: "+91 824 2444591",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Add doctor error: ${err.message}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  // Doctor Management: Update Status
  const handleUpdateDoctorStatus = async (doctorId: string, newStatus: string) => {
    if (!hospital?.id) return;
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/doctors/${doctorId}`, {
        method: "PUT",
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

  // Doctor Management: Delete Doctor
  const handleDeleteDoctor = async (doctorId: string, doctorName: string) => {
    if (!hospital?.id) return;
    if (!confirm(`Are you sure you want to remove Dr. ${doctorName} from this facility?`)) return;
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/doctors/${doctorId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.ok) {
        setFeedbackMsg({ text: `Dr. ${doctorName} removed from facility duty roster.`, type: "info" });
        await fetchHospitalData();
      }
    } catch (_) {}
  };

  // Ward & Bed Management: Save Beds
  const handleSaveBeds = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hospital?.id) return;
    setBedFormError(null);

    // Validation against negative or impossible values (occupied > total)
    if (bedsForm.occupied_emergency_beds > bedsForm.total_emergency_beds) {
      setBedFormError("Occupied ER beds cannot exceed total ER beds.");
      return;
    }
    if (bedsForm.occupied_icu_beds > bedsForm.total_icu_beds) {
      setBedFormError("Occupied ICU beds cannot exceed total ICU beds.");
      return;
    }
    if (bedsForm.occupied_ward_beds > bedsForm.total_ward_beds) {
      setBedFormError("Occupied ward beds cannot exceed total ward beds.");
      return;
    }
    if (bedsForm.occupied_pediatric_beds > bedsForm.total_pediatric_beds) {
      setBedFormError("Occupied pediatric beds cannot exceed total pediatric beds.");
      return;
    }

    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/beds`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(bedsForm),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to update bed capacity");
      }

      setFeedbackMsg({
        text: "Ward & Bed availability successfully updated and synchronized across regional network!",
        type: "success",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setBedFormError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // Hospital Readiness: Save Readiness
  const handleSaveReadiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hospital?.id) return;
    setActionLoading(true);
    const token = localStorage.getItem("lifelink_token");

    try {
      const resp = await fetch(`${backendUrl}/api/hospitals/${hospital.id}/readiness`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          readiness_status: readinessForm.readiness_status,
          oxygen_status: readinessForm.oxygen_status,
          ventilators_total: Number(readinessForm.ventilators_total),
          ventilators_available: Number(readinessForm.ventilators_available),
          blood_bank: readinessForm.blood_bank,
          equipment_readiness: readinessForm.equipment,
          emergency_contact_person: readinessForm.emergency_contact_person,
          emergency_contact_phone: readinessForm.emergency_contact_phone,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to update facility readiness");
      }

      setFeedbackMsg({
        text: `Hospital readiness and critical equipment telemetry updated to '${readinessForm.readiness_status}'!`,
        type: "success",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Readiness update error: ${err.message}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  // Crash Alert: DEMO Simulation
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

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to simulate crash alert");
      }

      const alert = await resp.json();
      setFeedbackMsg({
        text: `CRASH ALERT SIMULATED: Unit ${alert.ambulance_call_sign || `#${alert.ambulance_id}`} reported critical collision!`,
        type: "error",
      });
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Simulation error: ${err.message}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  // Crash Alert: Hospital Response Update
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
          acknowledged_by: user?.full_name || clinicianName,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to record crash response");
      }

      setFeedbackMsg({
        text: `Crash Alert #${alertId} response status updated to '${status}'.`,
        type: "success",
      });
      setCrashNoteInput((prev) => ({ ...prev, [alertId]: "" }));
      await fetchHospitalData();
    } catch (err: any) {
      setFeedbackMsg({ text: `Crash response error: ${err.message}`, type: "error" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("lifelink_token");
    localStorage.removeItem("lifelink_user");
    router.push("/login");
  };

  const doctorsList: Doctor[] = hospital?.doctors_availability || [];
  const filteredDoctors = doctorsList.filter((doc) => {
    const matchesSearch =
      doc.name.toLowerCase().includes(doctorSearch.toLowerCase()) ||
      doc.specialty.toLowerCase().includes(doctorSearch.toLowerCase());
    const matchesDept = doctorDepartmentFilter === "ALL" || doc.department === doctorDepartmentFilter;
    return matchesSearch && matchesDept;
  });

  const uniqueDepartments = Array.from(new Set(doctorsList.map((d) => d.department))).filter(Boolean);

  // 8 Required Sidebar Navigation Items
  const sidebarNavItems: NavItem[] = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "emergencies", label: "Incoming Emergencies", icon: Ambulance, count: activeInboundDispatches.length },
    {
      id: "doctors",
      label: "Doctor Management",
      icon: Stethoscope,
      count: doctorsList.filter((d) => d.status === "AVAILABLE").length,
    },
    { id: "beds", label: "Ward & Bed Availability", icon: Bed },
    { id: "readiness", label: "Hospital Readiness", icon: Activity },
    {
      id: "crashes",
      label: "Crash Alerts",
      icon: AlertTriangle,
      count: unacknowledgedCrashAlerts.length > 0 ? unacknowledgedCrashAlerts.length : undefined,
    },
    { id: "history", label: "Incident History", icon: History, count: completedDispatches.length },
    { id: "profile", label: "Hospital Profile", icon: Building2 },
  ];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-4 font-sans">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-8 h-8 animate-spin text-emerald-600" />
          <span className="text-xs font-bold text-slate-700">Connecting to Hospital ER Console...</span>
        </div>
      </div>
    );
  }

  const currentReadiness = hospital?.readiness_status || "READY";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex font-sans">
      {/* 1. LEFT SIDEBAR */}
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
        entityName={hospital?.name || "Mangaluru Hospital"}
      />

      {/* 2. MAIN APPLICATION CONTENT AREA */}
      <div className="flex-1 md:pl-64 flex flex-col min-w-0">
        {/* Top Minimal Navigation */}
        <TopNav
          title={hospital?.name || "Hospital ER Console"}
          subtitle={`Facility Code: ${hospital?.facility_code || "KMC-AMB-01"} • ${hospital?.address || "Mangaluru"} [DEMO DATA]`}
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
                title="Refresh Console"
                className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
              </button>
            </div>
          }
        />

        {/* Global Feedback Banner */}
        {feedbackMsg && (
          <div
            className={`mx-4 sm:mx-6 mt-4 p-3 rounded-xl border text-xs font-medium flex items-center justify-between ${
              feedbackMsg.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : feedbackMsg.type === "error"
                ? "bg-red-50 border-red-200 text-red-800"
                : "bg-blue-50 border-blue-200 text-blue-800"
            }`}
          >
            <div className="flex items-center gap-2">
              {feedbackMsg.type === "success" ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : feedbackMsg.type === "error" ? (
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
              ) : (
                <Sparkles className="w-4 h-4 text-blue-600 shrink-0" />
              )}
              <span>{feedbackMsg.text}</span>
            </div>
            <button
              onClick={() => setFeedbackMsg(null)}
              className="text-slate-400 hover:text-slate-600 p-0.5"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* MAIN BODY PER CURRENT NAV */}
        <main className="p-4 sm:p-6 max-w-7xl w-full mx-auto space-y-6">
          {/* URGENT PENDING RESERVATION CARD (Always visible on Overview & Emergencies) */}
          {pendingDispatch && (currentNav === "overview" || currentNav === "emergencies") && (
            <div className="bg-red-50/70 border-2 border-red-500 rounded-2xl p-5 shadow-sm space-y-4 animate-in fade-in">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-red-600 text-white flex items-center justify-center font-black animate-pulse">
                    <Radio className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black uppercase tracking-wider text-red-700">
                        Priority Bed Reservation Request
                      </span>
                      <span className="text-[10px] bg-red-100 text-red-800 font-bold px-1.5 py-0.5 rounded">
                        Dispatch #{pendingDispatch.id} • Attempt {pendingDispatch.attempt_number}
                      </span>
                    </div>
                    <h2 className="text-base font-extrabold text-slate-900 mt-0.5">
                      Incoming Unit: {pendingDispatch.ambulance_call_sign || "ALS Unit"}
                    </h2>
                  </div>
                </div>

                {remainingSeconds !== null && (
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-red-200 shadow-2xs font-mono text-xs">
                    <Clock className="w-4 h-4 text-red-600 animate-spin" />
                    <span className="text-slate-500">Auto-Escalates in:</span>
                    <strong className="text-red-700 text-sm font-black">{remainingSeconds}s</strong>
                  </div>
                )}
              </div>

              {pendingDispatch.incident && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs bg-white/80 p-3.5 rounded-xl border border-red-200/60">
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">Chief Complaint</span>
                    <p className="font-bold text-slate-900">{pendingDispatch.incident.chief_complaint}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">Triage Priority</span>
                    <p className="font-bold text-red-600">{pendingDispatch.incident.triage_level}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">Incident Location</span>
                    <p className="font-medium text-slate-700 truncate">{pendingDispatch.incident.location_address}</p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  onClick={() => handleDecideReservation(pendingDispatch.id, "REJECTED")}
                  disabled={actionLoading}
                  className="px-4 py-2 rounded-xl border border-red-300 text-red-700 bg-white hover:bg-red-50 text-xs font-bold transition shadow-2xs"
                >
                  Divert / Reject Bed
                </button>
                <button
                  onClick={() => handleDecideReservation(pendingDispatch.id, "ACCEPTED")}
                  disabled={actionLoading}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-xs flex items-center gap-1.5"
                >
                  <Check className="w-4 h-4" />
                  <span>Accept & Reserve Trauma Bed</span>
                </button>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 1: OVERVIEW */}
          {/* ========================================================================= */}
          {currentNav === "overview" && (
            <div className="space-y-6">
              {/* Quick Metrics Bar */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                      Available Doctors
                    </span>
                    <div className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
                      <Stethoscope className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-2xl font-black text-slate-900">
                      {doctorsList.filter((d) => d.status === "AVAILABLE").length}
                    </span>
                    <span className="text-xs text-slate-500">/ {doctorsList.length} on shift</span>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">Duty roster synchronized</div>
                </div>

                <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                      Emergency Bays
                    </span>
                    <div className="w-7 h-7 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
                      <Bed className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-2xl font-black text-emerald-600">
                      {hospital?.available_emergency_beds ?? 0}
                    </span>
                    <span className="text-xs text-slate-500">
                      / {hospital?.total_emergency_beds ?? 0} total
                    </span>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">
                    {hospital?.occupied_emergency_beds ?? 0} occupied
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                      ICU Beds
                    </span>
                    <div className="w-7 h-7 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center">
                      <HeartPulse className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-2xl font-black text-purple-700">
                      {hospital?.available_icu_beds ?? 0}
                    </span>
                    <span className="text-xs text-slate-500">/ {hospital?.total_icu_beds ?? 0} total</span>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">
                    {hospital?.occupied_icu_beds ?? 0} occupied
                  </div>
                </div>

                <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                      Crash Alerts
                    </span>
                    <div className="w-7 h-7 rounded-lg bg-red-50 text-red-600 flex items-center justify-center">
                      <AlertTriangle className="w-4 h-4" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span
                      className={`text-2xl font-black ${
                        unacknowledgedCrashAlerts.length > 0 ? "text-red-600" : "text-slate-900"
                      }`}
                    >
                      {unacknowledgedCrashAlerts.length}
                    </span>
                    <span className="text-xs text-slate-500">unacknowledged</span>
                  </div>
                  <div className="mt-2 text-[10px] text-slate-400">
                    {crashAlerts.length} total logged
                  </div>
                </div>
              </div>

              {/* Inbound Emergencies Quick List */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Ambulance className="w-4 h-4 text-blue-600" />
                    <h3 className="text-sm font-bold text-slate-900">Active Inbound Transports</h3>
                  </div>
                  <button
                    onClick={() => setCurrentNav("emergencies")}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800 hover:underline"
                  >
                    View All ({activeInboundDispatches.length}) →
                  </button>
                </div>

                {activeInboundDispatches.length === 0 ? (
                  <div className="py-8 text-center text-slate-400 text-xs">
                    No active ambulance transports currently en-route to this facility.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {activeInboundDispatches.map((disp) => (
                      <div
                        key={disp.id}
                        className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                            <Ambulance className="w-3.5 h-3.5 text-blue-600" />
                            {disp.ambulance_call_sign || "Assigned Ambulance"}
                          </span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-bold">
                            {disp.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-700 line-clamp-1">
                          <strong>Patient:</strong> {disp.incident?.chief_complaint || "Emergency Patient"}
                        </p>
                        <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-200">
                          <span>
                            Prep:{" "}
                            <strong className="text-slate-900">
                              {disp.hospital_preparation_status || "NOT_STARTED"}
                            </strong>
                          </span>
                          <button
                            onClick={() => {
                              setCurrentNav("emergencies");
                            }}
                            className="text-blue-600 font-bold hover:underline"
                          >
                            Manage Prep →
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Facility Readiness & Critical Resources Summary */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Activity className="w-4 h-4 text-emerald-600" />
                      Critical Infrastructure Readiness
                    </h3>
                    <button
                      onClick={() => setCurrentNav("readiness")}
                      className="text-xs font-semibold text-blue-600 hover:underline"
                    >
                      Update →
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 text-xs">
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">Oxygen Supply</span>
                      <p className="font-bold text-emerald-700">{hospital?.oxygen_status || "NORMAL"}</p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">Ventilators</span>
                      <p className="font-bold text-slate-900">
                        {hospital?.ventilators_available ?? 5} / {hospital?.ventilators_total ?? 8} available
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">CT Scanner</span>
                      <p className="font-bold text-slate-900">
                        {hospital?.equipment_readiness?.ct_scanner || "READY"}
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">Cath Lab</span>
                      <p className="font-bold text-slate-900">
                        {hospital?.equipment_readiness?.cath_lab || "READY"}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Syringe className="w-4 h-4 text-red-600" />
                      Blood Bank Stock (Units)
                    </h3>
                    <button
                      onClick={() => setCurrentNav("readiness")}
                      className="text-xs font-semibold text-blue-600 hover:underline"
                    >
                      Manage →
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 text-xs">
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">PRBC Units</span>
                      <p className="font-bold text-red-700">
                        {hospital?.blood_bank_status?.prbc_units ?? 35} Units
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">O-Negative Emergency</span>
                      <p className="font-bold text-red-700">
                        {hospital?.blood_bank_status?.o_neg_emergency_units ?? 12} Units
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">Platelets</span>
                      <p className="font-bold text-slate-900">
                        {hospital?.blood_bank_status?.platelets_units ?? 18} Units
                      </p>
                    </div>
                    <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                      <span className="text-[10px] text-slate-400 uppercase font-semibold">Fresh Frozen Plasma</span>
                      <p className="font-bold text-slate-900">
                        {hospital?.blood_bank_status?.plasma_units ?? 20} Units
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 2: INCOMING EMERGENCIES (PREPARATION WORKFLOW) */}
          {/* ========================================================================= */}
          {currentNav === "emergencies" && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-bold text-slate-900">
                    Incoming Emergency Cases & Preparation Workflow
                  </h2>
                  <p className="text-xs text-slate-500">
                    Real-time status updates, step-by-step trauma preparation, SBAR clinical handovers, and arrival confirmations.
                  </p>
                </div>
                <span className="text-xs font-mono font-bold px-2.5 py-1 rounded bg-blue-50 text-blue-700 border border-blue-200 self-start sm:self-auto">
                  {activeInboundDispatches.length} Active En-Route
                </span>
              </div>

              {activeInboundDispatches.length === 0 ? (
                <div className="p-12 text-center rounded-2xl bg-white border border-slate-200 space-y-2">
                  <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
                  <h3 className="text-sm font-bold text-slate-800">No active incoming emergencies</h3>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    The Emergency Department is ready for new allocations. Provisional reservation alerts will appear here when an ambulance selects this facility.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {activeInboundDispatches.map((disp) => {
                    const prepStatus = disp.hospital_preparation_status || "NOT_STARTED";
                    const hasHandover = !!disp.handover_packet;

                    return (
                      <div
                        key={disp.id}
                        className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-4"
                      >
                        {/* Header */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
                              <Ambulance className="w-4 h-4" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-bold text-slate-900">
                                  {disp.ambulance_call_sign || `Ambulance #${disp.ambulance_id}`}
                                </h3>
                                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                                  {disp.status}
                                </span>
                                {disp.incident?.triage_level && (
                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800">
                                    {disp.incident.triage_level}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-slate-500 font-mono">
                                Dispatch #{disp.id} • Incident #{disp.incident_id}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            {disp.estimated_eta_seconds && (
                              <span className="text-xs font-mono font-bold px-2.5 py-1 rounded bg-slate-100 text-slate-700">
                                ETA: {formatDuration(disp.estimated_eta_seconds)}
                              </span>
                            )}
                            {disp.route_distance_meters && (
                              <span className="text-xs font-mono text-slate-500">
                                ({formatDistance(disp.route_distance_meters)})
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Patient & Clinical Observations */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs bg-slate-50 p-3.5 rounded-xl border border-slate-200/60">
                          <div>
                            <span className="text-[10px] text-slate-400 uppercase font-semibold">Chief Complaint</span>
                            <p className="font-bold text-slate-900">{disp.incident?.chief_complaint || "Emergency Triage"}</p>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 uppercase font-semibold">Patient Demographics</span>
                            <p className="font-semibold text-slate-800">
                              {disp.incident?.patient_gender || "Unknown"},{" "}
                              {disp.incident?.patient_age ? `${disp.incident.patient_age} yrs` : "Age Unspecified"}
                            </p>
                          </div>
                          <div>
                            <span className="text-[10px] text-slate-400 uppercase font-semibold">Pickup Location</span>
                            <p className="text-slate-700 truncate">{disp.incident?.location_address || "Mangaluru"}</p>
                          </div>
                        </div>

                        {/* Step-by-Step Hospital Preparation Workflow */}
                        <div className="space-y-2 pt-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
                              Hospital Preparation Stage:
                            </span>
                            <span className="text-xs font-mono font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                              {prepStatus}
                            </span>
                          </div>

                          {/* Workflow Stage Buttons */}
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {[
                              { id: "TEAM_NOTIFIED", label: "1. Team Notified" },
                              { id: "BAY_PREPARED", label: "2. Bay Prepared" },
                              { id: "SPECIALISTS_STANDBY", label: "3. Specialists Standby" },
                              { id: "READY_FOR_ARRIVAL", label: "4. Ready for Arrival" },
                            ].map((step) => {
                              const isCurrent = prepStatus === step.id;
                              return (
                                <button
                                  key={step.id}
                                  type="button"
                                  onClick={() => handleUpdatePreparation(disp.id, step.id)}
                                  disabled={actionLoading}
                                  className={`p-2.5 rounded-xl text-xs font-bold transition border text-center ${
                                    isCurrent
                                      ? "bg-blue-600 text-white border-blue-600 shadow-2xs ring-2 ring-blue-300"
                                      : "bg-white text-slate-700 border-slate-200 hover:border-blue-300 hover:bg-blue-50/50"
                                  }`}
                                >
                                  {step.label}
                                </button>
                              );
                            })}
                          </div>

                          {/* Preparation Notes */}
                          <div className="flex gap-2 mt-2">
                            <input
                              type="text"
                              value={prepNoteInput[disp.id] || ""}
                              onChange={(e) =>
                                setPrepNoteInput((prev) => ({ ...prev, [disp.id]: e.target.value }))
                              }
                              placeholder="Add trauma bay notes (e.g., Trauma Bay 2 prepped, O-Neg on standby)..."
                              className="flex-1 px-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                            />
                            <button
                              type="button"
                              onClick={() => handleUpdatePreparation(disp.id, prepStatus)}
                              disabled={actionLoading || !prepNoteInput[disp.id]}
                              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold disabled:opacity-40"
                            >
                              Add Note
                            </button>
                          </div>

                          {disp.hospital_preparation_notes && (
                            <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono text-slate-700 whitespace-pre-line mt-1">
                              {disp.hospital_preparation_notes}
                            </div>
                          )}
                        </div>

                        {/* Actions: View SBAR & Confirm Patient Arrival */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => handleInspectHandover(disp.id)}
                              className="px-3.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-bold transition flex items-center gap-1.5 shadow-2xs"
                            >
                              <FileText className="w-3.5 h-3.5 text-blue-600" />
                              <span>View SBAR Handover</span>
                            </button>

                            {disp.patient_arrived_hospital_confirmed_at && (
                              <span className="text-xs text-emerald-700 font-semibold flex items-center gap-1">
                                <Check className="w-3.5 h-3.5" />
                                Patient Arrived
                              </span>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={() => handleConfirmArrival(disp.id)}
                            disabled={actionLoading || !!disp.patient_arrived_hospital_confirmed_at}
                            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-xs flex items-center gap-1.5 disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            <span>
                              {disp.patient_arrived_hospital_confirmed_at
                                ? "✓ Patient Arrival Confirmed"
                                : "Confirm Patient Arrival at ER"}
                            </span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 3: DOCTOR MANAGEMENT */}
          {/* ========================================================================= */}
          {currentNav === "doctors" && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-900">Hospital Doctor Management</h2>
                  <p className="text-xs text-slate-500">
                    Live duty rosters, specialty assignments, shift statuses, and real-time synchronization.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsAddDoctorModalOpen(true)}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs flex items-center gap-1.5 self-start sm:self-auto"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>Register Duty Doctor</span>
                </button>
              </div>

              {/* Filters & Search */}
              <div className="flex flex-col sm:flex-row gap-2.5">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={doctorSearch}
                    onChange={(e) => setDoctorSearch(e.target.value)}
                    placeholder="Search doctor by name or specialty..."
                    className="w-full pl-9 pr-3.5 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                </div>
                <select
                  value={doctorDepartmentFilter}
                  onChange={(e) => setDoctorDepartmentFilter(e.target.value)}
                  className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  <option value="ALL">All Departments</option>
                  {uniqueDepartments.map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                </select>
              </div>

              {/* Doctor Roster Cards / Table */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold uppercase text-[10px] tracking-wider">
                        <th className="py-3 px-4">Doctor Name</th>
                        <th className="py-3 px-4">Department & Specialty</th>
                        <th className="py-3 px-4">Shift & Extension</th>
                        <th className="py-3 px-4">Current Status</th>
                        <th className="py-3 px-4 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredDoctors.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-400 text-xs">
                            No doctors found matching filters.
                          </td>
                        </tr>
                      ) : (
                        filteredDoctors.map((doc) => {
                          const isAvail = doc.status === "AVAILABLE";
                          const isBusy = doc.status === "BUSY" || doc.status === "BUSY_IN_PROCEDURE";
                          const isLeave = doc.status === "ON_LEAVE";

                          return (
                            <tr key={doc.id} className="hover:bg-slate-50/60 transition">
                              <td className="py-3.5 px-4">
                                <div className="font-bold text-slate-900">{doc.name}</div>
                                <div className="text-[10px] font-mono text-slate-400">{doc.id}</div>
                              </td>
                              <td className="py-3.5 px-4">
                                <div className="font-medium text-slate-800">{doc.department}</div>
                                <div className="text-[11px] text-slate-500">{doc.specialty}</div>
                              </td>
                              <td className="py-3.5 px-4">
                                <div className="text-slate-700">{doc.shift}</div>
                                <div className="text-[11px] text-slate-400 font-mono">
                                  {doc.contact_number || "Direct Ext"}
                                </div>
                              </td>
                              <td className="py-3.5 px-4">
                                <span
                                  className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase border ${
                                    isAvail
                                      ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                                      : isBusy
                                      ? "bg-amber-50 text-amber-700 border-amber-300"
                                      : isLeave
                                      ? "bg-slate-100 text-slate-600 border-slate-300"
                                      : "bg-red-50 text-red-700 border-red-300"
                                  }`}
                                >
                                  {doc.status}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-right">
                                <div className="flex items-center justify-end gap-1.5">
                                  <select
                                    value={doc.status}
                                    onChange={(e) => handleUpdateDoctorStatus(doc.id, e.target.value)}
                                    className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-[11px] text-slate-700 font-medium focus:outline-none"
                                  >
                                    <option value="AVAILABLE">AVAILABLE</option>
                                    <option value="BUSY">BUSY</option>
                                    <option value="ON_LEAVE">ON_LEAVE</option>
                                    <option value="UNAVAILABLE">UNAVAILABLE</option>
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteDoctor(doc.id, doc.name)}
                                    title="Remove Doctor"
                                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Add Doctor Modal */}
              {isAddDoctorModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
                  <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md shadow-xl p-5 space-y-4">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                      <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        <UserPlus className="w-4 h-4 text-blue-600" />
                        Register Duty Doctor
                      </h3>
                      <button
                        type="button"
                        onClick={() => setIsAddDoctorModalOpen(false)}
                        className="p-1 rounded-md text-slate-400 hover:text-slate-600"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <form onSubmit={handleAddDoctor} className="space-y-3 text-xs">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">
                          Doctor Full Name
                        </label>
                        <input
                          type="text"
                          required
                          value={newDoctor.name}
                          onChange={(e) => setNewDoctor({ ...newDoctor, name: e.target.value })}
                          placeholder="e.g., Dr. Rajesh Hegde"
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Department
                          </label>
                          <input
                            type="text"
                            required
                            value={newDoctor.department}
                            onChange={(e) => setNewDoctor({ ...newDoctor, department: e.target.value })}
                            placeholder="Emergency Dept"
                            className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Specialty
                          </label>
                          <input
                            type="text"
                            required
                            value={newDoctor.specialty}
                            onChange={(e) => setNewDoctor({ ...newDoctor, specialty: e.target.value })}
                            placeholder="Trauma / Cardiac"
                            className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Assigned Shift
                          </label>
                          <select
                            value={newDoctor.shift}
                            onChange={(e) => setNewDoctor({ ...newDoctor, shift: e.target.value })}
                            className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white focus:outline-none"
                          >
                            <option value="Morning (08:00 - 16:00)">Morning (08:00 - 16:00)</option>
                            <option value="Evening (16:00 - 00:00)">Evening (16:00 - 00:00)</option>
                            <option value="Night (00:00 - 08:00)">Night (00:00 - 08:00)</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold text-slate-700 mb-1">
                            Initial Status
                          </label>
                          <select
                            value={newDoctor.status}
                            onChange={(e) => setNewDoctor({ ...newDoctor, status: e.target.value })}
                            className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white focus:outline-none"
                          >
                            <option value="AVAILABLE">AVAILABLE</option>
                            <option value="BUSY">BUSY</option>
                            <option value="ON_LEAVE">ON_LEAVE</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-bold text-slate-700 mb-1">
                          Direct Contact Extension / Mobile
                        </label>
                        <input
                          type="text"
                          value={newDoctor.contact_number}
                          onChange={(e) => setNewDoctor({ ...newDoctor, contact_number: e.target.value })}
                          placeholder="+91 824 2444591"
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                        />
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => setIsAddDoctorModalOpen(false)}
                          className="px-3.5 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={actionLoading}
                          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs disabled:opacity-50"
                        >
                          Save Doctor
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 4: WARD & BED AVAILABILITY */}
          {/* ========================================================================= */}
          {currentNav === "beds" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-base font-bold text-slate-900">Ward & Bed Availability Management</h2>
                <p className="text-xs text-slate-500">
                  Real-time bed counts, occupied vs available computation, and regional allocation synchronization.
                </p>
              </div>

              {bedFormError && (
                <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs font-medium flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                  <span>{bedFormError}</span>
                </div>
              )}

              <form onSubmit={handleSaveBeds} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* ER Beds */}
                  <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        <Bed className="w-4 h-4 text-emerald-600" />
                        Emergency Department (ER) Beds
                      </h3>
                      <span className="text-xs font-mono font-black text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                        {Math.max(0, bedsForm.total_emergency_beds - bedsForm.occupied_emergency_beds)} Available
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Total ER Bays
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.total_emergency_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, total_emergency_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 font-bold"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Occupied ER Bays
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.occupied_emergency_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, occupied_emergency_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 font-bold"
                        />
                      </div>
                    </div>
                  </div>

                  {/* ICU Beds */}
                  <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        <HeartPulse className="w-4 h-4 text-purple-600" />
                        Intensive Care Unit (ICU) Beds
                      </h3>
                      <span className="text-xs font-mono font-black text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                        {Math.max(0, bedsForm.total_icu_beds - bedsForm.occupied_icu_beds)} Available
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Total ICU Beds
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.total_icu_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, total_icu_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/20 font-bold"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Occupied ICU Beds
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.occupied_icu_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, occupied_icu_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/20 font-bold"
                        />
                      </div>
                    </div>
                  </div>

                  {/* General Inpatient Ward */}
                  <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        <Users className="w-4 h-4 text-blue-600" />
                        General Inpatient Ward Beds
                      </h3>
                      <span className="text-xs font-mono font-black text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">
                        {Math.max(0, bedsForm.total_ward_beds - bedsForm.occupied_ward_beds)} Available
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Total Ward Beds
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.total_ward_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, total_ward_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 font-bold"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Occupied Ward Beds
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.occupied_ward_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, occupied_ward_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 font-bold"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Pediatric Ward */}
                  <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-amber-600" />
                        Pediatric Emergency & Ward Beds
                      </h3>
                      <span className="text-xs font-mono font-black text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                        {Math.max(0, bedsForm.total_pediatric_beds - bedsForm.occupied_pediatric_beds)} Available
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Total Pediatric Beds
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.total_pediatric_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, total_pediatric_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 font-bold"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Occupied Pediatric Beds
                        </label>
                        <input
                          type="number"
                          min="0"
                          value={bedsForm.occupied_pediatric_beds}
                          onChange={(e) =>
                            setBedsForm({ ...bedsForm, occupied_pediatric_beds: parseInt(e.target.value) || 0 })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-amber-500/20 font-bold"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={actionLoading}
                    className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-xs flex items-center gap-2 disabled:opacity-50"
                  >
                    <Check className="w-4 h-4" />
                    <span>Save & Broadcast Bed Capacity</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 5: HOSPITAL READINESS */}
          {/* ========================================================================= */}
          {currentNav === "readiness" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-base font-bold text-slate-900">Hospital Operational Readiness</h2>
                <p className="text-xs text-slate-500">
                  Critical medical equipment readiness, oxygen infrastructure, ventilators, and blood bank availability.
                </p>
              </div>

              <form onSubmit={handleSaveReadiness} className="space-y-4">
                {/* Readiness Mode Selector */}
                <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                  <h3 className="text-sm font-bold text-slate-900">Operational Readiness Mode</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { id: "READY", label: "READY", desc: "Accepting all emergency transports", color: "emerald" },
                      { id: "BUSY", label: "BUSY", desc: "High census, accepting critical only", color: "amber" },
                      { id: "DIVERT", label: "DIVERT", desc: "Facility divert requested", color: "red" },
                    ].map((mode) => {
                      const isSelected = readinessForm.readiness_status === mode.id;
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => setReadinessForm({ ...readinessForm, readiness_status: mode.id })}
                          className={`p-3.5 rounded-xl text-left border transition ${
                            isSelected
                              ? mode.color === "emerald"
                                ? "bg-emerald-50 border-emerald-500 ring-2 ring-emerald-300"
                                : mode.color === "amber"
                                ? "bg-amber-50 border-amber-500 ring-2 ring-amber-300"
                                : "bg-red-50 border-red-500 ring-2 ring-red-300"
                              : "bg-white border-slate-200 hover:border-slate-300"
                          }`}
                        >
                          <div className="font-extrabold text-xs text-slate-900">{mode.label}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">{mode.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Oxygen & Ventilators */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Wind className="w-4 h-4 text-blue-600" />
                      Oxygen Infrastructure
                    </h3>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">
                        Oxygen Supply Telemetry
                      </label>
                      <select
                        value={readinessForm.oxygen_status}
                        onChange={(e) => setReadinessForm({ ...readinessForm, oxygen_status: e.target.value })}
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-xs font-bold"
                      >
                        <option value="NORMAL">NORMAL — Bulk LOX Tank & Cylinders Full</option>
                        <option value="LOW">LOW — Backup Reserve Activated</option>
                        <option value="CRITICAL">CRITICAL — Immediate Refill Required</option>
                      </select>
                    </div>
                  </div>

                  <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Activity className="w-4 h-4 text-purple-600" />
                      Invasive Mechanical Ventilators
                    </h3>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">Total</label>
                        <input
                          type="number"
                          min="0"
                          value={readinessForm.ventilators_total}
                          onChange={(e) =>
                            setReadinessForm({
                              ...readinessForm,
                              ventilators_total: parseInt(e.target.value) || 0,
                            })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 font-bold"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">Available</label>
                        <input
                          type="number"
                          min="0"
                          value={readinessForm.ventilators_available}
                          onChange={(e) =>
                            setReadinessForm({
                              ...readinessForm,
                              ventilators_available: parseInt(e.target.value) || 0,
                            })
                          }
                          className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 font-bold"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Equipment Readiness Toggles */}
                <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                  <h3 className="text-sm font-bold text-slate-900">Diagnostic & Surgical Equipment Readiness</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
                    {[
                      { key: "ct_scanner", label: "CT Scanner" },
                      { key: "mri", label: "MRI" },
                      { key: "cath_lab", label: "Cath Lab" },
                      { key: "trauma_resuscitation_bay", label: "Trauma Bay" },
                      { key: "decontamination_unit", label: "Decon Unit" },
                    ].map((eq) => {
                      const curVal = (readinessForm.equipment as any)[eq.key] || "READY";
                      return (
                        <div key={eq.key} className="p-3 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5">
                          <span className="text-[11px] font-bold text-slate-800 block truncate">{eq.label}</span>
                          <select
                            value={curVal}
                            onChange={(e) =>
                              setReadinessForm({
                                ...readinessForm,
                                equipment: { ...readinessForm.equipment, [eq.key]: e.target.value },
                              })
                            }
                            className="w-full px-2 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold"
                          >
                            <option value="READY">READY</option>
                            <option value="BUSY">BUSY</option>
                            <option value="MAINTENANCE">MAINTENANCE</option>
                            <option value="OFFLINE">OFFLINE</option>
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Blood Bank Stock Levels */}
                <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-5 space-y-3">
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Syringe className="w-4 h-4 text-red-600" />
                    Blood Bank Reserve Stock (Units)
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">
                        PRBC Units (Packed RBCs)
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={readinessForm.blood_bank.prbc_units}
                        onChange={(e) =>
                          setReadinessForm({
                            ...readinessForm,
                            blood_bank: { ...readinessForm.blood_bank, prbc_units: parseInt(e.target.value) || 0 },
                          })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 font-bold"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">
                        O-Negative Emergency Units
                      </label>
                      <input
                        type="number"
                        min="0"
                        value={readinessForm.blood_bank.o_neg_emergency_units}
                        onChange={(e) =>
                          setReadinessForm({
                            ...readinessForm,
                            blood_bank: {
                              ...readinessForm.blood_bank,
                              o_neg_emergency_units: parseInt(e.target.value) || 0,
                            },
                          })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 font-bold text-red-700"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">Platelet Units</label>
                      <input
                        type="number"
                        min="0"
                        value={readinessForm.blood_bank.platelets_units}
                        onChange={(e) =>
                          setReadinessForm({
                            ...readinessForm,
                            blood_bank: {
                              ...readinessForm.blood_bank,
                              platelets_units: parseInt(e.target.value) || 0,
                            },
                          })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 font-bold"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">Fresh Frozen Plasma</label>
                      <input
                        type="number"
                        min="0"
                        value={readinessForm.blood_bank.plasma_units}
                        onChange={(e) =>
                          setReadinessForm({
                            ...readinessForm,
                            blood_bank: {
                              ...readinessForm.blood_bank,
                              plasma_units: parseInt(e.target.value) || 0,
                            },
                          })
                        }
                        className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 font-bold"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="submit"
                    disabled={actionLoading}
                    className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition shadow-xs flex items-center gap-2 disabled:opacity-50"
                  >
                    <Check className="w-4 h-4" />
                    <span>Save & Broadcast Readiness Profile</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 6: CRASH ALERTS */}
          {/* ========================================================================= */}
          {currentNav === "crashes" && (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-red-600" />
                    Ambulance Crash Detection & Hospital Alerts
                  </h2>
                  <p className="text-xs text-slate-500">
                    High-priority alerts triggered when an ambulance assigned to this facility experiences a collision.
                  </p>
                </div>

                {/* DEMO Crash Simulation Button */}
                <button
                  type="button"
                  onClick={handleSimulateCrash}
                  disabled={actionLoading}
                  className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-bold transition shadow-xs flex items-center gap-2 self-start sm:self-auto cursor-pointer"
                >
                  <Flame className="w-4 h-4 animate-pulse" />
                  <span>DEMO Crash Simulation</span>
                </button>
              </div>

              {crashAlerts.length === 0 ? (
                <div className="p-12 text-center rounded-2xl bg-white border border-slate-200 space-y-2">
                  <CheckCircle2 className="w-8 h-8 text-emerald-600 mx-auto" />
                  <h3 className="text-sm font-bold text-slate-800">No Fleet Crash Alerts Active</h3>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    All inbound ambulances are operating normally without collision telemetry anomalies. Use the DEMO Crash Simulation button above to demonstrate the alert workflow.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {crashAlerts.map((alert) => {
                    const isCrit = alert.severity === "CRITICAL" || alert.severity === "SEVERE";
                    const isAck = alert.status !== "TRIGGERED";

                    return (
                      <div
                        key={alert.id}
                        className={`rounded-2xl border p-5 space-y-4 transition-all ${
                          isCrit && !isAck
                            ? "bg-red-50/70 border-red-500 shadow-sm ring-1 ring-red-400"
                            : "bg-white border-slate-200 shadow-2xs"
                        }`}
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
                          <div className="flex items-center gap-2.5">
                            <div
                              className={`w-9 h-9 rounded-xl flex items-center justify-center font-bold text-white ${
                                isCrit ? "bg-red-600" : "bg-amber-600"
                              }`}
                            >
                              <AlertTriangle className="w-5 h-5" />
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-black text-slate-900">
                                  Crash Alert #{alert.id} • {alert.ambulance_call_sign || `Ambulance #${alert.ambulance_id}`}
                                </h3>
                                <span
                                  className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                                    isCrit ? "bg-red-600 text-white" : "bg-amber-100 text-amber-800"
                                  }`}
                                >
                                  {alert.severity}
                                </span>
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                                  {alert.source}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                                Location: {alert.location_description} ({alert.latitude.toFixed(4)}, {alert.longitude.toFixed(4)})
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-mono font-bold px-2.5 py-1 rounded border ${
                                alert.status === "TRIGGERED"
                                  ? "bg-red-100 text-red-800 border-red-300 animate-pulse"
                                  : alert.status === "RESOLVED"
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-300"
                                  : "bg-blue-50 text-blue-700 border-blue-300"
                              }`}
                            >
                              Status: {alert.status}
                            </span>
                          </div>
                        </div>

                        {/* Telemetry Sensor Matrix */}
                        {alert.sensor_data && (
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs bg-slate-50 p-3.5 rounded-xl border border-slate-200">
                            <div>
                              <span className="text-[10px] text-slate-400 uppercase font-semibold">Impact Force</span>
                              <p className="font-bold text-slate-900">{alert.sensor_data.g_force ? `${alert.sensor_data.g_force} G` : "N/A"}</p>
                            </div>
                            <div>
                              <span className="text-[10px] text-slate-400 uppercase font-semibold">Rollover Status</span>
                              <p className="font-bold text-slate-900">
                                {alert.sensor_data.rollover ? "Rollover Detected" : "No Rollover (Upright)"}
                              </p>
                            </div>
                            <div>
                              <span className="text-[10px] text-slate-400 uppercase font-semibold">Airbags</span>
                              <p className="font-bold text-slate-900">
                                {alert.sensor_data.airbag_deployed ? "Airbags Deployed" : "Intact"}
                              </p>
                            </div>
                            <div>
                              <span className="text-[10px] text-slate-400 uppercase font-semibold">Impact Speed</span>
                              <p className="font-bold text-slate-900">
                                {alert.sensor_data.impact_velocity_kmh ? `${alert.sensor_data.impact_velocity_kmh} km/h` : "N/A"}
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Hospital Response Notes */}
                        {alert.response_notes && (
                          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs font-mono text-slate-800 whitespace-pre-line">
                            {alert.response_notes}
                          </div>
                        )}

                        {/* Hospital Response Action Controls */}
                        <div className="space-y-2 pt-1 border-t border-slate-100">
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={crashNoteInput[alert.id] || ""}
                              onChange={(e) =>
                                setCrashNoteInput((prev) => ({ ...prev, [alert.id]: e.target.value }))
                              }
                              placeholder="Add hospital response note (e.g., Trauma Alpha alerted, dispatched backup ALS)..."
                              className="flex-1 px-3 py-1.5 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-red-500/20"
                            />
                          </div>

                          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                            {alert.status === "TRIGGERED" && (
                              <button
                                type="button"
                                onClick={() => handleRespondCrashAlert(alert.id, "ACKNOWLEDGED")}
                                disabled={actionLoading}
                                className="px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition"
                              >
                                Acknowledge Alert
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleRespondCrashAlert(alert.id, "TEAM_NOTIFIED")}
                              disabled={actionLoading}
                              className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold transition"
                            >
                              Mark Team Notified
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRespondCrashAlert(alert.id, "BACKUP_REQUESTED")}
                              disabled={actionLoading}
                              className="px-3.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold transition"
                            >
                              Request Backup Unit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRespondCrashAlert(alert.id, "RESOLVED")}
                              disabled={actionLoading}
                              className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition"
                            >
                              Resolve Alert
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 7: INCIDENT HISTORY */}
          {/* ========================================================================= */}
          {currentNav === "history" && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-bold text-slate-900">Completed Emergency Cases</h2>
                <p className="text-xs text-slate-500">
                  Archived clinical handover records and past patients received into hospital care.
                </p>
              </div>

              {completedDispatches.length === 0 ? (
                <div className="p-12 text-center rounded-2xl bg-white border border-slate-200 text-slate-400 text-xs">
                  No completed emergency cases archived for this hospital session yet.
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs overflow-hidden">
                  <div className="divide-y divide-slate-100 text-xs">
                    {completedDispatches.map((disp) => (
                      <div key={disp.id} className="p-4 flex items-center justify-between hover:bg-slate-50/60">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">Dispatch #{disp.id}</span>
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold">
                              COMPLETED
                            </span>
                            <span className="text-[10px] text-slate-500">Unit: {disp.ambulance_call_sign}</span>
                          </div>
                          <p className="text-slate-700">{disp.incident?.chief_complaint || "Emergency Patient"}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleInspectHandover(disp.id)}
                          className="px-3 py-1.5 rounded-lg border border-slate-200 text-blue-600 font-bold hover:bg-slate-50"
                        >
                          View Handover
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ========================================================================= */}
          {/* SECTION 8: HOSPITAL PROFILE */}
          {/* ========================================================================= */}
          {currentNav === "profile" && (
            <div className="bg-white border border-slate-200 rounded-2xl shadow-2xs p-6 space-y-6">
              <div className="flex items-center justify-between pb-4 border-b border-slate-100">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-black text-slate-900">{hospital?.name}</h2>
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                      DEMO DATA
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Facility Code: <strong className="text-slate-800 font-mono">{hospital?.facility_code}</strong> • ID #{hospital?.id}
                  </p>
                </div>
                <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
                  <Building2 className="w-5 h-5" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">Address / Landmark</span>
                  <p className="text-xs font-semibold text-slate-900 mt-0.5">{hospital?.address}</p>
                </div>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">GPS Coordinates</span>
                  <p className="text-xs font-mono font-semibold text-slate-900 mt-0.5">
                    {hospital?.latitude?.toFixed(6)}, {hospital?.longitude?.toFixed(6)}
                  </p>
                </div>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">Emergency Contact Phone</span>
                  <p className="text-xs font-semibold text-slate-900 mt-0.5">{hospital?.contact_phone || "+91 824 2444591"}</p>
                </div>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">Emergency Contact Person</span>
                  <p className="text-xs font-semibold text-slate-900 mt-0.5">
                    {hospital?.emergency_contact_person || "Chief Medical Officer"}
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 col-span-1 sm:col-span-2">
                  <span className="text-[10px] text-slate-400 uppercase font-bold">Registered Medical Specialties</span>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {hospital?.specialties?.map((s: string) => (
                      <span
                        key={s}
                        className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-800 text-[11px] font-bold shadow-2xs"
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* SBAR HANDOVER CLINICAL INSPECTION MODAL */}
      {activeHandoverPacket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs font-sans">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto shadow-xl flex flex-col">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
                  <FileText className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Digital SBAR Clinical Handover Packet
                  </h3>
                  <p className="text-[11px] text-slate-500 font-mono">
                    Dispatch #{activeHandoverPacket.dispatch_id} • Status: {activeHandoverPacket.status}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setActiveHandoverPacket(null)}
                className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              {/* Situation */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-blue-700 uppercase tracking-wider block">1. Situation</span>
                <p className="font-semibold text-slate-900">{activeHandoverPacket.situation}</p>
              </div>

              {/* Background */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-wider block">2. Background</span>
                <p className="text-slate-800">{activeHandoverPacket.background}</p>
              </div>

              {/* Assessment */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-amber-700 uppercase tracking-wider block">3. Assessment</span>
                <p className="text-slate-800">{activeHandoverPacket.assessment}</p>
              </div>

              {/* Recommendation */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <span className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider block">4. Recommendation</span>
                <p className="text-slate-800">{activeHandoverPacket.recommendation}</p>
              </div>

              {/* Clinician Sign-Off Input */}
              <div className="pt-2 border-t border-slate-200 space-y-2">
                <label className="text-xs font-bold text-slate-900 block">
                  Receiving ER Practitioner Formal Sign-Off:
                </label>
                <input
                  type="text"
                  value={clinicianName}
                  onChange={(e) => setClinicianName(e.target.value)}
                  placeholder="Doctor / ER Registrar Full Name"
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Acknowledge Button */}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveHandoverPacket(null)}
                  className="px-3.5 py-1.5 rounded-xl border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Close
                </button>
                <button
                  type="button"
                  onClick={handleAcknowledgeHandover}
                  disabled={actionLoading || activeHandoverPacket.status === "ACKNOWLEDGED"}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-xs transition flex items-center gap-1.5 disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {activeHandoverPacket.status === "ACKNOWLEDGED"
                      ? "✓ Handover Acknowledged"
                      : "Acknowledge & Confirm Bed Intake"}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
