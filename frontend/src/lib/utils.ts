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
