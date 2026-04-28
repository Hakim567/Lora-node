from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from database import get_session
from models import Node

router = APIRouter()


@router.get("/nodes")
def list_nodes(session: Session = Depends(get_session)):
    return session.exec(select(Node)).all()
