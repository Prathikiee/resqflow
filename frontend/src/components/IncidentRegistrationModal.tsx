"use client";

import React, { useState, useEffect } from "react";
import {
  AlertTriangle,
  Building,
  CheckCircle,
  FileText,
  MapPin,
  Phone,
  ShieldAlert,
  User,
  X,
  Zap,
} from "lucide-react";

interface IncidentRegistrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onIncidentCreated: (newIncident: any) => void;
}

const MANGALURU_LOCATION_PRESETS = [
  {
    name: "Kadri Hills Park Road",
    address: "Kadri Hills Park Road, Mangaluru, Karnataka 575004",
    lat: 12.8770,
    lon: 74.8580,
  },
  {
    name: "Hampankatta Market Circle",
    address: "K.S. Rao Road, Hampankatta, Mangaluru, Karnataka 575001",
    lat: 12.8680,
    lon: 74.8420,
  },
  {
    name: "Kuntikan Highway Flyover",
    address: "NH 66, Kuntikan, Mangaluru, Karnataka 575004",
    lat: 12.8980,
    lon: 74.8460,
  },
  {
    name: "Old Port / Bunder Fishing Wharf",
    address: "Bunder Wharf Road, Mangaluru, Karnataka 575001",
    lat: 12.8590,
    lon: 74.8380,
  },
  {
    name: "Surathkal Beach Road",
    address: "Surathkal Main Road, Mangaluru, Karnataka 575014",
    lat: 13.0060,
    lon: 74.7940,
  },
];

export default function IncidentRegistrationModal({
  isOpen,
  onClose,
  onIncidentCreated,
}: IncidentRegistrationModalProps) {
  const [callerName, setCallerName] = useState("Venkatesh Rao");
  const [callerPhone, setCallerPhone] = useState("+91 98450 12345");
  const [address, setAddress] = useState("Kadri Hills Park Road, Mangaluru, Karnataka 575004");
  const [latitude, setLatitude] = useState<number>(12.8770);
  const [longitude, setLongitude] = useState<number>(74.8580);
  const [chiefComplaint, setChiefComplaint] = useState(
    "Motorcycle collision with divider, rider thrown 10 meters, unconscious and bleeding profusely from head."
  );
  const [patientAge, setPatientAge] = useState<number | "">(34);
  const [patientGender, setPatientGender] = useState("Male");

  // Clinical flags
  const [consciousness, setConsciousness] = useState("Unresponsive");
  const [breathing, setBreathing] = useState("Difficult");
  const [severeBleeding, setSevereBleeding] = useState(true);
  const [chestPain, setChestPain] = useState(false);
  const [suspectedStroke, setSuspectedStroke] = useState(false);
  const [severeTrauma, setSevereTrauma] = useState(true);

  // Live triage preview state
  const [triagePreview, setTriagePreview] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  // Debounced live triage calculation
  useEffect(() => {
    if (!isOpen) return;

    const timer = setTimeout(() => {
      fetch(`${backendUrl}/api/incidents/triage-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chief_complaint: chiefComplaint,
          consciousness_level: consciousness,
          breathing_status: breathing,
          severe_bleeding: severeBleeding,
          chest_pain: chestPain,
          suspected_stroke: suspectedStroke,
          severe_trauma: severeTrauma,
          patient_age: patientAge === "" ? null : Number(patientAge),
        }),
      })
        .then((r) => r.json())
        .then((data) => setTriagePreview(data))
        .catch(() => {});
    }, 200);

    return () => clearTimeout(timer);
  }, [
    isOpen,
    chiefComplaint,
    consciousness,
    breathing,
    severeBleeding,
    chestPain,
    suspectedStroke,
    severeTrauma,
    patientAge,
    backendUrl,
  ]);

  if (!isOpen) return null;

  const handleSelectPreset = (preset: typeof MANGALURU_LOCATION_PRESETS[0]) => {
    setAddress(preset.address);
    setLatitude(preset.lat);
    setLongitude(preset.lon);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("lifelink_token") : null;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${backendUrl}/api/incidents`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          caller_name: callerName,
          caller_phone: callerPhone,
          location_address: address,
          latitude: Number(latitude),
          longitude: Number(longitude),
          chief_complaint: chiefComplaint,
          patient_age: patientAge === "" ? null : Number(patientAge),
          patient_gender: patientGender,
          consciousness_level: consciousness,
          breathing_status: breathing,
          severe_bleeding: severeBleeding,
          chest_pain: chestPain,
          suspected_stroke: suspectedStroke,
          severe_trauma: severeTrauma,
        }),
      });

      if (!res.ok) throw new Error("Failed to register incident");
      const created = await res.json();
      onIncidentCreated(created);
      onClose();
    } catch (err: any) {
      alert(`Error creating incident: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col my-8 max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-50 border border-red-200 flex items-center justify-center text-red-600">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">Emergency Intake & Incident Registration</h2>
              <p className="text-xs text-slate-500">
                Mangaluru Operations • Real-Time Rule Triage Decision Support
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-12 gap-6">
          {/* Left Column: Intake Details */}
          <div className="md:col-span-7 space-y-4">
            {/* Caller Info */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                  <User className="w-3.5 h-3.5 text-blue-600" />
                  Caller Name
                </label>
                <input
                  type="text"
                  required
                  value={callerName}
                  onChange={(e) => setCallerName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:outline-none focus:border-blue-500 transition"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                  <Phone className="w-3.5 h-3.5 text-blue-600" />
                  Caller Phone
                </label>
                <input
                  type="text"
                  required
                  value={callerPhone}
                  onChange={(e) => setCallerPhone(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:outline-none focus:border-blue-500 font-mono transition"
                />
              </div>
            </div>

            {/* Location Selector & Presets */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-700 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-red-500" />
                  Incident Scene Location (Mangaluru)
                </span>
                <span className="text-[10px] text-slate-500">Quick Presets</span>
              </label>

              {/* Quick Presets Pills */}
              <div className="flex flex-wrap gap-1.5">
                {MANGALURU_LOCATION_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => handleSelectPreset(p)}
                    className={`text-[10px] px-2.5 py-1 rounded-md border transition cursor-pointer ${
                      address === p.address
                        ? "bg-blue-50 border-blue-500 text-blue-700 font-semibold"
                        : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>

              <input
                type="text"
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:outline-none focus:border-blue-500 transition"
              />

              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div>
                  <span className="text-slate-500 text-[10px]">Lat:</span>
                  <input
                    type="number"
                    step="0.0001"
                    value={latitude}
                    onChange={(e) => setLatitude(Number(e.target.value))}
                    className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-700 text-[11px]"
                  />
                </div>
                <div>
                  <span className="text-slate-500 text-[10px]">Lon:</span>
                  <input
                    type="number"
                    step="0.0001"
                    value={longitude}
                    onChange={(e) => setLongitude(Number(e.target.value))}
                    className="w-full bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-700 text-[11px]"
                  />
                </div>
              </div>
            </div>

            {/* Chief Complaint */}
            <div>
              <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                <FileText className="w-3.5 h-3.5 text-blue-600" />
                Emergency Dispatch Narrative & Chief Complaint
              </label>
              <textarea
                rows={2}
                required
                value={chiefComplaint}
                onChange={(e) => setChiefComplaint(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2.5 text-xs text-slate-900 focus:bg-white focus:outline-none focus:border-blue-500 transition"
              />
            </div>

            {/* Patient Demographics */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1 block">Patient Age</label>
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={patientAge}
                  onChange={(e) => setPatientAge(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:bg-white"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1 block">Patient Gender</label>
                <select
                  value={patientGender}
                  onChange={(e) => setPatientGender(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-900 focus:bg-white"
                >
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other / Unknown</option>
                </select>
              </div>
            </div>

            {/* Clinical Symptom Flags */}
            <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
              <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-500" />
                Clinical Presentation Flags (Transparent Rules)
              </span>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-[10px] text-slate-500 block mb-1">Consciousness (AVPU)</span>
                  <select
                    value={consciousness}
                    onChange={(e) => setConsciousness(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded px-2.5 py-1 text-xs text-slate-800"
                  >
                    <option value="Alert">Alert (A)</option>
                    <option value="Voice">Voice Responsive (V)</option>
                    <option value="Pain">Pain Responsive (P)</option>
                    <option value="Unresponsive">Unresponsive (U)</option>
                  </select>
                </div>

                <div>
                  <span className="text-[10px] text-slate-500 block mb-1">Breathing Effort</span>
                  <select
                    value={breathing}
                    onChange={(e) => setBreathing(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded px-2.5 py-1 text-xs text-slate-800"
                  >
                    <option value="Normal">Normal Effort</option>
                    <option value="Difficult">Labored / Difficult</option>
                    <option value="Absent">Absent / Agonal</option>
                  </select>
                </div>
              </div>

              {/* Checkboxes */}
              <div className="grid grid-cols-2 gap-2 pt-1 text-xs text-slate-700">
                <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-white">
                  <input
                    type="checkbox"
                    checked={chestPain}
                    onChange={(e) => setChestPain(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-0"
                  />
                  <span>Acute Chest Pain</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-white">
                  <input
                    type="checkbox"
                    checked={severeBleeding}
                    onChange={(e) => setSevereBleeding(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-0"
                  />
                  <span>Severe Bleeding</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-white">
                  <input
                    type="checkbox"
                    checked={suspectedStroke}
                    onChange={(e) => setSuspectedStroke(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-0"
                  />
                  <span>Suspected Stroke (FAST)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-white">
                  <input
                    type="checkbox"
                    checked={severeTrauma}
                    onChange={(e) => setSevereTrauma(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-0"
                  />
                  <span>High-Energy Trauma</span>
                </label>
              </div>
            </div>
          </div>

          {/* Right Column: Live Triage Preview Card */}
          <div className="md:col-span-5 flex flex-col justify-between space-y-4">
            <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <span className="text-xs font-bold text-slate-800">Live Clinical Triage Preview</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-semibold">
                  Automated
                </span>
              </div>

              {triagePreview ? (
                <div className="space-y-3">
                  {/* Priority Tag Banner */}
                  <div
                    className={`p-3 rounded-lg border flex items-center justify-between ${
                      triagePreview.triage_color === "RED"
                        ? "bg-red-50 border-red-200 text-red-700"
                        : triagePreview.triage_color === "YELLOW"
                        ? "bg-amber-50 border-amber-200 text-amber-700"
                        : "bg-emerald-50 border-emerald-200 text-emerald-700"
                    }`}
                  >
                    <div>
                      <div className="text-sm font-extrabold">{triagePreview.triage_level}</div>
                      <div className="text-[10px] opacity-80">
                        Priority Score: {triagePreview.triage_score}/100
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-[10px] font-mono font-bold px-2 py-1 rounded bg-white/90 border border-slate-200 text-slate-800">
                        Req: {triagePreview.required_ambulance_type}
                      </span>
                    </div>
                  </div>

                  {/* Target Hospital Specialty */}
                  <div className="text-xs flex items-center justify-between p-2 rounded bg-white border border-slate-200">
                    <span className="text-slate-500">Target Clinical Dept:</span>
                    <span className="font-semibold text-blue-700">{triagePreview.recommended_specialty}</span>
                  </div>

                  {/* Transparent Rule Justification Trace */}
                  <div className="space-y-1.5">
                    <span className="text-[11px] font-semibold text-slate-600">
                      Rule-Based Decision Rationale:
                    </span>
                    <ul className="space-y-1 text-[11px] text-slate-700">
                      {triagePreview.justifications.map((j: string, idx: number) => (
                        <li key={idx} className="flex items-start gap-1.5">
                          <CheckCircle className="w-3.5 h-3.5 text-blue-600 shrink-0 mt-0.5" />
                          <span>{j}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Disclaimer notice */}
                  <div className="p-2.5 rounded bg-white border border-slate-200 text-[10px] text-slate-500 leading-relaxed">
                    <strong>Notice:</strong> {triagePreview.disclaimer}
                  </div>
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-slate-400 font-mono">
                  Calculating triage assessment...
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-semibold transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-2 px-5 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-md shadow-red-600/20 transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {submitting ? "Registering Incident..." : "Confirm & Open Allocation"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
