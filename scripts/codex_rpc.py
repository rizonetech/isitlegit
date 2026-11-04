"""Bounded JSON RPC over the existing Codex Unix WebSocket; never starts a daemon."""
import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import time


class RpcError(RuntimeError):
    pass


class Client:
    def __init__(self, path=None, timeout=2):
        self.timeout = timeout
        self.deadline = time.monotonic() + timeout
        self.counter = 0
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(timeout)
        try:
            self.sock.connect(str(path or Path.home() / ".codex/app-server-control/app-server-control.sock"))
            key = base64.b64encode(os.urandom(16)).decode()
            self.sock.sendall(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                               "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                               f"Sec-WebSocket-Key: {key}\r\n\r\n").encode())
            header = b""
            while not header.endswith(b"\r\n\r\n"):
                header += self.read(1)
                if len(header) > 8192:
                    raise RpcError("oversized WebSocket handshake")
            lines = header.decode("ascii").split("\r\n")
            fields = dict(line.lower().split(":", 1) for line in lines[1:] if ":" in line)
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            # Field values are case sensitive; parse the accept separately.
            received = next((line.split(":", 1)[1].strip() for line in lines if line.lower().startswith("sec-websocket-accept:")), None)
            if " 101 " not in lines[0] or received != accept or fields.get("upgrade", "").strip() != "websocket":
                raise RpcError("invalid WebSocket handshake")
            self.call("initialize", {"clientInfo": {"name": "isitlegit-continuation", "version": "1"},
                                     "capabilities": {"experimentalApi": True}})
            self.send({"method": "initialized", "params": {}})
        except Exception:
            self.close()
            raise

    def close(self):
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def read(self, count):
        data = b""
        while len(data) < count:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise RpcError("Codex read timed out")
            self.sock.settimeout(remaining)
            part = self.sock.recv(count - len(data))
            if not part:
                raise RpcError("Codex connection closed")
            data += part
        return data

    def frame(self, data, opcode=1):
        mask = os.urandom(4)
        length = len(data)
        header = bytes([0x80 | opcode])
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += b"\xfe" + struct.pack("!H", length)
        else:
            header += b"\xff" + struct.pack("!Q", length)
        self.sock.sendall(header + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(data)))

    def send(self, value):
        self.frame(json.dumps(value).encode())

    def receive(self, deadline):
        data = b""
        started = False
        while time.monotonic() < deadline:
            self.sock.settimeout(max(0.001, deadline - time.monotonic()))
            first, second = self.read(2)
            opcode, final = first & 15, bool(first & 128)
            if first & 112 or second & 128:
                raise RpcError("invalid server frame flags")
            length = second & 127
            if length == 126:
                length = struct.unpack("!H", self.read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self.read(8))[0]
            if length + len(data) > 4 * 1024 * 1024:
                raise RpcError("oversized Codex response")
            part = self.read(length)
            if opcode in (8, 9, 10):
                if not final or length > 125:
                    raise RpcError("invalid control frame")
                if opcode == 8:
                    raise RpcError("Codex closed WebSocket")
                if opcode == 9:
                    self.frame(part, 10)
                continue
            if (not started and opcode != 1) or (started and opcode != 0):
                raise RpcError("invalid fragmented text response")
            started = True
            data += part
            if final:
                value = json.loads(data)
                if not isinstance(value, dict):
                    raise RpcError("invalid Codex RPC response")
                return value
        raise RpcError("Codex response timed out")

    def call(self, method, params):
        self.deadline = time.monotonic() + self.timeout
        self.counter += 1
        identity = self.counter
        self.send({"id": identity, "method": method, "params": params})
        deadline = self.deadline
        while time.monotonic() < deadline:
            reply = self.receive(deadline)
            if reply.get("id") != identity:
                continue
            if "error" in reply:
                # No provider error bodies or personal thread contents enter logs.
                raise RpcError(f"{method} refused (code {reply['error'].get('code')})")
            if "result" not in reply:
                raise RpcError("missing RPC result")
            return reply["result"]
        raise RpcError(f"{method} timed out")
