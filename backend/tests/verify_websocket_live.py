import sys
import os
sys.path.insert(0, os.path.abspath("."))

import asyncio
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.core.ws import ws_manager
from backend.app.core.security import create_access_token

def test_websocket_functionality():
    print("=== REAL-TIME WEBSOCKET VERIFICATION ===")

    client = TestClient(app)
    token = create_access_token({"sub": "1", "email": "dispatcher@lifelink.demo", "role": "DISPATCHER"})

    # 1. Test Connection & Initial Handshake
    print("Connecting to /ws/live...")
    with client.websocket_connect(f"/ws/live?token={token}") as websocket:
        initial_msg = websocket.receive_json()
        print(f"Received from WebSocket: {initial_msg}")
        assert initial_msg["event"] == "HANDSHAKE"
        assert initial_msg["status"] == "connected"
        assert "ResQFlow" in initial_msg["service"]
        print("✓ WebSocket connection & handshake verified.")

        # 2. Test Ping / Pong Heartbeat
        websocket.send_text("ping")
        pong_msg = websocket.receive_json()
        assert pong_msg["event"] == "PONG"
        print("✓ Ping/Pong heartbeat verified.")

        # 3. Test Event Broadcasting to Connected Client
        test_payload = {"incident_id": 42, "status": "DISPATCHED", "ambulance": "KA-19-ALS-101"}
        asyncio.run(ws_manager.broadcast("DISPATCH_UPDATED", test_payload))

        broadcast_msg = websocket.receive_json()
        print(f"Received broadcast event: {broadcast_msg}")
        assert broadcast_msg["event"] == "DISPATCH_UPDATED"
        assert broadcast_msg["payload"]["incident_id"] == 42
        print("✓ Live event broadcast delivery verified.")

    # 4. Test Disconnection
    print("Client disconnected. Testing active connection tracking...")
    assert len(ws_manager.active_connections) == 0, f"Expected 0 active connections, got {len(ws_manager.active_connections)}"
    print("✓ Disconnection cleanup verified.")

    # 5. Test Reconnection
    print("Testing client reconnection...")
    with client.websocket_connect(f"/ws/live?token={token}") as websocket2:
        reconnect_msg = websocket2.receive_json()
        assert reconnect_msg["event"] == "HANDSHAKE"
        print("✓ Reconnection handshake verified.")

    print("ALL WEBSOCKET REAL-TIME SCENARIOS VERIFIED.")

if __name__ == "__main__":
    test_websocket_functionality()
