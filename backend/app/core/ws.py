import logging
import asyncio
from typing import List, Dict, Any
from fastapi import WebSocket

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket client connected. Total active: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"WebSocket client disconnected. Total active: {len(self.active_connections)}")

    async def broadcast(self, event_type: str, data: Dict[str, Any]):
        message = {"event": event_type, "payload": data}
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.warning(f"Error broadcasting to WebSocket: {e}")
                disconnected.append(connection)

        for dead_conn in disconnected:
            self.disconnect(dead_conn)

ws_manager = ConnectionManager()

def broadcast_sync(event_type: str, data: Dict[str, Any]):
    """
    Safely triggers broadcast without blocking synchronous threads.
    If no clients are connected or no event loop is running, returns immediately.
    """
    if not ws_manager.active_connections:
        return

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(ws_manager.broadcast(event_type, data))
    except RuntimeError:
        # No running event loop in this execution thread (e.g. direct sync unit test)
        pass
    except Exception as e:
        logger.debug(f"Broadcast sync skipped: {e}")
