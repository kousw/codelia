from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from tools.terminal_bench_python_adapter.codelia_agent import CodeliaInstalledAgent


class FakeEnvironment:
    def __init__(self) -> None:
        self.exec_calls: list[dict[str, object]] = []
        self.uploads: list[tuple[Path, str]] = []

    async def exec(self, command: str, **kwargs: object) -> SimpleNamespace:
        self.exec_calls.append({"command": command, **kwargs})
        return SimpleNamespace(return_code=0, stdout="", stderr="")

    async def upload_file(self, source: Path, destination: str) -> None:
        self.uploads.append((source, destination))


class CodeliaInstalledAgentTest(unittest.IsolatedAsyncioTestCase):
    async def test_run_declares_and_writes_atif_trajectory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CodeliaInstalledAgent(logs_dir=Path(tmp))
            environment = FakeEnvironment()
            context = SimpleNamespace(metadata={})

            await agent.run("Create the required output.", environment, context)

        self.assertTrue(agent.SUPPORTS_ATIF)
        self.assertEqual(
            environment.exec_calls[0]["env"]["CODELIA_ATIF_OUT"],
            "/logs/agent/trajectory.json",
        )
        self.assertIn(
            "test -s /logs/agent/trajectory.json",
            environment.exec_calls[0]["command"],
        )
        self.assertEqual(context.metadata["supports_atif"], True)
        self.assertEqual(context.metadata["atif_path"], "/logs/agent/trajectory.json")

    async def test_setup_can_install_uploaded_local_npm_tarballs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            package_file = Path(tmp) / "codelia-cli.tgz"
            package_file.write_text("fake package", encoding="utf-8")
            agent = CodeliaInstalledAgent(
                logs_dir=Path(tmp),
                codelia_npm_package_files=str(package_file),
                system_prompt_file=None,
            )
            environment = FakeEnvironment()

            await agent.setup(environment)

        self.assertIn(
            (package_file, "/tmp/codelia/codelia-cli.tgz"),
            environment.uploads,
        )
        self.assertIn(
            "npm install -g /tmp/codelia/codelia-cli.tgz",
            environment.exec_calls[1]["command"],
        )


if __name__ == "__main__":
    unittest.main()
