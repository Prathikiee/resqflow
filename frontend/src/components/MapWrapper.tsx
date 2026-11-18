"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// Dynamically import Leaflet with SSR disabled
const DynamicCommandCenterMap = dynamic(
  () => import("./CommandCenterMap"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full min-h-[480px] flex flex-col items-center justify-center bg-slate-100 border border-slate-200 rounded-xl space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        <p className="text-xs text-slate-500 font-mono">
          Loading Mangaluru Emergency GIS & Route Canvas...
        </p>
      </div>
    ),
  }
);

export default DynamicCommandCenterMap;
