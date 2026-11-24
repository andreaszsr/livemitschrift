"""Keep notebook capabilities, publisher keys and full client IPs out of server diagnostics."""
import ipaddress
import logging
import re

from uvicorn.logging import DefaultFormatter

CAPABILITY = re.compile(r'(?i)(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])')
IPV4 = re.compile(r'(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])')
# Candidate IPv6 text (optionally bracketed); each match is validated before masking.
IPV6 = re.compile(r'(?i)(?<![0-9a-f:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![0-9a-f:])')


def mask_ipv4(match: re.Match[str]) -> str:
    if any(int(part) > 255 for part in match.groups()):
        return match.group(0)
    return f'{match.group(1)}.{match.group(2)}.{match.group(3)}.0'


def mask_ipv6(match: re.Match[str]) -> str:
    text = match.group(0)
    try:
        address = ipaddress.IPv6Address(text)
    except ValueError:
        return text  # e.g. a clock time such as 12:34:56
    return f'{ipaddress.IPv6Network((address, 48), strict=False).network_address}/48'


def anonymize(text: str) -> str:
    """Truncate client addresses (IPv4 /24, IPv6 /48); enough for diagnostics, not for identifying a device."""
    return IPV6.sub(mask_ipv6, IPV4.sub(mask_ipv4, text))


class RedactingFormatter(DefaultFormatter):
    def format(self, record: logging.LogRecord) -> str:
        # Format first so interpolated arguments and exception tracebacks are
        # protected too. Uvicorn logs WebSocket URLs even with access_log=False.
        return anonymize(CAPABILITY.sub('[redacted]', super().format(record)))
