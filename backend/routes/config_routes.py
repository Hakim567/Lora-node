from fastapi import APIRouter
from pydantic import BaseModel
import range_model

router = APIRouter()


class RangeModelParams(BaseModel):
    rssi_ref: float
    path_loss_exp: float


@router.get("/config/range-model")
def get_range_model():
    return range_model.get_params()


@router.put("/config/range-model")
def update_range_model(params: RangeModelParams):
    range_model.set_params(params.rssi_ref, params.path_loss_exp)
    return range_model.get_params()
