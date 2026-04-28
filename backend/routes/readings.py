from fastapi import APIRouter, Depends
from sqlmodel import Session, text

from database import get_session

router = APIRouter()


@router.get("/readings/latest")
def latest_readings(session: Session = Depends(get_session)):
    """
    Returns the latest reading per (node_id, gateway_id) pair,
    joined with gateway coordinates and names for the map.
    """
    query = text("""
        SELECT
            r.id,
            r.node_id,
            r.gateway_id,
            r.rssi,
            r.snr,
            r.predicted_distance,
            r.battery_level,
            r.timestamp,
            n.name AS node_name,
            g.name AS gateway_name,
            g.latitude,
            g.longitude
        FROM reading r
        JOIN node n ON n.id = r.node_id
        JOIN gateway g ON g.id = r.gateway_id
        WHERE r.id = (
            SELECT id FROM reading r2
            WHERE r2.node_id = r.node_id AND r2.gateway_id = r.gateway_id
            ORDER BY timestamp DESC
            LIMIT 1
        )
        ORDER BY r.timestamp DESC
    """)
    rows = session.execute(query).all()
    return [dict(row._mapping) for row in rows]
