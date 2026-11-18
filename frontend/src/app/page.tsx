"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Radio,
  Ambulance,
  Building2,
  Shield,
  PhoneCall,
  ArrowRight,
  Activity,
  CheckCircle2,
  Lock,
  Layers,
  HeartHandshake,
  Clock,
  Compass,
} from "lucide-react";

interface RoleCard {
  title: string;
  roleCode: string;
  badge: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  description: string;
  href: string;
  icon: any;
  color: string;
  sampleUser: string;
}

const ROLE_CARDS: RoleCard[] = [
  {
    title: "Citizen SOS Portal",
    roleCode: "CITIZEN",
    badge: "Public Civilian",
    badgeBg: "bg-red-50",
    badgeText: "text-red-700",
    badgeBorder: "border-red-200",
    description: "1-Tap high-priority emergency SOS, live browser GPS geolocation, voice symptom dictation & ambulance ETA.",
    href: "/citizen",
    icon: Radio,
    color: "from-red-600 to-rose-600",
    sampleUser: "citizen@lifelink.demo",
  },
  {
    title: "Ambulance Paramedic Terminal",
    roleCode: "AMBULANCE_CREW",
    badge: "ALS / BLS Fleet",
    badgeBg: "bg-blue-50",
    badgeText: "text-blue-700",
    badgeBorder: "border-blue-200",
    description: "In-vehicle tactical response, 90s dual-confirmation acceptance, turn-by-turn GIS navigation & lifecycle stepping.",
    href: "/ambulance",
    icon: Ambulance,
    color: "from-blue-600 to-indigo-600",
    sampleUser: "als101@lifelink.demo",
  },
  {
    title: "Hospital ER Receiving Console",
    roleCode: "HOSPITAL_STAFF",
    badge: "Trauma Facility",
    badgeBg: "bg-emerald-50",
    badgeText: "text-emerald-700",
    badgeBorder: "border-emerald-200",
    description: "Emergency bay capacity management, pre-arrival SBAR digital clinical handover inspection & formal clinician sign-off.",
    href: "/hospital",
    icon: Building2,
    color: "from-emerald-600 to-teal-600",
    sampleUser: "kmc@lifelink.demo",
  },
  {
    title: "Regional Dispatcher Command HQ",
    roleCode: "DISPATCHER",
    badge: "Command Authority",
    badgeBg: "bg-purple-50",
    badgeText: "text-purple-700",
    badgeBorder: "border-purple-200",
    description: "Metro GIS incident map, multi-witness deduplication, smart resource allocation, dual confirmation & timeline audit.",
    href: "/dispatcher",
    icon: Compass,
    color: "from-purple-600 to-violet-700",
    sampleUser: "dispatcher@lifelink.demo",
  },
];

export default function PlatformGatewayPage() {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Auto-redirect authenticated users to their assigned dashboard
  useEffect(() => {
    if (typeof window !== "undefined") {
      const token = localStorage.getItem("lifelink_token");
      const userStr = localStorage.getItem("lifelink_user");

      if (token && userStr) {
        try {
          const user = JSON.parse(userStr);
          setCurrentUser(user);

          if (user.role === "CITIZEN") {
            router.replace("/citizen");
            return;
          } else if (user.role === "AMBULANCE_CREW") {
            router.replace("/ambulance");
            return;
          } else if (user.role === "HOSPITAL_STAFF") {
            router.replace("/hospital");
            return;
          } else if (user.role === "DISPATCHER" || user.role === "SUPER_ADMIN") {
            router.replace("/dispatcher");
            return;
          }
        } catch (_) {}
      }
      setCheckingAuth(false);
    }
  }, [router]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="flex items-center gap-3 bg-white px-5 py-3 rounded-xl border border-slate-200 shadow-sm">
          <Activity className="w-5 h-5 text-red-600 animate-pulse" />
          <span className="text-xs font-semibold text-slate-700">Connecting to LIFELINK Corridor...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans selection:bg-red-100 selection:text-red-900">
      {/* Top Application Bar */}
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur px-6 py-3.5 flex items-center justify-between sticky top-0 z-40 shadow-2xs">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-red-600 flex items-center justify-center text-white shadow-md shadow-red-600/20">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black tracking-tight text-slate-900">LIFELINK</h1>
              <span className="text-xs font-semibold text-slate-400">/ ResQFlow Platform</span>
            </div>
            <p className="text-[11px] text-slate-500 font-mono">
              Unified Four-Role Emergency Response & Healthcare Corridor
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="tel:112"
            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-mono font-bold hover:bg-emerald-100 transition"
          >
            <PhoneCall className="w-3.5 h-3.5 text-emerald-600" />
            <span>Emergency 112</span>
          </a>

          <button
            onClick={() => router.push("/login")}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-md shadow-red-600/20 transition cursor-pointer"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Sign In to Unified Portal</span>
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-8 space-y-8">
        <div className="text-center space-y-3 max-w-2xl mx-auto pt-4">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-bold uppercase tracking-wider font-mono">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>Live Emergency Coordination Network</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900">
            One Connected Emergency Response Platform
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 leading-relaxed">
            Every role receives a dedicated, minimal interface operating on a shared transactional backend, authoritative reservation engine, and real-time WebSocket infrastructure.
          </p>
        </div>

        {/* 4 Dedicated Role Portal Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {ROLE_CARDS.map((card) => {
            const Icon = card.icon;

            return (
              <div
                key={card.roleCode}
                className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs hover:shadow-md transition-all flex flex-col justify-between space-y-4 group"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between">
                    <div className={`w-12 h-12 rounded-xl bg-linear-to-br ${card.color} text-white flex items-center justify-center shadow-md`}>
                      <Icon className="w-6 h-6" />
                    </div>
                    <span className={`text-[10px] font-mono font-bold uppercase px-2.5 py-1 rounded-full border ${card.badgeBg} ${card.badgeText} ${card.badgeBorder}`}>
                      {card.badge}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-lg font-black text-slate-900 group-hover:text-red-600 transition">
                      {card.title}
                    </h3>
                    <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                      {card.description}
                    </p>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-[11px] font-mono text-slate-400">
                    Demo: <strong className="text-slate-700">{card.sampleUser}</strong>
                  </span>

                  <button
                    onClick={() => router.push(card.href)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-red-600 text-white text-xs font-bold transition cursor-pointer"
                  >
                    <span>Launch Portal</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* 5-Step Unified Lifecycle Infographic */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-red-600" />
            <h4 className="text-xs font-bold font-mono uppercase tracking-wider text-slate-800">
              End-to-End Operational Workflow Integration
            </h4>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 text-xs">
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <span className="text-[10px] font-mono font-bold text-red-600 block">01 • CITIZEN</span>
              <strong className="block text-slate-800">Trigger SOS</strong>
              <p className="text-[10px] text-slate-500 leading-tight">GPS lock & instant distress signal broadcast</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <span className="text-[10px] font-mono font-bold text-purple-600 block">02 • DISPATCHER</span>
              <strong className="block text-slate-800">Allocate Unit</strong>
              <p className="text-[10px] text-slate-500 leading-tight">Smart ranking & 90s dual reservation</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <span className="text-[10px] font-mono font-bold text-blue-600 block">03 • AMBULANCE</span>
              <strong className="block text-slate-800">Accept & Respond</strong>
              <p className="text-[10px] text-slate-500 leading-tight">Turn-by-turn navigation to patient scene</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <span className="text-[10px] font-mono font-bold text-emerald-600 block">04 • HOSPITAL</span>
              <strong className="block text-slate-800">Confirm ER Bay</strong>
              <p className="text-[10px] text-slate-500 leading-tight">Pre-arrival SBAR digital packet review</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
              <span className="text-[10px] font-mono font-bold text-slate-900 block">05 • RESOLUTION</span>
              <strong className="block text-slate-800">Safe Handover</strong>
              <p className="text-[10px] text-slate-500 leading-tight">Clinician acknowledgment & resource release</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
