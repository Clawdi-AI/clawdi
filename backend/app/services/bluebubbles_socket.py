from __future__ import annotations

import json
import secrets
from collections import defaultdict
from typing import Any
from uuid import UUID

from fastapi import WebSocket


class BlueBubblesSocketManager:
    def __init__(self) -> None:
        self._by_account: dict[UUID, set[WebSocket]] = defaultdict(set)
        self._account_by_socket: dict[WebSocket, UUID] = {}

    async def connect(self, websocket: WebSocket, account_id: UUID) -> None:
        self._by_account[account_id].add(websocket)
        self._account_by_socket[websocket] = account_id
        await websocket.send_text(f"40{json.dumps({'sid': secrets.token_urlsafe(12)})}")
        await websocket.send_text('42["auth-ok"]')

    def disconnect(self, websocket: WebSocket) -> None:
        account_id = self._account_by_socket.pop(websocket, None)
        if account_id is None:
            return
        sockets = self._by_account.get(account_id)
        if sockets is None:
            return
        sockets.discard(websocket)
        if not sockets:
            self._by_account.pop(account_id, None)

    async def emit(self, account_id: UUID, event_name: str, payload: Any) -> int:
        sockets = list(self._by_account.get(account_id, ()))
        packet = f"42{json.dumps([event_name, payload], default=str)}"
        sent = 0
        for websocket in sockets:
            try:
                await websocket.send_text(packet)
            except RuntimeError:
                self.disconnect(websocket)
                continue
            sent += 1
        return sent


bluebubbles_socket_manager = BlueBubblesSocketManager()
