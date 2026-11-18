"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  ShieldAlert,
  Activity,
  Users,
  Clock,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  FileText,
  Compass,
  Radio,
  Building2,
  Ambulance,
  UserCheck,
} from "lucide-react";

interface IncidentEvent {
  id: number;
  incident_id: number;
  dispatch_id?: number;
  event_type: string;
  event_title: string;
  event_description: string;
  actor_type: string;
  actor_reference?: string;
  event_metadata?: Record<string, any>;
  created_at: string;
}

interface UnifiedTimelinePanelProps {
  incidentId: number;
  backendUrl: string;
}

export default function UnifiedTimelinePanel({
  incidentId,
  backendUrl,
}: UnifiedTimelinePanelProps) {
  const [events, setEvents] = useState<IncidentEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTimeline = useCallback(async () => {
    if (!incidentId) return;
    try {
      const res = await fetch(`${backendUrl}/api/incidents/${incidentId}/timeline`);
      if (res.ok) {
        setEvents(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch timeline:", err);
    } finally {
      setLoading(false);
    }
  }, [incidentId, backendUrl]);

  useEffect(() => {
    fetchTimeline();
    const interval = setInterval(fetchTimeline, 5000);
    return () => clearInterval(interval);
  }, [fetchTimeline]);

  const getEventStyle = (type: string) => {
    switch (type) {
      case "EMERGENCY_REGISTERED":
        return {
          icon: <ShieldAlert className="w-3.5 h-3.5 text-red-600" />,
          badgeColor: "bg-red-50 text-red-700 border-red-200",
          dotColor: "bg-red-500",
        };
      case "TRIAGE_COMPLETED":
        return {
          icon: <Activity className="w-3.5 h-3.5 text-purple-600" />,
          badgeColor: "bg-purple-50 text-purple-700 border-purple-200",
          dotColor: "bg-purple-500",
        };
      case "RESOURCES_RESERVED":
        return {
          icon: <Clock className="w-3.5 h-3.5 text-blue-600" />,
          badgeColor: "bg-blue-50 text-blue-700 border-blue-200",
          dotColor: "bg-blue-500",
        };
      case "AMBULANCE_ACCEPTED":
      case "HOSPITAL_ACCEPTED":
      case "DUAL_CONFIRMATION_COMPLETED":
        return {
          icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
          badgeColor: "bg-emerald-50 text-emerald-700 border-emerald-200",
          dotColor: "bg-emerald-500",
        };
      case "AMBULANCE_REJECTED":
      case "HOSPITAL_REJECTED":
      case "RESERVATION_EXPIRED":
        return {
          icon: <AlertTriangle className="w-3.5 h-3.5 text-red-600" />,
          badgeColor: "bg-red-50 text-red-700 border-red-200",
          dotColor: "bg-red-500",
        };
      case "ESCALATION_TRIGGERED":
      case "RESOURCE_REASSIGNED":
        return {
          icon: <RotateCcw className="w-3.5 h-3.5 text-amber-600" />,
          badgeColor: "bg-amber-50 text-amber-700 border-amber-200",
          dotColor: "bg-amber-500",
        };
      case "WITNESS_REPORT_RECEIVED":
      case "POSSIBLE_DUPLICATE_DETECTED":
      case "WITNESS_REPORT_LINKED":
      case "WITNESS_REPORT_DISTINCT":
        return {
          icon: <Users className="w-3.5 h-3.5 text-indigo-600" />,
          badgeColor: "bg-indigo-50 text-indigo-700 border-indigo-200",
          dotColor: "bg-indigo-500",
        };
      case "HANDOVER_PACKET_GENERATED":
      case "HANDOVER_ACKNOWLEDGED":
        return {
          icon: <FileText className="w-3.5 h-3.5 text-purple-600" />,
          badgeColor: "bg-purple-50 text-purple-700 border-purple-200",
          dotColor: "bg-purple-500",
        };
      case "EMERGENCY_COMPLETED":
        return {
          icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />,
          badgeColor: "bg-emerald-50 text-emerald-700 border-emerald-200",
          dotColor: "bg-emerald-500",
        };
      default:
        return {
          icon: <Compass className="w-3.5 h-3.5 text-slate-500" />,
          badgeColor: "bg-slate-100 text-slate-700 border-slate-200",
          dotColor: "bg-slate-400",
        };
    }
  };

  return (
    <div className="p-3.5 rounded-xl border border-slate-200 bg-white space-y-3 shadow-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
          <Radio className="w-3.5 h-3.5 text-blue-600 animate-pulse" />
          <span>Unified Coordination Timeline</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-slate-600">
            {events.length} {events.length === 1 ? "Event" : "Events"}
          </span>
          <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-bold flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping" />
            Live
          </span>
        </div>
      </div>

      {/* Events Vertical Stream */}
      {events.length === 0 ? (
        <div className="text-[11px] text-slate-400 font-mono text-center py-4">
          No coordination events logged yet.
        </div>
      ) : (
        <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
          {events.map((evt, idx) => {
            const style = getEventStyle(evt.event_type);
            const timeStr = new Date(evt.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
            const attemptNo = evt.event_metadata?.attempt_number;

            return (
              <div key={evt.id || idx} className="flex items-start gap-2.5 text-xs relative">
                {/* Timeline connector dot */}
                <div className="flex flex-col items-center mt-1">
                  <div className={`w-2.5 h-2.5 rounded-full ${style.dotColor} ring-4 ring-white shadow-xs`} />
                  {idx < events.length - 1 && (
                    <div className="w-px h-full bg-slate-200 min-h-[32px] my-0.5" />
                  )}
                </div>

                {/* Event Card */}
                <div className="flex-1 p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 space-y-1 shadow-2xs">
                  <div className="flex items-center justify-between text-[10px]">
                    <div className="flex items-center gap-1.5">
                      {style.icon}
                      <span className="font-bold text-slate-800">
                        {evt.event_title}
                      </span>
                    </div>
                    <span className="font-mono text-slate-400 text-[9px]">
                      {timeStr}
                    </span>
                  </div>

                  <p className="text-[10px] text-slate-600 leading-snug">
                    {evt.event_description}
                  </p>

                  {/* Context pills */}
                  <div className="flex flex-wrap items-center gap-1 pt-1 text-[9px] font-mono">
                    <span className="px-1.5 py-0.2 rounded bg-white text-slate-600 border border-slate-200 font-medium">
                      {evt.actor_type}: {evt.actor_reference || "System"}
                    </span>

                    {attemptNo && attemptNo > 1 && (
                      <span className="px-1.5 py-0.2 rounded bg-amber-50 text-amber-700 border border-amber-200 font-bold">
                        Attempt #{attemptNo}
                      </span>
                    )}

                    {evt.event_metadata?.ambulance_call_sign && (
                      <span className="px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 border border-blue-200 flex items-center gap-1 font-semibold">
                        <Ambulance className="w-2.5 h-2.5" />
                        {evt.event_metadata.ambulance_call_sign}
                      </span>
                    )}

                    {evt.event_metadata?.hospital_name && (
                      <span className="px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1 font-semibold">
                        <Building2 className="w-2.5 h-2.5" />
                        {evt.event_metadata.hospital_name}
                      </span>
                    )}

                    {evt.event_metadata?.acknowledged_by && (
                      <span className="px-1.5 py-0.2 rounded bg-purple-50 text-purple-700 border border-purple-200 flex items-center gap-1 font-semibold">
                        <UserCheck className="w-2.5 h-2.5" />
                        {evt.event_metadata.acknowledged_by}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
