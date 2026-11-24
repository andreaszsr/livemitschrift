import pytest
from clients import TEST_KEY


@pytest.fixture(autouse=True)
def isolated_configuration(monkeypatch, tmp_path):
    # The application factory reads settings only when a test creates its app.
    monkeypatch.setenv("LIVEMITSCHRIFT_PUBLISHER_KEY", TEST_KEY)
    monkeypatch.setenv("LIVEMITSCHRIFT_PUBLISHER_KEY_FILE", "")
    monkeypatch.setenv("LIVEMITSCHRIFT_PUBLIC_URL", "https://testserver")
    monkeypatch.setenv("LIVEMITSCHRIFT_SERVER_DIR", str(tmp_path / "server"))
