"use client";

import React from "react";
import {
  X,
  Stethoscope,
  Building2,
  Ambulance,
  Clock,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Activity,
  Send,
  UserCheck,
} from "lucide-react";
import { formatDistance, formatDuration } from "@/lib/utils";

interface HandoverModalProps {
  isOpen: boolean;
  onClose: () => void;
  dispatch: any;
  incident: any;
  onAcknowledge: () => void;
}

export default function HandoverModal({
  isOpen,
  onClose,
  dispatch,
  incident,
  onAcknowledge,
}: HandoverModalProps) {
  if (!isOpen || !dispatch) return null;

  const packet = dispatch.handover_packet;
  if (!packet) return null;

  const isAck = packet.status === "ACKNOWLEDGED";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl flex flex-col">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900 tracking-wide">
                  Emergency Handover Packet
                </h2>
                <span className="font-mono text-xs text-blue-600 font-semibold">
                  #PKT-{packet.id}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                Pre-arrival clinical transmission to receiving emergency facility
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                isAck
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                  : "bg-blue-50 text-blue-700 border-blue-200 animate-pulse"
              }`}
            >
              {packet.status}
            </span>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 p-1.5 rounded-lg hover:bg-slate-100 transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Content */}
        <div className="p-5 space-y-4 text-xs">
          {/* Patient Demographics & Chief Complaint */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-blue-600" />
                Patient & Incident Briefing
              </span>
              <span
                className={`text-[9px] font-bold px-2 py-0.5 rounded font-mono ${
                  packet.triage_color === "RED"
                    ? "bg-red-50 text-red-700 border border-red-200"
                    : packet.triage_color === "YELLOW"
                    ? "bg-amber-50 text-amber-700 border border-amber-200"
                    : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                }`}
              >
                {packet.triage_priority} (Score: {packet.triage_score}/100)
              </span>
            </div>

            <div className="text-sm font-bold text-slate-900">
              {packet.chief_complaint}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2 border-t border-slate-200/80 text-[11px] text-slate-600">
              <div>
                <span className="block text-[10px] text-slate-400">Patient Age</span>
                <span className="font-semibold text-slate-800">
                  {packet.patient_age !== null && packet.patient_age !== undefined
                    ? `${packet.patient_age} years`
                    : "Unknown / Unspecified"}
                </span>
              </div>
              <div>
                <span className="block text-[10px] text-slate-400">Patient Gender</span>
                <span className="font-semibold text-slate-800">
                  {packet.patient_gender || "Unknown"}
                </span>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <span className="block text-[10px] text-slate-400">Scene Location</span>
                <span className="font-semibold text-slate-800 truncate block">
                  {packet.incident_address || "GPS Coordinates Recorded"}
                </span>
              </div>
            </div>
          </div>

          {/* Clinical Observations & Reported Symptoms */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
              <Stethoscope className="w-3.5 h-3.5 text-purple-600" />
              Observed Clinical Indicators
            </span>
            {packet.reported_symptoms && packet.reported_symptoms.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {packet.reported_symptoms.map((symptom: string, idx: number) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 rounded-lg bg-white border border-slate-200 text-slate-700 text-[11px] font-medium"
                  >
                    • {symptom}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-slate-400 italic">No specific secondary symptoms reported.</p>
            )}

            {/* Triage Rationale */}
            {packet.triage_justifications && packet.triage_justifications.length > 0 && (
              <div className="pt-2 border-t border-slate-200/80">
                <span className="text-[10px] font-mono text-slate-500 uppercase font-semibold">
                  Triage Algorithm Rationale:
                </span>
                <ul className="mt-1 space-y-1 text-[11px] text-slate-600">
                  {packet.triage_justifications.map((just: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span className="text-blue-600 font-mono mt-0.5">•</span>
                      <span>{just}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Transport & Hospital Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Ambulance Unit */}
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
              <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <Ambulance className="w-3.5 h-3.5 text-blue-600" />
                Responding Unit
              </span>
              <div className="text-sm font-bold text-blue-600 font-mono">
                {packet.ambulance_call_sign}
              </div>
              <div className="text-[11px] text-slate-600">
                Tier: <strong className="text-slate-800">{packet.ambulance_vehicle_type}</strong> • Paramedic:{" "}
                <strong className="text-slate-800">{packet.paramedic_level || "BASIC"}</strong>
              </div>
              <div className="text-[10px] text-slate-500 font-mono pt-1">
                Equipment: {packet.required_equipment?.join(", ") || "Standard Trauma/BLS"}
              </div>
            </div>

            {/* Hospital ER */}
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
              <span className="font-bold text-slate-700 uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-emerald-600" />
                Receiving Facility ER
              </span>
              <div className="text-sm font-bold text-emerald-700">
                {packet.receiving_hospital_name || "Assigned Emergency Centre"}
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-700 pt-1">
                <span>Est. Arrival:</span>
                <span className="font-bold text-emerald-600">
                  {formatDuration(packet.estimated_arrival_eta_seconds || 0)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                <span>Transit Distance:</span>
                <span>{formatDistance(packet.route_distance_meters || 0)}</span>
              </div>
            </div>
          </div>

          {/* Hospital Acknowledgment Status Card */}
          <div
            className={`p-4 rounded-xl border ${
              isAck
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-slate-50 border-slate-200 text-slate-700"
            } space-y-2`}
          >
            <div className="flex items-center justify-between">
              <span className="font-bold text-xs flex items-center gap-2">
                {isAck ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                ) : (
                  <Send className="w-4 h-4 text-blue-600 animate-pulse" />
                )}
                <span>Hospital ER Intake Confirmation</span>
              </span>
              <span className="text-[9px] uppercase font-mono px-2 py-0.5 rounded bg-white border border-slate-200 text-slate-500 font-medium">
                [Simulated ER Terminal]
              </span>
            </div>

            {isAck ? (
              <div className="text-[11px] space-y-1 text-emerald-700 font-mono pt-1">
                <div>
                  ✓ Status: <strong>ACKNOWLEDGED</strong> (Staff Pre-Notified)
                </div>
                <div>
                  Desk/Staff: <strong>{packet.acknowledged_by}</strong>
                </div>
                <div>
                  Timestamp:{" "}
                  <strong>
                    {packet.acknowledged_at
                      ? new Date(packet.acknowledged_at).toLocaleTimeString()
                      : "Recorded"}
                  </strong>
                </div>
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                <p className="text-[11px] text-slate-500 leading-snug">
                  The handover packet has been electronically transmitted to the receiving ER triage
                  desk. Hospital intake staff review incoming clinical vitals to prepare resuscitation
                  bays prior to ambulance arrival.
                </p>
                <button
                  onClick={onAcknowledge}
                  className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md shadow-emerald-600/20 transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <UserCheck className="w-4 h-4" />
                  <span>Simulate Receiving Hospital ER Intake Acknowledgment</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex justify-end sticky bottom-0">
          <button
            onClick={onClose}
            className="py-1.5 px-4 rounded-lg bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-semibold transition cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
