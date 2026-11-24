"""Shared protocol bounds and strict data models."""
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict

MAX_PDF_BYTES = 50_000_000
# Per-notebook PDF budget: one notebook usually holds a whole semester.
MAX_NOTEBOOK_ASSETS = 128
MAX_NOTEBOOK_ASSET_BYTES = 500_000_000
SESSION_PATTERN = r"[a-f0-9]{64}"

class MessageModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, populate_by_name=True)

async def text_message(websocket: WebSocket, limit: int) -> str:
    frame = await websocket.receive()
    if frame["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(frame.get("code", 1000))
    text = frame.get("text")
    if not isinstance(text, str) or len(text.encode("utf-8")) > limit:
        raise ValueError("Invalid message type or size.")
    return text
