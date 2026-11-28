"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import type { AmbulanceTrackingMapProps } from "./AmbulanceTrackingMap";

const DynamicAmbulanceTrackingMap = dynamic<AmbulanceTrackingMapProps>(
  () => import("./AmbulanceTrackingMap"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-80 sm:h-96 min-h-[320px] flex flex-col items-center justify-center bg-slate-900 border border-slate-700 rounded-3xl space-y-2 text-white shadow-md">
        <Loader2 className="w-7 h-7 animate-spin text-blue-500" />
        <p className="text-xs text-slate-300 font-bold tracking-wide">
          Initializing Road Route & Live Navigation Engine...
        </p>
      </div>
    ),
  }
);

export default DynamicAmbulanceTrackingMap;
