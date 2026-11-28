#!/usr/bin/env python
"""
ResQFlow Clean Demo Reset Script
Transactionally wipes all operational emergencies, dispatches, handovers, vitals,
and incident history while preserving all 30 hospitals, doctors, departments,
ambulances, and users.
"""
import sys
import os
from pathlib import Path

# Add backend directory to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.core.database import SessionLocal
from backend.app.services.clean_reset_service import execute_clean_demo_reset

def main():
    print("=" * 65)
    print("       RESQFLOW — CLEAN DEMO RESET (OPERATIONAL EMERGENCIES)")
    print("=" * 65)
    
    db = SessionLocal()
    try:
        result = execute_clean_demo_reset(db, broadcast=True)
        print("\n[SUCCESS] Clean Demo Reset Completed Successfully!\n")
        print("DATABASE COUNTS BEFORE -> AFTER:")
        print("-" * 45)
        for entity in ["incidents", "dispatches", "handover_packets", "incident_events", "witness_reports", "crash_alerts", "patient_vitals"]:
            b = result["counts_before"].get(entity, 0)
            a = result["counts_after"].get(entity, 0)
            print(f"  * {entity:<20} {b:>4} -> {a:>4}  (Deleted: {result['deleted'].get(entity, 0)})")
            
        print("\nPRESERVED MASTER DATA:")
        print("-" * 45)
        for entity in ["hospitals", "ambulances", "users"]:
            cnt = result["preserved"].get(entity, 0)
            print(f"  * {entity:<20} {cnt:>4} (Preserved)")
            
        print("\nSTATUS SUMMARY:")
        print(f"  * Incidents remaining:  {result['counts_after']['incidents']}")
        print(f"  * Dispatches remaining: {result['counts_after']['dispatches']}")
        print(f"  * Hospitals available:  {result['counts_after']['hospitals']}")
        print(f"  * Ambulances available: {result['counts_after']['ambulances']}")
        print(f"  * Users active:         {result['counts_after']['users']}")
        print("=" * 65)
    except Exception as e:
        print(f"\n[ERROR] Demo reset failed: {e}")
        db.rollback()
        sys.exit(1)
    finally:
        db.close()

if __name__ == "__main__":
    main()
