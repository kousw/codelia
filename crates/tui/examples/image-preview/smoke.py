"""Bounded macOS/Linux PTY smoke; protocol emission is not a visual terminal test."""

import errno
import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


# Check restoration inside the controlling session before macOS invalidates the
# slave terminal on session-leader exit. The wrapper never reads terminal input.
KEEPER = """
import subprocess, sys, termios
before = termios.tcgetattr(0)
result = subprocess.run(sys.argv[1:])
restored = termios.tcgetattr(0) == before
print('\\nCODELIA_PTY_RESTORED=' + str(int(restored)), flush=True)
sys.exit(result.returncode if restored else 97)
"""


class Session:
    def __init__(self, binary, args):
        self.master, self.slave = pty.openpty()
        self.output = bytearray()
        self.resize(100, 30)
        env = dict(os.environ, TERM="xterm-256color", TERM_PROGRAM="")
        for key in ("TMUX", "KITTY_WINDOW_ID", "ITERM_SESSION_ID", "WEZTERM_EXECUTABLE"):
            env.pop(key, None)

        def setup():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        try:
            self.process = subprocess.Popen(
                [sys.executable, "-c", KEEPER, str(binary), *args], stdin=self.slave, stdout=self.slave,
                stderr=self.slave, env=env, preexec_fn=setup,
            )
        except BaseException:
            os.close(self.master)
            os.close(self.slave)
            raise

    def resize(self, width, height):
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ,
                    struct.pack("HHHH", height, width, width * 10, height * 20))
        if hasattr(self, "process"):
            os.killpg(self.process.pid, signal.SIGWINCH)

    def drain(self, wait=0.05):
        if select.select([self.master], [], [], wait)[0]:
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                return False
            self.output.extend(data)
            if len(self.output) > 16 * 1024 * 1024:
                raise AssertionError("Preview exceeded the smoke output budget")
            return True
        return False

    def until(self, token, start=0, timeout=6):
        deadline = time.monotonic() + timeout
        while token not in self.output[start:]:
            self.drain()
            if time.monotonic() > deadline:
                tail = bytes(self.output[-600:])
                raise AssertionError(f"Timed out waiting for {token!r}; tail={tail!r}")

    def key(self, value, expected):
        start = len(self.output)
        os.write(self.master, value)
        self.until(expected, start)

    def finish(self, expected_code=0):
        deadline = time.monotonic() + 6
        while self.process.poll() is None:
            self.drain()
            if time.monotonic() > deadline:
                raise AssertionError("Preview did not exit")
        while self.drain():
            if time.monotonic() > deadline:
                raise AssertionError("PTY output did not settle after process exit")
        assert self.process.returncode == expected_code, bytes(self.output[-700:])
        assert b"\x1b[?1049h" in self.output, "Did not enter alternate screen"
        assert b"\x1b[?1049l" in self.output, "Did not leave alternate screen"
        assert b"CODELIA_PTY_RESTORED=1" in self.output, "Terminal mode not restored"

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=3)
        os.close(self.master)
        os.close(self.slave)


def exercise(binary, protocol):
    session = Session(binary, ["--halfblocks"] if protocol == "Halfblocks" else [])
    try:
        if protocol == "Kitty":
            session.until(b"\x1b[5n")
            # Emulate capability replies, not terminal rendering or account behavior.
            os.write(session.master, b"\x1b_Gi=31;OK\x1b\\\x1b[?1;2c\x1b[6;20;10t\x1b[0n")
        session.until(f"Protocol: {protocol}".encode())
        marker = b"a=T,U=1,f=32" if protocol == "Kitty" else "\u2580".encode()
        session.until(marker)
        session.key(b"\r", b"Modal")
        session.key(b"\x1b", b"Small")
        session.key(b"v", b"Hidden")
        session.key(b"v", b"Small")
        start = len(session.output)
        session.resize(80, 22)
        session.until(b"Codelia image preview lab", start)
        os.write(session.master, b"q")
        session.finish()
        if protocol == "Halfblocks":
            assert b"\x1b[5n" not in session.output, "Forced fallback unexpectedly queried the terminal"
        print(f"PASS: {protocol} startup, image emission, modal/hide/show, resize, exit, terminal restoration")
    finally:
        session.close()


def query_timeout(binary):
    session = Session(binary, [])
    try:
        session.until(b"\x1b[5n")
        # No capability reply: must exit, not leave two competing stdin readers.
        session.until(b"retry with --halfblocks")
        session.finish(expected_code=1)
        print("PASS: unanswered query fails safely and restores terminal")
    finally:
        session.close()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 smoke.py /path/to/codelia-image-preview")
    binary = Path(sys.argv[1]).resolve(strict=True)
    help_result = subprocess.run([str(binary), "--help"], capture_output=True, timeout=5)
    assert help_result.returncode == 0 and b"usage:" in help_result.stdout
    headless_env = dict(os.environ, TERM="xterm-256color", TERM_PROGRAM="")
    headless_env.pop("TMUX", None)
    headless = subprocess.run([str(binary), "--halfblocks"], capture_output=True, timeout=5,
                              env=headless_env)
    assert headless.returncode != 0 and b"requires an interactive terminal" in headless.stderr
    assert b"\x1b[?1049h" not in headless.stdout + headless.stderr
    for protocol in ("Halfblocks", "Kitty"):
        exercise(binary, protocol)
    query_timeout(binary)
    print("Native pixels, visual cleanup, and tmux compatibility still require separate manual verification.")


if __name__ == "__main__":
    main()
