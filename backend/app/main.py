import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session
from backend.app.core.config import settings
from backend.app.core.database import get_db, Base, engine, SessionLocal, upgrade_schema
from backend.app.services.seed_service import seed_database
from backend.app.core.ws import ws_manager
from backend.app.core.security import decode_access_token
from backend.app.api import incidents, ambulances, hospitals, seed, dispatch, witness_reports, auth
from backend.app.api.dispatch import check_and_escalate_expired_dispatches

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create tables & safely upgrade schema if new columns exist
Base.metadata.create_all(bind=engine)
upgrade_schema(engine)

async def run_escalation_worker():
    """
    Lightweight in-process background worker that periodically sweeps
    expired pending confirmation dispatches every 5 seconds and automatically
    triggers smart escalation.
    """
    logger.info("Starting ResQFlow Smart Emergency Escalation background worker (poll: 5s)...")
    while True:
        try:
            await asyncio.sleep(5)
            db = SessionLocal()
            try:
                check_and_escalate_expired_dispatches(db)
            except Exception as e:
                logger.debug(f"Escalation sweep note: {e}")
            finally:
                db.close()
        except asyncio.CancelledError:
            logger.info("Escalation background worker stopped.")
            break
        except Exception as e:
            logger.warning(f"Unexpected error in escalation worker loop: {e}")

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

    worker_task = asyncio.create_task(run_escalation_worker())
    try:
        yield
    finally:
        worker_task.cancel()
        try:
            await worker_task
        except asyncio.CancelledError:
            pass

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
app.include_router(auth.router)
app.include_router(incidents.router)
app.include_router(ambulances.router)
app.include_router(hospitals.router)
app.include_router(dispatch.router)
app.include_router(witness_reports.router)
app.include_router(seed.router)

def authenticate_websocket_connection(websocket: WebSocket):
    """
    Validates token from query parameter, cookie, or authorization header.
    Returns decoded token payload dict if valid, or None if unauthenticated.
    """
    token = (
        websocket.query_params.get("token")
        or websocket.cookies.get("lifelink_token")
    )
    if not token:
        auth_header = websocket.headers.get("authorization")
        if auth_header and auth_header.lower().startswith("bearer "):
            token = auth_header.split(" ", 1)[1].strip()

    if not token:
        return None

    return decode_access_token(token)

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    payload = authenticate_websocket_connection(websocket)
    if not payload:
        await websocket.close(code=4001, reason="Unauthorized: Valid authentication token required")
        return

    client = await ws_manager.connect(websocket, user_meta=payload)
    try:
        await websocket.send_json({
            "event": "HANDSHAKE",
            "status": "connected",
            "service": "ResQFlow Live Feed",
            "region": settings.DEFAULT_CITY,
            "user": {
                "id": payload.get("sub"),
                "email": payload.get("email"),
                "role": payload.get("role"),
                "ambulance_id": payload.get("ambulance_id"),
                "hospital_id": payload.get("hospital_id"),
                "facility_code": payload.get("facility_code"),
            },
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
