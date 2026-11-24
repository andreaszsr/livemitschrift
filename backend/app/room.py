"""Bounded per-connection queues and a single publishing lease."""
import asyncio
from dataclasses import dataclass, field
from typing import Any, Literal

class ProtocolError(ValueError):
    pass

@dataclass(eq=False)
class Client:
    role: Literal["instructor", "student"]
    outgoing: asyncio.Queue[dict[str, Any] | tuple[str, ...]] = field(default_factory=lambda: asyncio.Queue(maxsize=256))
    overflow: asyncio.Event = field(default_factory=asyncio.Event)

class Room:
    def __init__(self) -> None:
        self.clients: set[Client] = set()
        self.instructor: Client | None = None

    @staticmethod
    def enqueue(client: Client, message: dict[str, Any] | tuple[str, ...]) -> None:
        try:
            client.outgoing.put_nowait(message)
        except asyncio.QueueFull:
            client.overflow.set()

    def broadcast(self, message: dict[str, Any], source: Client | None = None) -> None:
        for client in self.clients:
            if client is not source:
                self.enqueue(client, message)
