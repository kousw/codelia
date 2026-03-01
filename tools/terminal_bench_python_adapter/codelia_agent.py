from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class CodeliaInstalledAgent(BaseAgent):
    """Harbor custom agent that installs/runs Codelia headlessly in trials."""

    SUPPORTS_ATIF: bool = False
    SUPPORTED_REASONING_LEVELS = {"low", "medium", "high", "xhigh"}
    SUPPORTED_EXPERIMENTAL_OPENAI_WEBSOCKET_MODES = {"off", "auto", "on"}
    SUPPORTED_PROMPT_PROGRESS_STDERR_MODES = {"off", "auto", "on"}

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        approval_mode: str = "full-access",
        reasoning: str | None = None,
        experimental_openai_websocket_mode: str | None = None,
        prompt_progress_stderr: str | bool | None = "auto",
        codelia_npm_package: str = "@codelia/cli",
        codelia_npm_version: str | None = None,
        auth_file: str | None = None,
        *args,
        **kwargs,
    ):
        super().__init__(logs_dir=logs_dir, model_name=model_name, *args, **kwargs)
        self._approval_mode = approval_mode
        self._reasoning = self._normalize_reasoning(reasoning)
        self._experimental_openai_websocket_mode = (
            self._normalize_experimental_openai_websocket_mode(
                experimental_openai_websocket_mode
            )
        )
        self._codelia_npm_package = codelia_npm_package
        self._codelia_npm_version = codelia_npm_version
        self._auth_file = (
            Path(auth_file).expanduser()
            if auth_file
            else Path.home() / ".codelia" / "auth.json"
        )
        self._prompt_progress_stderr_mode = self._normalize_prompt_progress_stderr(
            prompt_progress_stderr
        )
        self._harbor_job_debug = self._detect_harbor_job_debug()

    @staticmethod
    def name() -> str:
        return "codelia"

    def version(self) -> str | None:
        return None

    def _normalize_reasoning(self, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().lower()
        if not normalized:
            return None
        if normalized not in self.SUPPORTED_REASONING_LEVELS:
            supported = "|".join(sorted(self.SUPPORTED_REASONING_LEVELS))
            raise ValueError(f"reasoning must be one of: {supported}")
        return normalized

    def _normalize_experimental_openai_websocket_mode(
        self, value: str | None
    ) -> str | None:
        if value is None:
            return None
        normalized = value.strip().lower()
        if not normalized:
            return None
        if normalized not in self.SUPPORTED_EXPERIMENTAL_OPENAI_WEBSOCKET_MODES:
            supported = "|".join(
                sorted(self.SUPPORTED_EXPERIMENTAL_OPENAI_WEBSOCKET_MODES)
            )
            raise ValueError(
                f"experimental_openai_websocket_mode must be one of: {supported}"
            )
        return normalized

    @staticmethod
    def _parse_boolish(value: object) -> bool | None:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            if value == 1:
                return True
            if value == 0:
                return False
            return None
        if not isinstance(value, str):
            return None
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        return None

    def _normalize_prompt_progress_stderr(self, value: str | bool | None) -> str:
        if value is None:
            return "auto"
        parsed = self._parse_boolish(value)
        if parsed is not None:
            return "on" if parsed else "off"
        if not isinstance(value, str):
            raise ValueError("prompt_progress_stderr must be bool or string")
        normalized = value.strip().lower()
        if not normalized or normalized == "auto":
            return "auto"
        if normalized in self.SUPPORTED_PROMPT_PROGRESS_STDERR_MODES:
            return normalized
        supported = "|".join(sorted(self.SUPPORTED_PROMPT_PROGRESS_STDERR_MODES))
        raise ValueError(f"prompt_progress_stderr must be one of: {supported}")

    def _detect_harbor_job_debug(self) -> bool:
        search_dirs = [self.logs_dir, *self.logs_dir.parents]
        for directory in search_dirs[:8]:
            config_path = directory / "config.json"
            if not config_path.is_file():
                continue
            try:
                config_data = json.loads(config_path.read_text())
            except Exception:
                continue
            if not isinstance(config_data, dict) or "debug" not in config_data:
                continue
            parsed = self._parse_boolish(config_data.get("debug"))
            return parsed is True
        return False

    def _should_emit_prompt_progress_stderr(self) -> bool:
        if self._prompt_progress_stderr_mode == "on":
            return True
        if self._prompt_progress_stderr_mode == "off":
            return False
        return self._harbor_job_debug

    def _resolve_model_selector(self) -> tuple[str, str] | None:
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
        return provider, name

    def _npm_spec(self) -> str:
        if self._codelia_npm_version and self._codelia_npm_version.strip():
            return f"{self._codelia_npm_package}@{self._codelia_npm_version.strip()}"
        return self._codelia_npm_package

    def _model_config_json(self) -> str | None:
        selector = self._resolve_model_selector()
        if not selector:
            if self._reasoning or self._experimental_openai_websocket_mode:
                raise ValueError(
                    "reasoning and experimental_openai_websocket_mode require model_name"
                )
            return None

        provider, name = selector
        if self._experimental_openai_websocket_mode and provider != "openai":
            raise ValueError(
                "experimental_openai_websocket_mode is only supported for openai provider"
            )

        config: dict[str, object] = {
            "version": 1,
            "model": {
                "provider": provider,
                "name": name,
                **({"reasoning": self._reasoning} if self._reasoning else {}),
            },
        }
        if self._experimental_openai_websocket_mode:
            config["experimental"] = {
                "openai": {
                    "websocket_mode": self._experimental_openai_websocket_mode,
                }
            }
        return f"{json.dumps(config, indent=2)}\n"

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
        prompt_progress_stderr_enabled = self._should_emit_prompt_progress_stderr()
        if prompt_progress_stderr_enabled:
            env_vars["CODELIA_PROMPT_PROGRESS_STDERR"] = "1"

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
            "reasoning": self._reasoning,
            "experimental_openai_websocket_mode": self._experimental_openai_websocket_mode,
            "prompt_progress_stderr_mode": self._prompt_progress_stderr_mode,
            "prompt_progress_stderr_enabled": prompt_progress_stderr_enabled,
            "harbor_debug": self._harbor_job_debug,
            "auth_file_uploaded": self._auth_file.exists(),
            "return_code": run_result.return_code,
        }

        if run_result.return_code != 0:
            raise RuntimeError(
                f"codelia run failed with exit code {run_result.return_code}: {run_result.stderr or run_result.stdout or 'unknown error'}"
            )
