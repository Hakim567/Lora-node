from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from database import get_session
from models import Node

router = APIRouter()


@router.get("/nodes")
def list_nodes(session: Session = Depends(get_session)):
    return session.exec(select(Node)).all()


from pydantic import BaseModel
from fastapi import HTTPException
from typing import Optional

class NodeConfigUpdate(BaseModel):
    algorithm: Optional[str] = None
    path_loss_ref: Optional[float] = None
    path_loss_exp: Optional[float] = None

@router.put("/nodes/{node_id}/config")
def update_node_config(node_id: str, update: NodeConfigUpdate, session: Session = Depends(get_session)):
    node = session.get(Node, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    
    if update.algorithm is not None:
        node.algorithm = update.algorithm
    if update.path_loss_ref is not None:
        node.path_loss_ref = update.path_loss_ref
    if update.path_loss_exp is not None:
        node.path_loss_exp = update.path_loss_exp
        
    session.add(node)
    session.commit()
    session.refresh(node)
    return node
