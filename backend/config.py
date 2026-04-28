import os

# Database
DB_PATH = os.getenv("DB_PATH", "lora_geo.db")

# Server
API_HOST = os.getenv("API_HOST", "0.0.0.0")
API_PORT = int(os.getenv("API_PORT", "8000"))

# Log-distance path loss model defaults
RSSI_REF = float(os.getenv("RSSI_REF", "-40"))      # dBm at 1 m reference distance
PATH_LOSS_EXP = float(os.getenv("PATH_LOSS_EXP", "2.7"))  # path loss exponent
