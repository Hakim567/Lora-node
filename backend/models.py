from typing import Optional
from datetime import datetime
from sqlmodel import Field, SQLModel


class Gateway(SQLModel, table=True):
    id: str = Field(primary_key=True)          # ChirpStack gateway EUI
    name: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Node(SQLModel, table=True):
    id: str = Field(primary_key=True)          # devEUI
    name: str
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Reading(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    node_id: str = Field(foreign_key="node.id")
    gateway_id: str = Field(foreign_key="gateway.id")
    rssi: float
    snr: Optional[float] = None
    predicted_distance: Optional[float] = None  # metres, computed from RSSI
    battery_level: Optional[float] = None       # % — reserved for future ADC read
    timestamp: datetime = Field(default_factory=datetime.utcnow)
