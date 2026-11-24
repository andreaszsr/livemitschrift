"""Supported single-process Uvicorn entry point with transport bounds."""
import os
from copy import deepcopy
import uvicorn
from uvicorn.config import LOGGING_CONFIG

from .logging import RedactingFormatter


def main() -> None:
    if os.environ.get('WEB_CONCURRENCY', '1') != '1':
        raise SystemExit('LiveMitschrift requires exactly one backend worker.')
    log_config = deepcopy(LOGGING_CONFIG)
    log_config['formatters']['default']['()'] = RedactingFormatter
    # Default "warning": per-connection messages (with client addresses) are not
    # written at all. Set LIVEMITSCHRIFT_LOG_LEVEL=info temporarily to diagnose.
    level = os.environ.get('LIVEMITSCHRIFT_LOG_LEVEL', 'warning').lower()
    if level not in ('debug', 'info', 'warning', 'error'):
        raise SystemExit('LIVEMITSCHRIFT_LOG_LEVEL must be debug, info, warning or error.')
    uvicorn.run('app.main:create_app', factory=True, host=os.environ.get('LIVEMITSCHRIFT_BIND', '127.0.0.1'),
                port=8000, workers=1, ws_max_size=256000, ws_max_queue=8,
                limit_concurrency=160, timeout_keep_alive=5, timeout_graceful_shutdown=15,
                proxy_headers=True, forwarded_allow_ips=os.environ.get('LIVEMITSCHRIFT_TRUSTED_PROXIES', '127.0.0.1,::1'),
                access_log=False, server_header=False, log_config=log_config, log_level=level)


if __name__ == '__main__':
    main()
