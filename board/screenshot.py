#!/usr/bin/env python3
"""Headless-Chrome PNG screenshot via the DevTools protocol (stdlib only).

Usage: screenshot.py HTML_PATH OUT_PNG WIDTH HEIGHT [SCALE=2]

Chrome's `--screenshot` flag has hung without writing a file on the machine
this board was tuned on, so the page is captured over CDP instead.
CHROME_BIN overrides the binary (default: google-chrome-stable, then google-chrome).
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def chrome_bin() -> str:
    override = os.environ.get("CHROME_BIN")
    if override:
        return override
    for name in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    raise RuntimeError("no Chrome/Chromium binary found (set CHROME_BIN)")


class WS:
    def __init__(self, url: str):
        if not url.startswith("ws://"):
            raise RuntimeError(f"expected ws:// debugger url, got {url!r}")
        hostport, path = url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            (
                f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        if b" 101 " not in buf.split(b"\r\n")[0]:
            raise RuntimeError("websocket handshake failed: " + buf[:200].decode(errors="replace"))
        self.rest = buf.split(b"\r\n\r\n", 1)[1]
        self.n = 0

    def _read(self, n: int) -> bytes:
        while len(self.rest) < n:
            chunk = self.s.recv(1 << 20)
            if not chunk:
                raise RuntimeError("websocket closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, obj: dict) -> None:
        data = json.dumps(obj).encode()
        hdr = bytearray([0x81])
        length = len(data)
        if length < 126:
            hdr.append(0x80 | length)
        elif length < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", length)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", length)
        mask = os.urandom(4)
        self.s.sendall(bytes(hdr) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self) -> dict:
        msg = b""
        while True:
            b1, b2 = self._read(2)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(length)
            msg += payload
            if b1 & 0x80:
                op = b1 & 0x0F
                if op in (1, 2, 0):
                    return json.loads(msg.decode())
                msg = b""

    def call(self, method: str, **params):
        self.n += 1
        mid = self.n
        self.send({"id": mid, "method": method, "params": params})
        while True:
            message = self.recv()
            if message.get("id") == mid:
                if "error" in message:
                    raise RuntimeError(f"{method}: {message['error']}")
                return message.get("result", {})


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()[:24]
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"{path} is not a PNG")
    return struct.unpack(">II", data[16:24])


def main() -> None:
    html, out, width, height = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    scale = float(sys.argv[5]) if len(sys.argv) > 5 else 2.0
    profile = tempfile.mkdtemp(prefix="chrome-miss-shot-")
    proc = subprocess.Popen(
        [
            chrome_bin(),
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--hide-scrollbars",
            "--no-first-run",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-sync",
            "--remote-debugging-port=0",
            f"--user-data-dir={profile}",
            f"--window-size={width},{height}",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        port_file = Path(profile) / "DevToolsActivePort"
        for _ in range(150):
            if port_file.exists() and port_file.read_text().strip():
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("Chrome did not open a DevTools port")
        port = port_file.read_text().split()[0]
        targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10).read())
        page = next(target for target in targets if target.get("type") == "page")
        ws = WS(page["webSocketDebuggerUrl"].replace("localhost", "127.0.0.1"))
        ws.call("Page.enable")
        ws.call("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=scale, mobile=False)
        url = html if "://" in html else "file://" + str(Path(html).resolve())
        ws.call("Page.navigate", url=url)
        ready = (
            "document.readyState==='complete' && "
            "Array.from(document.images).every(i=>i.complete && i.naturalWidth>0) && "
            "document.fonts.status==='loaded'"
        )
        for _ in range(150):
            if ws.call("Runtime.evaluate", expression=ready, returnByValue=True).get("result", {}).get("value"):
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("page did not finish loading (a logo may be blank)")
        time.sleep(0.3)
        # deviceScaleFactor is the 2x. clip.scale stays 1; setting both to 2
        # yields a 4320-wide PNG on current Chrome. 1080×1960 CSS → 2160×3920.
        shot = ws.call(
            "Page.captureScreenshot",
            format="png",
            clip={"x": 0, "y": 0, "width": width, "height": height, "scale": 1},
            captureBeyondViewport=False,
        )
        tmp = out + ".tmp"
        Path(tmp).write_bytes(base64.b64decode(shot["data"]))
        os.replace(tmp, out)
        got = png_size(Path(out))
        print(f"screenshot.py: wrote {out} {got[0]}x{got[1]}")
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:  # noqa: BLE001
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
