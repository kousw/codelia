"""Regression checks for PTY synchronization without starting a TUI."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("preview", Path(__file__).with_name("check-tui-image-preview.py"))
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class TerminalSynchronization(unittest.TestCase):
    def test_any_output_after_restoration_requires_another_draw(self):
        boundary = preview.RenderBoundary()
        boundary.feed(b"\x1b[?25h\x1b[1;1H")
        self.assertTrue(boundary.ready)
        boundary.feed(b"\n")
        self.assertFalse(boundary.ready)

    def test_split_and_adjacent_queries_are_answered_once(self):
        stream = b"draw\x1b[6n\x1b[6n\x1b[5nend\x1b[6n"
        for size in range(1, len(stream) + 1):
            tail, count = b"", 0
            for start in range(0, len(stream), size):
                found, tail = preview.cursor_queries(tail, stream[start:start + size])
                count += found
            self.assertEqual(count, 3, f"read size {size}")

    def test_dialog_input_waits_for_cursor_move_and_followup_draw(self):
        session = preview.Session.__new__(preview.Session)
        session.output = bytearray(b"DIALOG_TITLE\x1b[?25h")
        session.render_boundary = preview.RenderBoundary()
        session.render_boundary.feed(session.output)
        session.process = Mock()
        session.process.poll.return_value = None
        clock = [0.0]
        chunks = iter([b"\x1b[", b"2;5H", b"\x1b[6", b"n", b"followup\x1b[?25h\x1b[3;1H"])
        query_tail, replies = b"", []

        def pump(timeout=0.05):
            nonlocal query_tail
            clock[0] += timeout
            data = next(chunks, b"")
            session.output.extend(data)
            if data:
                session.render_boundary.feed(data)
            count, query_tail = preview.cursor_queries(query_tail, data)
            replies.extend([b"\x1b[1;1R"] * count)
            return bool(data)

        session.pump = pump
        with patch.object(preview.time, "monotonic", side_effect=lambda: clock[0]):
            session.drawn(len(b"DIALOG_TITLE"))
        self.assertEqual(replies, [b"\x1b[1;1R"])
        self.assertTrue(session.output.endswith(b"followup\x1b[?25h\x1b[3;1H"))
        self.assertGreaterEqual(clock[0], 0.26)

    def test_a_quiet_gap_mid_query_does_not_release_dialog_input(self):
        session = preview.Session.__new__(preview.Session)
        session.output = bytearray(b"TITLE\x1b[?25h\x1b[1;1H")
        session.render_boundary = preview.RenderBoundary()
        session.render_boundary.feed(session.output)
        session.process = Mock()
        session.process.poll.return_value = None
        clock = [0.0]
        chunks = [(0.02, b"\x1b[?25l\x1b[6"), (0.3, b"n"), (0.5, b"\x1b[?25h\x1b[2;1H")]

        def pump(timeout=0.05):
            clock[0] += timeout
            if chunks and clock[0] >= chunks[0][0]:
                _, data = chunks.pop(0)
                session.output.extend(data)
                session.render_boundary.feed(data)
                return True
            return False

        session.pump = pump
        with patch.object(preview.time, "monotonic", side_effect=lambda: clock[0]):
            session.drawn(len(b"TITLE"))
        self.assertFalse(chunks)
        self.assertGreaterEqual(clock[0], 0.6)

    def test_continuous_output_has_a_bounded_wait(self):
        session = preview.Session.__new__(preview.Session)
        session.output = bytearray()
        session.render_boundary = preview.RenderBoundary()
        session.process = Mock()
        session.process.poll.return_value = None
        clock = [0.0]

        def pump(timeout):
            clock[0] += timeout
            return True

        session.pump = pump
        with patch.object(preview.time, "monotonic", side_effect=lambda: clock[0]):
            with self.assertRaisesRegex(AssertionError, "Terminal did not settle"):
                session.settled(timeout=0.1)


if __name__ == "__main__":
    unittest.main()
