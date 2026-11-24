import logging
import sys

from app.logging import RedactingFormatter


def test_websocket_capabilities_and_keys_are_redacted():
    formatter = RedactingFormatter('%(levelname)s: %(message)s', use_colors=False)
    identity, key = 'a' * 64, 'B' * 64
    record = logging.LogRecord('uvicorn.error', logging.INFO, '', 0,
                               'WebSocket /ws/notebook/v2/view/%s key=%s', (identity, key), None)
    result = formatter.format(record)
    assert identity not in result and key not in result
    assert '/ws/notebook/v2/view/[redacted] key=[redacted]' in result


def test_exception_diagnostics_are_preserved_without_capabilities():
    identity = '1' * 64
    try:
        raise RuntimeError(f'Failed notebook {identity}')
    except RuntimeError:
        record = logging.LogRecord('uvicorn.error', logging.ERROR, '', 0, 'Request failed', (), sys.exc_info())
    result = RedactingFormatter('%(message)s', use_colors=False).format(record)
    assert identity not in result
    assert 'RuntimeError: Failed notebook [redacted]' in result
    assert 'Request failed' in result


def test_client_addresses_are_truncated_but_times_and_versions_stay():
    from app.logging import anonymize
    line = '12:34:56 92.211.2.82:51234 - "WebSocket /ws" 403 from [2a01:4f8:c17:1234::1]:443 version 1.2.3.4.5'
    result = anonymize(line)
    assert '92.211.2.82' not in result and '92.211.2.0:51234' in result
    assert '2a01:4f8:c17::/48' in result and '1234::1' not in result
    assert result.startswith('12:34:56 ') and '1.2.3.4.5' in result
    assert anonymize('999.1.1.1') == '999.1.1.1'


def test_formatter_masks_addresses_in_messages():
    record = logging.LogRecord('uvicorn.error', logging.INFO, '', 0, '%s - "WebSocket /ws/sync/v2/publish" 403', ('10.20.30.40:0',), None)
    assert '10.20.30.0:0' in RedactingFormatter('%(message)s', use_colors=False).format(record)
