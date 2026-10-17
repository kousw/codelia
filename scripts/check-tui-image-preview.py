"""Production TUI PTY contract test; no real runtime, model, network, or clipboard.

Run: python3 scripts/check-tui-image-preview.py crates/tui/target/debug/codelia-tui
Native graphics emission is not proof of visual correctness in a real terminal.
"""
import errno
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import zlib


def runtime(control, received):
    """A protocol peer only: records every TUI request and relays test events."""
    pending = b""
    image_settings_responses = 0
    with open(control) as events, open(received, "a", buffering=1) as requests:
        while True:
            if select.select([0], [], [], 0.02)[0]:
                chunk = os.read(0, 65536)
                if not chunk:
                    return
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    message = json.loads(line)
                    requests.write(json.dumps(message) + "\n")
                    if "method" in message:
                        result = {"protocol_version": "0", "server_capabilities": {"supports_image_generation": True}}
                        if message["method"] == "model.list":
                            result = {"models": []}
                        elif message["method"] in ("image.model.get", "image.model.configure"):
                            image_settings_responses += 1
                            result = {"requested_mode": "off", "state": "disabled", "message": f"IMAGE_SETTINGS_RESPONSE_{image_settings_responses}"}
                        elif message["method"] == "image.artifact.get":
                            image = Path(control).parent / "local image.png"
                            result = {"metadata": {"artifact_id": message["params"]["artifact_id"]},
                                      "data_url": "data:image/png;base64," + base64.b64encode(image.read_bytes()).decode()}
                        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
                        if message["method"] == "initialize":
                            print(json.dumps(text_event("SMOKE_READY")), flush=True)
            for line in events:
                print(line.rstrip(), flush=True)


def text_event(content):
    return {"jsonrpc": "2.0", "method": "agent.event", "params": {"event": {"type": "text", "content": content}}}


KEEPER = """
import subprocess, sys, termios
before = termios.tcgetattr(0)
result = subprocess.run(sys.argv[1:])
restored = termios.tcgetattr(0) == before
print('\\nCODELIA_PTY_RESTORED=' + str(int(restored)), flush=True)
sys.exit(result.returncode if restored else 97)
"""


def cursor_queries(tail, data):
    """PTY reads can split a DSR query or contain several; answer each once."""
    combined = tail + data
    return combined.count(b"\x1b[6n"), combined[-3:]


class Session:
    def __init__(self, binary, mode, protocol, directory, tmux=False):
        self.control = directory / "events.jsonl"
        self.received = directory / "requests.jsonl"
        self.control.write_text("")
        self.received.write_text("")
        self.master, self.slave = pty.openpty()
        self.output = bytearray()
        self.query_tail = b""
        self.resize(100, 30)
        env = dict(os.environ)
        for key in list(env):
            if key.startswith("CODELIA_") or key in ("TMUX", "KITTY_WINDOW_ID", "ITERM_SESSION_ID"):
                env.pop(key)
        env.update(TERM="xterm-256color", TERM_PROGRAM="", CODELIA_RUNTIME_CMD=sys.executable,
                   CODELIA_RUNTIME_ARGS=shlex.join([str(Path(__file__).resolve()), "--runtime", str(self.control), str(self.received)]),
                   CODELIA_TUI_IMAGE_PROTOCOL=protocol)
        if tmux:
            env["TMUX"] = "codelia-test-no-server"

        def setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        try:
            self.process = subprocess.Popen([sys.executable, "-c", KEEPER, str(binary), "--tui-mode", mode],
                                            stdin=self.slave, stdout=self.slave, stderr=self.slave,
                                            env=env, preexec_fn=setup)
        except BaseException:
            os.close(self.master)
            os.close(self.slave)
            raise

    def resize(self, cols, rows):
        # OS cell metrics, not emulated terminal capability responses.
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * 8, rows * 16))

    def pump(self, timeout=0.05):
        if select.select([self.master], [], [], timeout)[0]:
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return False
                raise
            if not data:
                return False
            self.output.extend(data)
            assert len(self.output) < 32 * 1024 * 1024, "Unbounded terminal output"
            # Inline Ratatui startup asks for cursor position; image capability
            # queries are intentionally neither answered nor needed.
            queries, self.query_tail = cursor_queries(self.query_tail, data)
            for _ in range(queries):
                os.write(self.master, b"\x1b[1;1R")
            return True
        return False

    def until(self, marker, start=0, timeout=6):
        deadline = time.monotonic() + timeout
        while marker not in self.output[start:]:
            self.pump()
            if time.monotonic() > deadline or self.process.poll() is not None:
                raise AssertionError(f"Missing {marker!r}; tail={bytes(self.output[-1600:])!r}")

    def send(self, data, marker=None):
        start = len(self.output)
        os.write(self.master, data)
        if marker:
            self.until(marker, start)
        return start

    def command(self, text, marker):
        return self.send(b"\x1b[200~" + text.encode() + b"\x1b[201~\r", marker)

    def inject(self, event):
        with self.control.open("a") as stream:
            stream.write(json.dumps(event) + "\n")

    def finish(self):
        self.until(b"CODELIA_PTY_RESTORED=1")
        deadline = time.monotonic() + 5
        while self.process.poll() is None and time.monotonic() < deadline:
            self.pump()
        assert self.process.wait(timeout=1) == 0
        methods = [json.loads(line).get("method") for line in self.received.read_text().splitlines()]
        assert "run.start" not in methods, "Preview or swallowed input was sent to the model"
        assert "tool.call" not in methods and "run.cancel" not in methods
        assert b"\x1b[5n" not in self.output, "Image detection queried stdin"

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=2)
        os.close(self.master)
        os.close(self.slave)


def write_png(path):
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
    width, height = 640, 480
    rows = b"".join(b"\x00" + bytes((230, y % 256, 50)) * width for y in range(height))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def exercise(binary, mode, protocol, tmux=False):
    with tempfile.TemporaryDirectory(prefix="codelia-preview-") as name:
        directory = Path(name)
        image = directory / "local image.png"
        write_png(image)
        before = image.read_bytes()
        corrupt = directory / "corrupt.png"
        corrupt.write_text("not an image")
        session = Session(binary, mode, protocol, directory, tmux)
        native = protocol == "kitty" and mode == "alternate" and not tmux
        try:
            session.until(b"SMOKE_READY")
            # Match the fixture's RGB pixels, not halfblocks in the welcome logo.
            marker = b"a=T,U=1,f=32" if native else b"\x1b[38;2;230;"
            session.command("/image-model status", b"IMAGE_SETTINGS_RESPONSE_1")
            session.command("/image-model off", b"IMAGE_SETTINGS_RESPONSE_2")
            session.command("/image-model", b"IMAGE_SETTINGS_RESPONSE_3")
            artifact_id = "codelia-image-00000000-0000-4000-8000-000000000000"
            artifact_start = session.command(f"/image-artifact {artifact_id}", b"Previewing image artifact")
            session.until(marker, artifact_start)
            session.send(b"q")
            for _ in range(5):
                session.pump()
            requests = [json.loads(line) for line in session.received.read_text().splitlines()]
            assert any(r.get("method") == "image.model.get" for r in requests)
            assert any(r.get("method") == "image.model.configure" and r.get("params") == {"mode": "off"} for r in requests)
            assert any(r.get("method") == "image.model.configure" and not r.get("params") for r in requests)
            assert any(r.get("method") == "image.artifact.get" and r.get("params") == {"artifact_id": artifact_id} for r in requests)
            session.command(f"/image {shlex.quote(str(image))}", marker)
            session.send(b"\x1b[200~DO_NOT_SUBMIT\x1b[201~")
            session.send(b"\r", b"Modal")
            session.send(b"\x1b", b"Small")
            start = len(session.output)
            session.resize(80, 24)
            session.until(b"Image preview", start)
            session.inject(text_event("RUNTIME_WHILE_PREVIEW"))
            session.until(b"RUNTIME_WHILE_PREVIEW", start)
            session.inject({"jsonrpc": "2.0", "id": "preview-confirm", "method": "ui.confirm.request",
                            "params": {"title": "PREVIEW_PERMISSION", "message": "Preview must yield to this dialog"}})
            session.until(b"PREVIEW_PERMISSION", start)
            # A title can arrive in an early stdout chunk. Wait for the draw's
            # cursor restoration before sending the dialog response.
            title_end = session.output.index(b"PREVIEW_PERMISSION", start) + len(b"PREVIEW_PERMISSION")
            session.until(b"\x1b[?25h", title_end)
            session.send(b"\x1b")
            deadline = time.monotonic() + 5
            while '"preview-confirm"' not in session.received.read_text():
                session.pump()
                assert time.monotonic() < deadline and session.process.poll() is None, f"Permission dialog was blocked by preview; requests={session.received.read_text()}; tail={bytes(session.output[-1600:])!r}"
            session.command("/image", b"Image preview")
            session.send(b"q")
            # Wait for close before entering a command, then exercise a recoverable error.
            for _ in range(5):
                session.pump()
            session.command(f"/image {shlex.quote(str(corrupt))}", b"Cannot preview")
            session.send(b"\x1b")
            for _ in range(5):
                session.pump()
            session.command(f"/image {shlex.quote(str(image))}", marker)
            session.send(b"\x03")  # close only; must not cancel runtime or exit
            for _ in range(5):
                session.pump()
            assert session.process.poll() is None
            session.send(b"\x03")  # normal TUI exit
            session.finish()
            assert (b"\x1b[?1049h" in session.output) == (mode == "alternate"), "Wrong startup screen mode"
            assert (b"\x1b[?1049l" in session.output) == (mode == "alternate"), "Wrong restored screen mode"
            assert image.read_bytes() == before, "Original file was modified"
            if native:
                ids = re.findall(rb"i=(\d+),a=T,U=1", session.output)
                assert ids and len(set(ids)) == 1, "Kitty cache identity grew across resize/reopen"
                assert b"a=d,d=I,i=" + ids[0] + b",q=2" in session.output, "Owned Kitty image was not deleted on exit"
            else:
                assert b"\x1b_G" not in session.output, "Unsafe native graphics in fallback mode"
            print(f"PASS: production {mode}/{protocol}/tmux={tmux}: image-model RPC, artifact transfer, file, graphics/cell emission, modal, resize, IPC preemption, error recovery, no model calls, restoration")
        finally:
            session.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--runtime":
        runtime(sys.argv[2], sys.argv[3])
    else:
        for split in range(1, 4):
            query = b"\x1b[6n"
            count, tail = cursor_queries(b"", query[:split])
            rest, _ = cursor_queries(tail, query[split:])
            assert count + rest == 1
        assert cursor_queries(b"", b"\x1b[6n\x1b[6n")[0] == 2
        binary = Path(sys.argv[1]).resolve()
        for mode, protocol, tmux in [("inline", "halfblocks", False), ("alternate", "halfblocks", False),
                                     ("alternate", "kitty", False), ("inline", "kitty", False),
                                     ("alternate", "kitty", True)]:
            exercise(binary, mode, protocol, tmux)
