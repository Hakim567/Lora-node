from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import create_db_and_tables
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


@app.get("/")
def root():
    return {"status": "ok", "service": "LoRa Geo API"}
