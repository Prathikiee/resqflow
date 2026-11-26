import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges class names using clsx and tailwind-merge.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats a distance in meters into a readable human-friendly string with sensible units (m or km).
 *
 * @param meters - Distance in meters (can be number, numeric string, or null/undefined)
 * @returns Formatted distance string (e.g. "450 m", "2.4 km")
 */
export function formatDistance(meters?: number | string | null): string {
  if (meters === null || meters === undefined || meters === "") {
    return "0 m";
  }

  const numericMeters = typeof meters === "string" ? Number(meters) : meters;

  if (isNaN(numericMeters) || numericMeters <= 0) {
    return "0 m";
  }

  if (numericMeters < 1000) {
    return `${Math.round(numericMeters)} m`;
  }

  const km = numericMeters / 1000;
  if (km >= 100) {
    return `${Math.round(km)} km`;
  }

  return `${km.toFixed(1)} km`;
}

/**
 * Formats a duration in seconds into readable time units (e.g. "45s", "4 mins", "4m 30s", "1h 15m").
 *
 * @param seconds - Duration in seconds (can be number, numeric string, or null/undefined)
 * @returns Formatted duration string with readable units
 */
export function formatDuration(seconds?: number | string | null): string {
  if (seconds === null || seconds === undefined || seconds === "") {
    return "0s";
  }

  const numericSeconds = typeof seconds === "string" ? Number(seconds) : seconds;

  if (isNaN(numericSeconds) || numericSeconds <= 0) {
    return "0s";
  }

  const totalSeconds = Math.round(numericSeconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    if (minutes > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${hours}h`;
  }

  if (minutes > 0) {
    if (remainingSeconds > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${minutes} min${minutes > 1 ? "s" : ""}`;
  }

  return `${remainingSeconds}s`;
}

/**
 * Safely parses any date string from the backend into a valid Date object.
 * Backend stores UTC timestamps without timezone offset (naive UTC), e.g. "2026-11-26T05:19:00.123456"
 * or "2026-11-26 05:19:00".
 * Standard JavaScript new Date("...") treats strings without a timezone offset or 'Z' as LOCAL time,
 * causing an offset distortion (e.g. losing the 5h30m IST offset).
 * This function ensures strings without timezone offsets are treated as UTC.
 */
export function parseUtcDate(dateInput?: string | Date | number | null): Date | null {
  if (!dateInput) return null;
  if (dateInput instanceof Date) {
    return isNaN(dateInput.getTime()) ? null : dateInput;
  }
  if (typeof dateInput === "number") {
    const d = new Date(dateInput);
    return isNaN(d.getTime()) ? null : d;
  }
  let s = String(dateInput).trim();
  if (!s) return null;

  // Replace space with 'T' for ISO compatibility (e.g., "2026-11-26 05:19:00" -> "2026-11-26T05:19:00")
  if (s.includes(" ") && !s.includes("T")) {
    s = s.replace(" ", "T");
  }

  // If there is no trailing Z or timezone offset (+HH:MM / -HH:MM / +HHMM / -HHMM), append Z
  const hasTimezone = /[zZ]$|[+-]\d{2}(:?\d{2})?$/.test(s);
  if (!hasTimezone) {
    s = s + "Z";
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d;
  }
  const fallback = new Date(dateInput);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Formats a date into Indian Standard Time (IST - Asia/Kolkata, UTC+05:30)
 * Example: "26 Nov 2026, 10:49 am IST"
 */
export function formatIST(
  dateInput?: string | Date | number | null,
  options?: { includeSeconds?: boolean; dateOnly?: boolean; timeOnly?: boolean }
): string {
  const d = parseUtcDate(dateInput);
  if (!d) return "";
  try {
    if (options?.timeOnly) {
      return (
        new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "numeric",
          minute: "numeric",
          second: options?.includeSeconds ? "numeric" : undefined,
          hour12: true,
        }).format(d) + " IST"
      );
    }
    if (options?.dateOnly) {
      return new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(d);
    }
    return (
      new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: options?.includeSeconds ? "numeric" : undefined,
        hour12: true,
      }).format(d) + " IST"
    );
  } catch {
    return String(dateInput);
  }
}

/**
 * Computes remaining seconds until an expiration timestamp, properly UTC normalized.
 */
export function getRemainingSeconds(expirationTime?: string | Date | number | null): number {
  const expDate = parseUtcDate(expirationTime);
  if (!expDate) return 0;
  const expMs = expDate.getTime();
  const nowMs = Date.now();
  return Math.max(0, Math.floor((expMs - nowMs) / 1000));
}
