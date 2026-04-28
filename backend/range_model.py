"""
RSSI → predicted distance model.

Currently uses the log-distance path loss formula.
To swap in an ML model, replace the body of predict_range() only —
nothing else in the codebase needs to change.
"""
from config import RSSI_REF, PATH_LOSS_EXP

_rssi_ref: float = RSSI_REF
_path_loss_exp: float = PATH_LOSS_EXP


def get_params() -> dict:
    return {"rssi_ref": _rssi_ref, "path_loss_exp": _path_loss_exp}


def set_params(rssi_ref: float, path_loss_exp: float) -> None:
    global _rssi_ref, _path_loss_exp
    _rssi_ref = rssi_ref
    _path_loss_exp = path_loss_exp


def predict_range(rssi: float) -> float:
    """Log-distance path loss: d = 10 ^ ((RSSI_ref - RSSI) / (10 * n))"""
    if _path_loss_exp == 0:
        return 0.0
    exponent = (_rssi_ref - rssi) / (10.0 * _path_loss_exp)
    distance = 10.0 ** exponent
    return round(distance, 2)
