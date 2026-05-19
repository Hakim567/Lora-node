from fastapi import APIRouter, Depends, Query, Request
from sqlmodel import Session
from datetime import datetime
import base64
import collections
import time

from database import get_session
from models import Gateway, Node, Reading
from range_model import predict_range

router = APIRouter()

# Store recent incoming POST events
recent_events = collections.deque(maxlen=100)

@router.get("/chirpstack/events")
def get_recent_events():
    return list(recent_events)

@router.post("/chirpstack/uplink")
async def chirpstack_uplink(
    request: Request,
    event: str = Query(default="up"),
    session: Session = Depends(get_session),
):
    """ChirpStack HTTP Integration webhook target."""
    if event != "up":
        return {"status": "ignored", "event": event}

    body = await request.json()

    device_info = body.get("deviceInfo", {})
    node_id = device_info.get("devEui", "")
    node_name = device_info.get("deviceName", node_id)

    recent_events.append({
        "id": int(time.time() * 1000),
        "method": "POST",
        "path": f"[ChirpStack] /uplink?event=up (Node: {node_id or 'unknown'})",
        "status": 200,
        "duration": 0
    })

    rx_info_list = body.get("rxInfo", [])
    if not rx_info_list or not node_id:
        return {"status": "skipped", "reason": "missing devEui or rxInfo"}

    # ── Parse battery level from uplink payload ────────────────────
    # Heltec payload layout: [tempH][tempL][humH][humL][battery%]
    # Byte index 4 carries battery % (0–100). Not present on Xiao uplinks,
    # so battery_level stays None and is stored as NULL — harmless.
    battery_level = None

    # Option 1: ChirpStack codec may already decode a "battery" field
    object_data = body.get("object", {})
    if isinstance(object_data, dict) and "battery" in object_data:
        try:
            battery_level = float(object_data["battery"])
        except (TypeError, ValueError):
            pass

    # Option 2: parse raw bytes from the base64-encoded "data" field
    if battery_level is None:
        raw_b64 = body.get("data", "")
        if raw_b64:
            try:
                raw_bytes = base64.b64decode(raw_b64)
                if len(raw_bytes) >= 5:
                    val = raw_bytes[4]
                    if 0 <= val <= 100:
                        battery_level = float(val)
            except Exception:
                pass

    # Auto-register / update node
    node = session.get(Node, node_id)
    if not node:
        node = Node(id=node_id, name=node_name)
        session.add(node)
    else:
        node.name = node_name

    # One reading per gateway that heard this packet
    for rx in rx_info_list:
        gateway_id = rx.get("gatewayId", "")
        rssi = rx.get("rssi", -100)
        snr = rx.get("snr", None)

        if not gateway_id:
            continue

        # Auto-register gateway (no coordinates yet — user sets via UI)
        gw = session.get(Gateway, gateway_id)
        if not gw:
            gw = Gateway(id=gateway_id, name=gateway_id)
            session.add(gw)

        distance = predict_range(rssi)

        reading = Reading(
            node_id=node_id,
            gateway_id=gateway_id,
            rssi=rssi,
            snr=snr,
            predicted_distance=distance,
            battery_level=battery_level,
            timestamp=datetime.utcnow(),
        )
        session.add(reading)

    session.commit()
    return {"status": "ok", "node_id": node_id, "gateways_heard": len(rx_info_list)}
