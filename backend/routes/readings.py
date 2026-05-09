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
        WITH RankedReadings AS (
            SELECT
                r.id,
                r.node_id,
                r.gateway_id,
                r.rssi,
                r.snr,
                r.predicted_distance,
                r.battery_level,
                r.timestamp,
                ROW_NUMBER() OVER (
                    PARTITION BY r.node_id, r.gateway_id 
                    ORDER BY r.timestamp DESC
                ) as rn
            FROM reading r
        )
        SELECT
            rr.id,
            rr.node_id,
            rr.gateway_id,
            rr.rssi,
            rr.snr,
            rr.predicted_distance,
            rr.battery_level,
            rr.timestamp,
            n.name AS node_name,
            g.name AS gateway_name,
            g.latitude,
            g.longitude
        FROM RankedReadings rr
        JOIN node n ON n.id = rr.node_id
        JOIN gateway g ON g.id = rr.gateway_id
        WHERE rr.rn = 1
        ORDER BY rr.timestamp DESC
    """)
    rows = session.execute(query).all()
    return [dict(row._mapping) for row in rows]
