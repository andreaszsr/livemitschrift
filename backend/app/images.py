"""Header checks for uploaded page images (PNG/JPEG), without decoding them."""
from .protocol import MAX_IMAGE_SIDE


def image_info(data: bytes) -> tuple[str, int, int] | None:
    """Return (media type, width, height) from the file header, or None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        # The first chunk must be IHDR: big-endian width and height follow its type.
        if data[12:16] != b"IHDR" or len(data) < 24:
            return None
        return "image/png", int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if data.startswith(b"\xff\xd8"):
        # Walk marker segments up to the first start-of-frame marker (C0..CF
        # except DHT C4, JPG C8 and DAC CC), which stores height then width.
        at = 2
        while at + 4 <= len(data):
            if data[at] != 0xFF:
                return None
            marker = data[at + 1]
            if marker == 0xFF:
                at += 1
                continue
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                at += 2
                continue
            if marker in (0xD9, 0xDA):
                return None
            length = int.from_bytes(data[at + 2:at + 4], "big")
            if length < 2:
                return None
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                if at + 9 > len(data):
                    return None
                return "image/jpeg", int.from_bytes(data[at + 7:at + 9], "big"), int.from_bytes(data[at + 5:at + 7], "big")
            at += 2 + length
    return None


def valid_image(data: bytes) -> str | None:
    """Media type of an acceptable image, else None."""
    info = image_info(data)
    if not info:
        return None
    media_type, width, height = info
    return media_type if 0 < width <= MAX_IMAGE_SIDE and 0 < height <= MAX_IMAGE_SIDE else None
