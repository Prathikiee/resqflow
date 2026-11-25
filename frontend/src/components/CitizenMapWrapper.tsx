"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const DynamicCitizenTrackingMap = dynamic(
  () => import("./CitizenTrackingMap"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-64 sm:h-72 flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
        <Loader2 className="w-6 h-6 animate-spin text-red-600" />
        <p className="text-xs text-slate-500 font-medium">
          Loading Emergency GIS Map...
        </p>
      </div>
    ),
  }
);

export default DynamicCitizenTrackingMap;
