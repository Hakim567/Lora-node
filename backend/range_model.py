"""
RSSI → predicted distance model.

Currently uses the log-distance path loss formula or a loaded ML model.
"""
import os
import joblib

# Cache for loaded ML models
_model_cache = {}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "ml_models")


def predict_range(algorithm: str, rssi: float, snr: float = 0.0, path_loss_ref: float = -40.0, path_loss_exp: float = 2.7) -> float:
    if algorithm == "path_loss":
        return _predict_path_loss(rssi, path_loss_ref, path_loss_exp)
    
    # Try to load and use ML model
    model_path = os.path.join(MODELS_DIR, algorithm)
    if not os.path.exists(model_path):
        # Fallback to path loss if model file is missing
        return _predict_path_loss(rssi, path_loss_ref, path_loss_exp)
        
    try:
        if algorithm not in _model_cache:
            _model_cache[algorithm] = joblib.load(model_path)
        
        model = _model_cache[algorithm]
        features = [[rssi, snr]]
        
        # Check and apply scaler if present
        scaler_path = os.path.join(MODELS_DIR, "feature_scaler.joblib")
        if os.path.exists(scaler_path):
            if "feature_scaler" not in _model_cache:
                _model_cache["feature_scaler"] = joblib.load(scaler_path)
            scaler = _model_cache["feature_scaler"]
            features = scaler.transform(features)
        
        # Predict using [RSSI, SNR]
        prediction = model.predict(features)
        return round(float(prediction[0]), 2)
    except Exception as e:
        print(f"Error predicting with model {algorithm}: {e}")
        return _predict_path_loss(rssi, path_loss_ref, path_loss_exp)


def _predict_path_loss(rssi: float, rssi_ref: float, path_loss_exp: float) -> float:
    """Log-distance path loss: d = 10 ^ ((RSSI_ref - RSSI) / (10 * n))"""
    if path_loss_exp == 0:
        return 0.0
    exponent = (rssi_ref - rssi) / (10.0 * path_loss_exp)
    distance = 10.0 ** exponent
    return round(distance, 2)
