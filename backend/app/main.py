import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session
from backend.app.core.config import settings
from backend.app.core.database import get_db, Base, engine, SessionLocal
from backend.app.services.seed_service import seed_database
from backend.app.core.ws import ws_manager
from backend.app.api import incidents, ambulances, hospitals, seed, dispatch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create tables
Base.metadata.create_all(bind=engine)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Auto-seed Mangaluru operational fleet on first launch if empty
    db = SessionLocal()
    try:
        seed_database(db, force=False)
    except Exception as e:
        logger.warning(f"Auto-seed during startup skipped: {e}")
    finally:
        db.close()
    yield

app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="ResQFlow — Emergency Response and Ambulance Coordination Platform (Mangaluru Region)",
    lifespan=lifespan,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register Routers
app.include_router(incidents.router)
app.include_router(ambulances.router)
app.include_router(hospitals.router)
app.include_router(dispatch.router)
app.include_router(seed.router)

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        await websocket.send_json({
            "event": "HANDSHAKE",
            "status": "connected",
            "service": "ResQFlow Live Feed",
            "region": settings.DEFAULT_CITY,
        })
        while True:
            text_data = await websocket.receive_text()
            if text_data == "ping":
                await websocket.send_json({"event": "PONG"})
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        logger.warning(f"WebSocket closed: {e}")
        ws_manager.disconnect(websocket)

@app.get("/")
def root():
    return {
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "region": settings.DEFAULT_CITY,
        "status": "operational",
        "docs_url": "/docs",
    }

@app.get("/health")
@app.get("/api/health")
def health_check(db: Session = Depends(get_db)):
    db_status = "connected"
    db_backend = "sqlite" if settings.effective_database_url.startswith("sqlite") else "postgresql"
    try:
        db.execute(text("SELECT 1"))
    except Exception as e:
        logger.error(f"Database health check failed: {e}")
        db_status = f"unhealthy: {str(e)}"

    return {
        "status": "healthy" if "unhealthy" not in db_status else "degraded",
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "database": {
            "status": db_status,
            "engine": db_backend,
        },
        "region": {
            "city": settings.DEFAULT_CITY,
            "latitude": settings.DEFAULT_LATITUDE,
            "longitude": settings.DEFAULT_LONGITUDE,
        },
    }
