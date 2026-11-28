"""Shared protocol bounds and strict data models."""
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict

MAX_PDF_BYTES = 50_000_000
# Per-notebook PDF budget: one notebook usually holds a whole semester.
MAX_NOTEBOOK_ASSETS = 128
MAX_NOTEBOOK_ASSET_BYTES = 500_000_000
# Images are downscaled by the desktop app; their budget is separate from PDFs.
MAX_IMAGE_BYTES = 10_000_000
MAX_IMAGE_SIDE = 4096
MAX_NOTEBOOK_IMAGES = 2000
MAX_NOTEBOOK_IMAGE_BYTES = 500_000_000
MAX_PAGE_IMAGES = 50
MAX_PAGE_TEXTS = 50
MAX_TEXT_LENGTH = 5000
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
