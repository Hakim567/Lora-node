from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import create_db_and_tables
import os
from fastapi.staticfiles import StaticFiles
from routes import chirpstack, gateways, nodes, readings, config_routes

app = FastAPI(title="LoRa Geo API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_db_and_tables()


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
