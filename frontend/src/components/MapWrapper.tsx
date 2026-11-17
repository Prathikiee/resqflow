"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// Dynamically import Leaflet with SSR disabled
const DynamicCommandCenterMap = dynamic(
  () => import("./CommandCenterMap"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex flex-col items-center justify-center bg-slate-950 border border-slate-800 rounded-xl space-y-3">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        <p className="text-xs text-slate-400 font-mono">
          Loading Mangaluru Emergency GIS & Route Canvas...
        </p>
      </div>
    ),
  }
);

export default DynamicCommandCenterMap;
