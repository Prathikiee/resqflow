"use client";

import React from "react";
import { Menu, PhoneCall, Radio, Shield } from "lucide-react";

interface TopNavProps {
  title: string;
  subtitle?: string;
  wsConnected: boolean;
  connectionStatus?: "connected" | "connecting" | "offline";
  onMenuToggle: () => void;
  actions?: React.ReactNode;
}

export default function TopNav({
  title,
  subtitle,
  wsConnected,
  connectionStatus,
  onMenuToggle,
  actions,
}: TopNavProps) {
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-slate-200 px-4 py-3 sm:px-6">
      <div className="flex items-center justify-between gap-4">
        {/* Left: Mobile hamburger & Page Title */}
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuToggle}
            className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 md:hidden"
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-base sm:text-lg font-extrabold text-slate-900 tracking-tight flex items-center gap-2">
              {title}
            </h1>
            {subtitle && (
              <p className="text-xs text-slate-500 font-medium hidden sm:block">
                {subtitle}
              </p>
            )}
          </div>
        </div>

        {/* Right: Live Connection, Call 112 Badge, & Actions */}
        <div className="flex items-center gap-2.5 sm:gap-3">
          {/* Real-Time WebSocket Indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-50 border border-slate-200 text-xs font-semibold">
            <span
              className={`w-2 h-2 rounded-full ${
                wsConnected
                  ? "bg-emerald-500 animate-pulse"
                  : connectionStatus === "connecting"
                  ? "bg-amber-500 animate-pulse"
                  : "bg-slate-400"
              }`}
            />
            <span className="text-[11px] text-slate-600 hidden sm:inline">
              {wsConnected
                ? "Live Sync"
                : connectionStatus === "connecting"
                ? "Connecting..."
                : "Offline (Polling Active)"}
            </span>
          </div>

          {/* Emergency 112 Direct Access Pill */}
          <a
            href="tel:112"
            className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 border border-red-200 text-red-700 text-xs font-bold hover:bg-red-100 transition"
            title="National Emergency Helpline"
          >
            <PhoneCall className="w-3.5 h-3.5" />
            <span>Dial 112</span>
          </a>

          {/* Custom Action Buttons (e.g. New Incident, Reset DB, Duty Toggle) */}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      </div>
    </header>
  );
}
