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
    algorithm: str = Field(default="path_loss")
    path_loss_ref: float = Field(default=-40.0)
    path_loss_exp: float = Field(default=2.7)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class Reading(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    node_id: str = Field(foreign_key="node.id", index=True)
    gateway_id: str = Field(foreign_key="gateway.id", index=True)
    rssi: float
    snr: Optional[float] = None
    predicted_distance: Optional[float] = None  # metres, computed from RSSI
    battery_level: Optional[float] = None       # % — reserved for future ADC read
    timestamp: datetime = Field(default_factory=datetime.utcnow, index=True)
