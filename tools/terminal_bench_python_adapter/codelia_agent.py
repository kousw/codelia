from __future__ import annotations

import os
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class CodeliaInstalledAgent(BaseAgent):
    """Harbor custom agent that installs/runs Codelia headlessly in trials."""

    SUPPORTS_ATIF: bool = False

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        approval_mode: str = "full-access",
        codelia_npm_package: str = "@codelia/cli",
        codelia_npm_version: str | None = None,
        auth_file: str | None = None,
        *args,
        **kwargs,
    ):
        super().__init__(logs_dir=logs_dir, model_name=model_name, *args, **kwargs)
        self._approval_mode = approval_mode
        self._codelia_npm_package = codelia_npm_package
        self._codelia_npm_version = codelia_npm_version
        self._auth_file = (
            Path(auth_file).expanduser()
            if auth_file
            else Path.home() / ".codelia" / "auth.json"
        )

    @staticmethod
    def name() -> str:
        return "codelia"

    def version(self) -> str | None:
        return None

    def _npm_spec(self) -> str:
        if self._codelia_npm_version and self._codelia_npm_version.strip():
            return f"{self._codelia_npm_package}@{self._codelia_npm_version.strip()}"
        return self._codelia_npm_package

    def _model_config_json(self) -> str | None:
        if not self.model_name:
            return None
        if "/" in self.model_name:
            provider, name = self.model_name.split("/", 1)
        else:
            provider, name = "openai", self.model_name
        provider = provider.strip()
        name = name.strip()
        if not provider or not name:
            return None
        return (
            "{\n"
            "  \"version\": 1,\n"
            "  \"model\": {\n"
            f"    \"provider\": \"{provider}\",\n"
            f"    \"name\": \"{name}\"\n"
            "  }\n"
            "}\n"
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        prep_and_install_cmd = (
            "set -euo pipefail\n"
            "if command -v apt-get >/dev/null 2>&1; then\n"
            "  apt-get update && apt-get install -y curl git ca-certificates python3 make g++\n"
            "elif command -v apk >/dev/null 2>&1; then\n"
            "  apk add --no-cache curl git ca-certificates python3 make g++ bash\n"
            "else\n"
            "  echo 'unable to install prerequisites (no apt-get/apk)' >&2\n"
            "  exit 1\n"
            "fi\n"
            "mkdir -p /root/.codelia /tmp/codelia /logs/agent\n"
            "export NVM_DIR=\"$HOME/.nvm\"\n"
            "if [ ! -s \"$NVM_DIR/nvm.sh\" ]; then\n"
            "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash\n"
            "fi\n"
            ". \"$NVM_DIR/nvm.sh\"\n"
            "nvm install 22\n"
            "nvm use 22\n"
            f"npm install -g {shlex.quote(self._npm_spec())}\n"
            "ln -sf \"$(command -v codelia)\" /usr/local/bin/codelia\n"
            "node -v\n"
            "npm -v\n"
            "codelia --version || true\n"
        )
        install_result = await environment.exec(command=prep_and_install_cmd)
        if install_result.return_code != 0:
            raise RuntimeError(
                f"failed to install codelia cli: {install_result.stderr or install_result.stdout or 'unknown error'}"
            )

        if self._auth_file.exists():
            await environment.upload_file(self._auth_file, "/root/.codelia/auth.json")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env_vars: dict[str, str] = {"CODELIA_LAYOUT": "home"}

        benchmark_prefix = (
            "You are running a benchmark evaluation task in an isolated local benchmark container.\n"
            "This task is authorized for benchmark measurement only; do not target any external systems.\n"
            "Follow the task instructions exactly and produce the required repository/file outputs so the verifier can evaluate them.\n\n"
        )
        effective_instruction = benchmark_prefix + instruction

        model_config_json = self._model_config_json()
        if model_config_json:
            write_config_cmd = (
                "mkdir -p /tmp/codelia && "
                f"cat > /tmp/codelia/config.json <<'JSON'\n{model_config_json}JSON"
            )
            write_result = await environment.exec(command=write_config_cmd)
            if write_result.return_code != 0:
                raise RuntimeError(
                    f"failed to write model config: {write_result.stderr or write_result.stdout or 'unknown error'}"
                )
            env_vars["CODELIA_CONFIG_PATH"] = "/tmp/codelia/config.json"

        for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"):
            value = os.environ.get(key)
            if value:
                env_vars[key] = value

        run_cmd = (
            "set -euo pipefail\n"
            "if [ -s \"$HOME/.nvm/nvm.sh\" ]; then . \"$HOME/.nvm/nvm.sh\"; nvm use 22 >/dev/null; fi\n"
            "if ! command -v codelia >/dev/null 2>&1; then\n"
            "  echo 'codelia command not found after setup' >&2\n"
            "  exit 127\n"
            "fi\n"
            f"codelia -p {shlex.quote(effective_instruction)} --approval-mode {shlex.quote(self._approval_mode)} "
            "2>&1 | tee /logs/agent/codelia-output.log\n"
        )
        run_result = await environment.exec(command=run_cmd, env=env_vars)

        context.metadata = {
            "agent": "codelia",
            "approval_mode": self._approval_mode,
            "model_name": self.model_name,
            "auth_file_uploaded": self._auth_file.exists(),
            "return_code": run_result.return_code,
        }

        if run_result.return_code != 0:
            raise RuntimeError(
                f"codelia run failed with exit code {run_result.return_code}: {run_result.stderr or run_result.stdout or 'unknown error'}"
            )
