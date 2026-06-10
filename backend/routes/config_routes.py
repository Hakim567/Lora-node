from fastapi import APIRouter
from pydantic import BaseModel
import range_model

router = APIRouter()


import os

@router.get("/config/algorithms")
def get_algorithms():
    algorithms = ["path_loss"]
    if os.path.exists(range_model.MODELS_DIR):
        for f in os.listdir(range_model.MODELS_DIR):
            if f.endswith(".joblib") and f != "feature_scaler.joblib":
                algorithms.append(f)
    return {"algorithms": algorithms}

@router.get("/config/preview")
def get_model_preview(algorithm: str, path_loss_ref: float = -40.0, path_loss_exp: float = 2.7):
    test_cases = [
        {"rssi": -60, "snr": 8.0},
        {"rssi": -75, "snr": 5.0},
        {"rssi": -90, "snr": 0.0},
        {"rssi": -105, "snr": -10.0}
    ]
    preview = []
    for tc in test_cases:
        dist = range_model.predict_range(
            algorithm=algorithm, 
            rssi=float(tc["rssi"]), 
            snr=float(tc["snr"]), 
            path_loss_ref=path_loss_ref, 
            path_loss_exp=path_loss_exp
        )
        preview.append({"rssi": tc["rssi"], "snr": tc["snr"], "distance": dist})
    return {"preview": preview}
