"""Pinned native middleware/provider with fixture status and HTML handlers.

This does not load the full Hermes gateway or build its SPA.
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ["CLAWDI_TEST_HERMES_DASHBOARD_SOURCE"])

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from hermes_cli.dashboard_auth import list_session_providers, register_provider
from hermes_cli.dashboard_auth.middleware import gated_auth_middleware
from plugins.dashboard_auth.basic import BasicAuthProvider, hash_password

register_provider(
    BasicAuthProvider(
        username="fixture",
        password_hash=hash_password("fixture"),
        secret=b"isolated-native-auth-fixture-secret",
    )
)
app = FastAPI()
app.state.auth_required = True
app.middleware("http")(gated_auth_middleware)
state_path = Path(sys.argv[1])


@app.get("/api/status")
async def status():
    state = json.loads(state_path.read_text())
    return {
        "gateway_running": state["gateway"],
        "gateway_state": "running" if state["gateway"] else "stopped",
        "auth_required": app.state.auth_required,
        "auth_providers": [provider.name for provider in list_session_providers()],
    }


@app.get("/login")
@app.get("/")
async def page():
    return HTMLResponse("<!doctype html><html>Fixture login page</html>")


uvicorn.run(app, host="127.0.0.1", port=9119, log_level="error")
