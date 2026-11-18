"use client";

import React from "react";
import {
  Activity,
  Ambulance,
  Building2,
  ChevronRight,
  LogOut,
  Radio,
  Shield,
  User,
  X,
} from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  count?: number;
}

interface SidebarProps {
  role: "DISPATCHER" | "AMBULANCE" | "HOSPITAL";
  roleLabel: string;
  user: any;
  currentNav: string;
  onNavChange: (id: string) => void;
  navItems: NavItem[];
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  onLogout: () => void;
  entityName?: string;
}

export default function Sidebar({
  role,
  roleLabel,
  user,
  currentNav,
  onNavChange,
  navItems,
  isOpenMobile,
  onCloseMobile,
  onLogout,
  entityName,
}: SidebarProps) {
  const getRoleBadge = () => {
    switch (role) {
      case "DISPATCHER":
        return {
          bg: "bg-red-50",
          text: "text-red-700",
          border: "border-red-200",
          iconBg: "bg-red-600",
        };
      case "AMBULANCE":
        return {
          bg: "bg-blue-50",
          text: "text-blue-700",
          border: "border-blue-200",
          iconBg: "bg-blue-600",
        };
      case "HOSPITAL":
        return {
          bg: "bg-emerald-50",
          text: "text-emerald-700",
          border: "border-emerald-200",
          iconBg: "bg-emerald-600",
        };
      default:
        return {
          bg: "bg-slate-100",
          text: "text-slate-800",
          border: "border-slate-200",
          iconBg: "bg-slate-800",
        };
    }
  };

  const badge = getRoleBadge();

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 bg-slate-900/30 backdrop-blur-xs z-40 md:hidden transition-opacity"
          onClick={onCloseMobile}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-50 w-64 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 ease-in-out md:translate-x-0 ${
          isOpenMobile ? "translate-x-0 shadow-xl" : "-translate-x-full md:shadow-none"
        }`}
      >
        {/* Brand Header */}
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl ${badge.iconBg} flex items-center justify-center text-white shadow-xs`}>
              <Radio className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span className="font-extrabold text-base tracking-tight text-slate-900">LIFELINK</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${badge.bg} ${badge.text} ${badge.border}`}>
                  {role}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium">Emergency Response Platform</p>
            </div>
          </div>
          <button
            onClick={onCloseMobile}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 md:hidden"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Role Identification Subheader */}
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200/80">
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Operational Console</p>
          <p className="text-xs font-bold text-slate-900 truncate mt-0.5">
            {entityName || roleLabel}
          </p>
        </div>

        {/* Navigation Items */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onNavChange(item.id);
                  onCloseMobile();
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                  isActive
                    ? "bg-blue-50 text-blue-700 font-bold border border-blue-200/80 shadow-2xs"
                    : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className={`w-4 h-4 ${isActive ? "text-blue-600" : "text-slate-400"}`} />
                  <span>{item.label}</span>
                </div>
                {item.count !== undefined && item.count > 0 && (
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full font-bold ${
                      isActive ? "bg-blue-600 text-white" : "bg-slate-200 text-slate-700"
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* User Profile & Logout at Bottom */}
        <div className="p-3 border-t border-slate-200 bg-slate-50">
          <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-white border border-slate-200">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700 shrink-0 font-bold text-xs">
                {user?.full_name ? user.full_name.charAt(0).toUpperCase() : "U"}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-bold text-slate-900 truncate">{user?.full_name || "Authorized User"}</p>
                <p className="text-[10px] text-slate-500 truncate">{user?.email || "online"}</p>
              </div>
            </div>
            <button
              onClick={onLogout}
              className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition shrink-0"
              title="Sign Out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
