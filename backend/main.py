from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from database import create_db_and_tables
import os
from fastapi.staticfiles import StaticFiles
from routes import chirpstack, gateways, nodes, readings, config_routes
from routes.auth import router as auth_router, verify_session

app = FastAPI(title="LoRa Geo API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# ── Auth guard middleware ─────────────────────────────────────────
# Paths that do NOT require a session:
#   /api/auth/*          — login / logout / me
#   /api/chirpstack/*    — ChirpStack webhook (machine-to-machine)
_PUBLIC_PREFIXES = (
    "/api/auth/",
    "/api/chirpstack/",
)

@app.middleware("http")
async def require_auth(request: Request, call_next):
    path = request.url.path
    # Let public paths and non-API paths through without checking session
    if not path.startswith("/api/") or any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return await call_next(request)
    try:
        verify_session(request)
    except Exception:
        return JSONResponse(status_code=401, content={"detail": "Not authenticated"})
    return await call_next(request)


from database import create_db_and_tables, get_session
from sqlalchemy import text

@app.on_event("startup")
def on_startup():
    create_db_and_tables()
    # Safe migration: add columns to Node if missing
    try:
        db = next(get_session())
        db.execute(text("ALTER TABLE node ADD COLUMN algorithm VARCHAR DEFAULT 'path_loss'"))
        db.commit()
    except Exception:
        pass
    try:
        db = next(get_session())
        db.execute(text("ALTER TABLE node ADD COLUMN path_loss_ref FLOAT DEFAULT -40.0"))
        db.commit()
    except Exception:
        pass
    try:
        db = next(get_session())
        db.execute(text("ALTER TABLE node ADD COLUMN path_loss_exp FLOAT DEFAULT 2.7"))
        db.commit()
    except Exception:
        pass


app.include_router(auth_router, prefix="/api")
app.include_router(chirpstack.router, prefix="/api")
app.include_router(gateways.router, prefix="/api")
app.include_router(nodes.router, prefix="/api")
app.include_router(readings.router, prefix="/api")
app.include_router(config_routes.router, prefix="/api")


@app.get("/api")
def root():
    return {"status": "ok", "service": "LoRa Geo API"}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "..", "frontend")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
