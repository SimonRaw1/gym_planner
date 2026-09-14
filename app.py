"""gym_planner - a phone-sized web app for planning and logging workouts.

Run it on the desktop, open it on the phone over the LAN, and add it to the home
screen. Everything is stored locally in data/gym.db.

    python app.py
"""

import socket
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from lib.api import router as api_router
from lib.db import DB_PATH, init_db

ROOT = Path(__file__).resolve().parent
HOST = "0.0.0.0"
PORT = 8000


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    print(f"gym_planner  db: {DB_PATH}")
    print(f"  on this machine : http://localhost:{PORT}")
    print(f"  on your phone   : http://{local_ip()}:{PORT}")
    yield


def local_ip() -> str:
    """Best guess at the LAN address the phone should point at."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no traffic is sent; just picks the route
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


app = FastAPI(title="gym_planner", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.include_router(api_router)

templates = Jinja2Templates(directory=ROOT / "templates")


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    """Served from the root so the worker's scope covers the whole app."""
    return FileResponse(
        ROOT / "static" / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(
        ROOT / "static" / "manifest.webmanifest",
        media_type="application/manifest+json",
    )


if __name__ == "__main__":
    uvicorn.run("app:app", host=HOST, port=PORT, reload=True)
