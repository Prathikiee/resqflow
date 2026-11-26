"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, Shield, Ambulance, Building2, User, KeyRound, AlertTriangle, ArrowRight } from "lucide-react";

interface DemoAccount {
  label: string;
  role: string;
  email: string;
  password?: string;
  description: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
}

const HOSPITAL_DEMO_ACCOUNTS = [
  { name: "KMC Hospital (Ambedkar Circle)", email: "kmc@lifelink.demo", password: "Kmc#HospitalPass2026!Mangaluru", code: "KMC-AMB-01" },
  { name: "A.J. Hospital & Research Centre", email: "aj@lifelink.demo", password: "Aj#HospitalPass2026!Mangaluru", code: "AJH-KUN-02" },
  { name: "Unity Hospital (Kankanady)", email: "unity@lifelink.demo", password: "Unity#HospitalPass2026!Mangaluru", code: "UNT-KAN-03" },
  { name: "Indiana Hospital (Pumpwell)", email: "indiana@lifelink.demo", password: "Indiana#HospitalPass2026!Mangaluru", code: "IND-PUM-04" },
  { name: "Yenepoya Speciality Hospital", email: "yenepoya@lifelink.demo", password: "Yenepoya#HospitalPass2026!Mangaluru", code: "YEN-KOD-05" },
  { name: "Father Muller Medical College Hospital", email: "fathermuller@lifelink.demo", password: "FatherMuller#HospitalPass2026!Mangaluru", code: "FMM-KAN-06" },
  { name: "City Hospital Research Centre", email: "cityhospital@lifelink.demo", password: "CityHospital#HospitalPass2026!Mangaluru", code: "CTH-MGL-07" },
  { name: "Highland Hospital (Falnir)", email: "highland@lifelink.demo", password: "Highland#HospitalPass2026!Mangaluru", code: "HGH-FLN-08" },
  { name: "Tejasvini Hospital (Kadri)", email: "tejasvini@lifelink.demo", password: "Tejasvini#HospitalPass2026!Mangaluru", code: "TEJ-KDR-09" },
  { name: "Mangala Hospital (Kadri)", email: "mangala@lifelink.demo", password: "Mangala#HospitalPass2026!Mangaluru", code: "MGL-MGL-10" },
];

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    label: "Regional Dispatcher HQ",
    role: "DISPATCHER",
    email: "dispatcher@lifelink.demo",
    password: "Lifelink@2026!",
    description: "Regional GIS command center, fleet tracking & manual reassignment",
    badgeBg: "bg-red-50",
    badgeText: "text-red-700",
    badgeBorder: "border-red-200",
  },
  {
    label: "Paramedic Unit (ALS-101)",
    role: "AMBULANCE_CREW",
    email: "als101@lifelink.demo",
    password: "Lifelink@2026!",
    description: "KA-19-ALS-101 mission acceptance, live GPS & lifecycle stepping",
    badgeBg: "bg-blue-50",
    badgeText: "text-blue-700",
    badgeBorder: "border-blue-200",
  },
  {
    label: "Paramedic Unit (ALS-103)",
    role: "AMBULANCE_CREW",
    email: "als103@lifelink.demo",
    password: "Lifelink@2026!",
    description: "KA-19-ALS-103 mission acceptance, vitals telemetry & hospital arrival",
    badgeBg: "bg-blue-50",
    badgeText: "text-blue-700",
    badgeBorder: "border-blue-200",
  },
  {
    label: "Hospital ER (KMC)",
    role: "HOSPITAL_STAFF",
    email: "kmc@lifelink.demo",
    password: "Kmc#HospitalPass2026!Mangaluru",
    description: "KMC Ambedkar Circle bed reservation & pre-arrival handover review",
    badgeBg: "bg-emerald-50",
    badgeText: "text-emerald-700",
    badgeBorder: "border-emerald-200",
  },
  {
    label: "Hospital ER (Father Muller)",
    role: "HOSPITAL_STAFF",
    email: "fathermuller@lifelink.demo",
    password: "FatherMuller#HospitalPass2026!Mangaluru",
    description: "Father Muller Kankanady bed reservation & pre-arrival handover review",
    badgeBg: "bg-emerald-50",
    badgeText: "text-emerald-700",
    badgeBorder: "border-emerald-200",
  },
  {
    label: "Citizen SOS Reporter",
    role: "CITIZEN",
    email: "citizen@lifelink.demo",
    password: "Lifelink@2026!",
    description: "Civilian emergency request, private tracking & witness intelligence",
    badgeBg: "bg-amber-50",
    badgeText: "text-amber-800",
    badgeBorder: "border-amber-200",
  },
  {
    label: "Super Administrator",
    role: "SUPER_ADMIN",
    email: "admin@lifelink.demo",
    password: "Lifelink@2026!",
    description: "Regional emergency service authority & user account management",
    badgeBg: "bg-purple-50",
    badgeText: "text-purple-700",
    badgeBorder: "border-purple-200",
  },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("dispatcher@lifelink.demo");
  const [password, setPassword] = useState("Lifelink@2026!");
  const [selectedRole, setSelectedRole] = useState("DISPATCHER");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selectDemoAccount = (acc: DemoAccount) => {
    setEmail(acc.email);
    setPassword(acc.password || "Lifelink@2026!");
    setSelectedRole(acc.role);
    setErrorMsg(null);
  };

  const selectHospitalAccount = (emailVal: string) => {
    const found = HOSPITAL_DEMO_ACCOUNTS.find((h) => h.email === emailVal);
    if (found) {
      setEmail(found.email);
      setPassword(found.password);
      setSelectedRole("HOSPITAL_STAFF");
      setErrorMsg(null);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

    try {
      const resp = await fetch(`${backendUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.detail || `Authentication failed (${resp.status})`);
      }

      const data = await resp.json();
      const token = data.access_token;
      const user = data.user;

      if (typeof window !== "undefined") {
        localStorage.setItem("lifelink_token", token);
        localStorage.setItem("lifelink_user", JSON.stringify(user));
        localStorage.removeItem("lifelink_active_incident_id");
        // 30 days = 2592000 seconds for persistent session
        document.cookie = `lifelink_token=${token}; path=/; max-age=2592000; SameSite=Lax`;
      }

      if (user.role === "CITIZEN") {
        router.push("/citizen");
      } else if (user.role === "AMBULANCE_CREW") {
        router.push("/ambulance");
      } else if (user.role === "HOSPITAL_STAFF") {
        router.push("/hospital");
      } else if (user.role === "DISPATCHER" || user.role === "SUPER_ADMIN") {
        router.push("/dispatcher");
      } else {
        router.push("/dispatcher");
      }
    } catch (err: any) {
      setErrorMsg(err.message || "Unable to connect to authentication service.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-center items-center p-4 sm:p-6 font-sans">
      {/* Brand Header */}
      <div className="w-full max-w-xl text-center mb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-bold uppercase tracking-wider mb-2.5">
          <Radio className="w-3.5 h-3.5 text-red-600 animate-pulse" />
          <span>Mangaluru Emergency Response Corridor</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 flex items-center justify-center gap-2">
          <span>LIFELINK</span>
          <span className="text-slate-400 font-semibold text-2xl sm:text-3xl">/ ResQFlow</span>
        </h1>
        <p className="mt-1.5 text-xs text-slate-500 max-w-md mx-auto">
          Role-Based Emergency Coordination, Dual-Confirmation Dispatch & Clinical Handover Network
        </p>
      </div>

      {/* Main Login Card */}
      <div className="w-full max-w-xl bg-white border border-slate-200 rounded-2xl shadow-sm p-6 sm:p-8 space-y-6">
        {/* Quick Demo Selector */}
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider font-mono mb-2.5">
            1-Click Instant Demo Authentication
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {DEMO_ACCOUNTS.map((acc) => (
              <button
                key={acc.email}
                type="button"
                onClick={() => selectDemoAccount(acc)}
                className={`text-left p-3 rounded-xl border transition-all text-xs flex flex-col justify-between cursor-pointer ${
                  email === acc.email
                    ? "bg-blue-50/70 border-blue-400 shadow-2xs ring-1 ring-blue-400"
                    : "bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <strong className="text-slate-900 font-bold truncate text-xs">{acc.label}</strong>
                  <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded border font-bold ${acc.badgeBg} ${acc.badgeText} ${acc.badgeBorder}`}>
                    {acc.role}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 line-clamp-1">{acc.description}</p>
              </button>
            ))}
          </div>

          {/* Mangaluru 10 Hospitals Selector */}
          <div className="mt-3 pt-3 border-t border-slate-100">
            <label className="block text-[11px] font-semibold text-slate-600 mb-1 flex items-center justify-between">
              <span>Switch Hospital ER Account (10 Mangaluru Facilities):</span>
              <span className="text-[10px] text-emerald-600 font-mono font-medium">Isolated Facility Context</span>
            </label>
            <select
              value={email.endsWith("@lifelink.demo") && HOSPITAL_DEMO_ACCOUNTS.some(h => h.email === email) ? email : ""}
              onChange={(e) => {
                if (e.target.value) selectHospitalAccount(e.target.value);
              }}
              className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            >
              <option value="" disabled>-- Select one of 10 Mangaluru Demo Hospitals --</option>
              {HOSPITAL_DEMO_ACCOUNTS.map((hosp) => (
                <option key={hosp.email} value={hosp.email}>
                  {hosp.name} [{hosp.code}]
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Credentials Form */}
        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Authorized Account Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@lifelink.demo"
              className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Security Credential (Password)
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full px-3.5 py-2.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className={`w-full py-3 rounded-xl font-bold text-xs transition-all flex items-center justify-center gap-2 shadow-sm cursor-pointer ${
              isLoading
                ? "bg-slate-300 text-slate-500 cursor-not-allowed"
                : "bg-red-600 hover:bg-red-700 text-white shadow-red-600/20 active:scale-[0.99]"
            }`}
          >
            {isLoading ? (
              <span>Verifying Credentials...</span>
            ) : (
              <>
                <span>Sign In to {selectedRole.replace(/_/g, " ")} Portal</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <div className="pt-3 border-t border-slate-100 text-center">
          <p className="text-[11px] font-mono text-slate-400">
            ResQFlow Regional Emergency Hub (Mangaluru) • Encrypted JWT session with bcrypt verification
          </p>
        </div>
      </div>
    </div>
  );
}
