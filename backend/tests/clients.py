"""Explicit authenticated clients for the existing publication regressions."""
from contextlib import contextmanager

from fastapi.testclient import TestClient

TEST_KEY = "d" * 64
KEY_HEADERS = {"X-LiveMitschrift-Publisher-Key": TEST_KEY}


class AuthorizedClient(TestClient):
    def __init__(self, app, **kwargs):
        super().__init__(app, base_url="https://testserver", headers=KEY_HEADERS, **kwargs)


@contextmanager
def connect(client, path):
    writer = path.endswith("/publish")
    url = f"wss://testserver{path}" if path.startswith("/") else path
    with client.websocket_connect(url) as socket:
        if writer:
            socket.send_json({"type": "authenticate", "key": TEST_KEY})
            assert socket.receive_json() == {"type": "authenticated"}
        yield socket
