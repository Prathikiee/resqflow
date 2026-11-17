import os
import sys

# Ensure root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.app.core.database import SessionLocal, Base, engine
from backend.app.services.seed_service import seed_database

def main():
    print("Creating tables if not exists...")
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        print("Seeding Mangaluru operational data (Hospitals, Ambulances, Demonstration Incident)...")
        results = seed_database(db, force=True)
        print(f"Success! Seeded: {results}")
    finally:
        db.close()

if __name__ == "__main__":
    main()
