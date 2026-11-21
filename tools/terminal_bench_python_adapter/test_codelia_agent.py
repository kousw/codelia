from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools.terminal_bench_python_adapter.codelia_agent import CodeliaInstalledAgent


class FakeEnvironment:
    def __init__(self, environment_type: str = "docker") -> None:
        self.environment_type = environment_type
        self.exec_calls: list[dict[str, object]] = []
        self.uploads: list[tuple[Path, str]] = []

    def type(self) -> str:
        return self.environment_type

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

    async def test_only_managed_trials_default_to_full_access(self) -> None:
        cases = (
            ("docker", {}, "full-access"),
            ("custom", {}, "workspace-write"),
            ("docker", {"approval_mode": "full-access"}, "workspace-write"),
            ("docker", {"approval_mode": "minimal"}, "readonly"),
            ("docker", {"sandbox_mode": "readonly"}, "readonly"),
            ("docker", {"approval_mode": "minimal", "sandbox_mode": "full-access"}, "full-access"),
        )
        for environment_type, options, expected_mode in cases:
            with self.subTest(environment=environment_type, options=options):
                with tempfile.TemporaryDirectory() as tmp:
                    agent = CodeliaInstalledAgent(logs_dir=Path(tmp), **options)
                    environment = FakeEnvironment(environment_type)
                    context = SimpleNamespace(metadata={})

                    await agent.run("Create the required output.", environment, context)

                command = environment.exec_calls[0]["command"]
                env = environment.exec_calls[0]["env"]
                self.assertIn(f"--sandbox-mode {expected_mode}", command)
                self.assertNotIn("--approval-mode", command)
                self.assertEqual(
                    "--harbor-shell-approval" in command,
                    expected_mode == "full-access",
                )
                self.assertEqual(
                    env.get("CODELIA_HARBOR_SHELL_APPROVAL"),
                    "1" if expected_mode == "full-access" else None,
                )
                self.assertEqual(context.metadata["sandbox_mode_requested"], expected_mode)
                self.assertEqual(context.metadata["approval_mode"], options.get("approval_mode"))

    async def test_unknown_environment_rejects_explicit_full_access(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CodeliaInstalledAgent(logs_dir=Path(tmp), sandbox_mode="full-access")
            environment = FakeEnvironment("custom")

            with self.assertRaisesRegex(ValueError, "Harbor-managed trial"):
                await agent.run("Create the required output.", environment, SimpleNamespace(metadata={}))

        self.assertEqual(environment.exec_calls, [])

    async def test_run_forwards_zai_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CodeliaInstalledAgent(logs_dir=Path(tmp))
            environment = FakeEnvironment()
            context = SimpleNamespace(metadata={})

            with patch.dict("os.environ", {"ZAI_API_KEY": "test-zai-key"}):
                await agent.run("Create the required output.", environment, context)

        self.assertEqual(
            environment.exec_calls[0]["env"]["ZAI_API_KEY"], "test-zai-key"
        )

    async def test_run_forwards_moonshot_api_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            agent = CodeliaInstalledAgent(logs_dir=Path(tmp))
            environment = FakeEnvironment()
            context = SimpleNamespace(metadata={})

            with patch.dict(
                "os.environ", {"MOONSHOT_API_KEY": "test-moonshot-key"}
            ):
                await agent.run("Create the required output.", environment, context)

        self.assertEqual(
            environment.exec_calls[0]["env"]["MOONSHOT_API_KEY"],
            "test-moonshot-key",
        )

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
