"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import type { AmbulanceTrackingMapProps } from "./AmbulanceTrackingMap";

const DynamicAmbulanceTrackingMap = dynamic<AmbulanceTrackingMapProps>(
  () => import("./AmbulanceTrackingMap"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-80 sm:h-96 flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
        <p className="text-xs text-slate-500 font-medium">
          Initializing Mission Navigation Map...
        </p>
      </div>
    ),
  }
);

export default DynamicAmbulanceTrackingMap;
