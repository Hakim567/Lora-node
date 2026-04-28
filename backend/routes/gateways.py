from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from typing import Optional
from pydantic import BaseModel

from database import get_session
from models import Gateway

router = APIRouter()


class GatewayCreate(BaseModel):
    id: str
    name: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class GatewayUpdate(BaseModel):
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None


@router.get("/gateways")
def list_gateways(session: Session = Depends(get_session)):
    return session.exec(select(Gateway)).all()


@router.post("/gateways", status_code=201)
def create_gateway(data: GatewayCreate, session: Session = Depends(get_session)):
    if session.get(Gateway, data.id):
        raise HTTPException(status_code=409, detail="Gateway already exists")
    gw = Gateway(**data.dict())
    session.add(gw)
    session.commit()
    session.refresh(gw)
    return gw


@router.put("/gateways/{gateway_id}")
def update_gateway(
    gateway_id: str, data: GatewayUpdate, session: Session = Depends(get_session)
):
    gw = session.get(Gateway, gateway_id)
    if not gw:
        raise HTTPException(status_code=404, detail="Gateway not found")
    for key, val in data.dict(exclude_none=True).items():
        setattr(gw, key, val)
    session.add(gw)
    session.commit()
    session.refresh(gw)
    return gw


@router.delete("/gateways/{gateway_id}")
def delete_gateway(gateway_id: str, session: Session = Depends(get_session)):
    gw = session.get(Gateway, gateway_id)
    if not gw:
        raise HTTPException(status_code=404, detail="Gateway not found")
    session.delete(gw)
    session.commit()
    return {"status": "deleted"}
