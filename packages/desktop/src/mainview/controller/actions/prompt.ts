import { SLASH_COMMANDS } from "../../command-catalog";
import {
	appendErrorMessage,
	appendLocalExchange,
	applyControlSnapshot,
	applyInspectBundle,
	applySessionLoaded,
	attachStartedRun,
	beginPromptRun,
	beginShellCommand,
	clearPendingShellResults,
	failShellCommand,
	finishShellCommand,
	revertPromptRunStart,
	setComposer,
	setComposerNotice,
} from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import type { PendingShellResult, ViewState } from "../../state/view-state";
import { rpc } from "../runtime";

type ReasoningLevel = "low" | "medium" | "high" | "xhigh";

const REASONING_LEVELS: ReasoningLevel[] = ["low", "medium", "high", "xhigh"];

const createShellResultId = (() => {
	let next = 0;
	return () => `desktop-shell-${++next}-${Date.now()}`;
})();

const buildShellResultPrefix = (results: PendingShellResult[]): string => {
	return results
		.map((result) => {
			const payload = {
				id: result.id,
				command_preview: result.command_preview,
				exit_code: result.exit_code,
				signal: result.signal,
				duration_ms: result.duration_ms,
				stdout: result.stdout,
				stderr: result.stderr,
				stdout_cache_id: result.stdout_cache_id,
				stderr_cache_id: result.stderr_cache_id,
				truncated: result.truncated,
			};
			const jsonText = JSON.stringify(payload)
				.replaceAll("<", "\\u003c")
				.replaceAll(">", "\\u003e");
			return `<shell_result>\n${jsonText}\n</shell_result>`;
		})
		.join("\n");
};

const buildRuntimeMessage = (
	message: string,
	pendingShellResults: PendingShellResult[],
): string => {
	if (pendingShellResults.length === 0) {
		return message;
	}
	return `${buildShellResultPrefix(pendingShellResults)}\n\n${message}`;
};

const formatShellStream = (label: string, value: string): string => {
	const body = value.trimEnd();
	if (!body) {
		return "";
	}
	let fence = "```";
	while (body.includes(fence)) {
		fence += "`";
	}
	return `**${label}**\n\n${fence}text\n${body}\n${fence}`;
};

const formatShellResultMessage = (result: PendingShellResult): string => {
	const exitLabel =
		result.exit_code === null ? (result.signal ?? "signal") : result.exit_code;
	const parts = [
		`Shell command completed · exit ${exitLabel} · ${result.duration_ms}ms`,
		"",
		`\`${result.command_preview}\``,
		"",
		formatShellStream("stdout", result.stdout),
		formatShellStream("stderr", result.stderr),
		result.truncated.stdout ||
		result.truncated.stderr ||
		result.truncated.combined
			? [
					"Output was truncated.",
					result.stdout_cache_id
						? `stdout cache: \`${result.stdout_cache_id}\``
						: "",
					result.stderr_cache_id
						? `stderr cache: \`${result.stderr_cache_id}\``
						: "",
				]
					.filter(Boolean)
					.join("\n")
			: "",
	].filter(Boolean);
	return parts.join("\n\n");
};

const parseCommand = (message: string): { command: string; args: string[] } => {
	const [command = "", ...args] = message.trim().split(/\s+/);
	return { command, args };
};

const requireNoArgs = (command: string, args: string[]): boolean => {
	if (args.length === 0) return true;
	appendErrorMessage(`usage: ${command}`);
	return false;
};

const openInspectRail = async (
	workspacePath: string,
	notice: string,
): Promise<void> => {
	const inspect = await rpc.request.getInspect({
		workspace_path: workspacePath,
	});
	applyInspectBundle(inspect);
	setComposer("");
	setComposerNotice(notice);
};

const startCompactionRun = async (
	currentState: ViewState,
	workspacePath: string,
): Promise<void> => {
	beginPromptRun("/compact");
	try {
		const started = await rpc.request.startRun({
			workspace_path: workspacePath,
			session_id: currentState.snapshot.selected_session_id,
			message: "",
			force_compaction: true,
		});
		attachStartedRun({ ...started, workspace_path: workspacePath });
	} catch (error) {
		revertPromptRunStart(error);
	}
};

const runSlashCommand = async (
	currentState: ViewState,
	workspacePath: string,
	message: string,
): Promise<boolean> => {
	const { command, args } = parseCommand(message);
	switch (command) {
		case "/help": {
			if (!requireNoArgs(command, args)) return true;
			appendLocalExchange(
				message,
				[
					"Supported desktop commands:",
					"",
					...SLASH_COMMANDS.map(
						(spec) => `- \`${spec.usage}\` - ${spec.summary}`,
					),
					"",
					"`!command` runs a shell command and queues the result for your next prompt.",
				].join("\n"),
			);
			return true;
		}
		case "/new": {
			if (!requireNoArgs(command, args)) return true;
			const snapshot = await rpc.request.loadSession({
				workspace_path: workspacePath,
				session_id: null,
			});
			applySessionLoaded(snapshot, null);
			setComposer("");
			setComposerNotice("New draft chat");
			return true;
		}
		case "/compact": {
			if (!requireNoArgs(command, args)) return true;
			await startCompactionRun(currentState, workspacePath);
			return true;
		}
		case "/inspect":
			if (!requireNoArgs(command, args)) return true;
			await openInspectRail(workspacePath, "Inspect updated");
			return true;
		case "/context":
			if (args.length > 1 || (args[0] && args[0] !== "brief")) {
				appendErrorMessage("usage: /context [brief]");
				return true;
			}
			await openInspectRail(workspacePath, "Context opened in inspect");
			return true;
		case "/skills":
			await openInspectRail(workspacePath, "Skills opened in inspect");
			return true;
		case "/mcp":
			await openInspectRail(workspacePath, "MCP status opened in inspect");
			return true;
		case "/model": {
			if (args.length === 0) {
				appendLocalExchange(
					message,
					`Current model: ${currentState.snapshot.runtime_health?.model?.current ?? "not loaded"}\n\nUse \`/model [provider/]name\` or the model picker below.`,
				);
				return true;
			}
			if (args.length !== 1) {
				appendErrorMessage("usage: /model [provider/]name");
				return true;
			}
			const modelArg = args[0] ?? "";
			const [provider, name] = modelArg.includes("/")
				? modelArg.split("/", 2)
				: [currentState.snapshot.runtime_health?.model?.provider, modelArg];
			if (!name) {
				appendErrorMessage("usage: /model [provider/]name");
				return true;
			}
			const snapshot = await rpc.request.setModel({
				workspace_path: workspacePath,
				name,
				...(provider ? { provider } : {}),
				reasoning:
					(currentState.snapshot.runtime_health?.model
						?.reasoning as ReasoningLevel) ?? "medium",
				fast: currentState.snapshot.runtime_health?.model?.fast ?? false,
			});
			applyControlSnapshot(snapshot, "Model updated");
			setComposer("");
			setComposerNotice(`Model set to ${name}`);
			return true;
		}
		case "/reasoning": {
			if (
				args.length !== 1 ||
				!REASONING_LEVELS.includes(args[0] as ReasoningLevel)
			) {
				appendErrorMessage("usage: /reasoning <low|medium|high|xhigh>");
				return true;
			}
			const model = currentState.snapshot.runtime_health?.model;
			if (!model?.current) {
				appendErrorMessage("Model is not loaded yet");
				return true;
			}
			const reasoning = args[0] as ReasoningLevel;
			const snapshot = await rpc.request.setModel({
				workspace_path: workspacePath,
				name: model.current,
				provider: model.provider,
				reasoning,
				fast: model.fast ?? false,
			});
			applyControlSnapshot(snapshot, "Reasoning updated");
			setComposer("");
			setComposerNotice(`Reasoning set to ${reasoning}`);
			return true;
		}
		case "/fast": {
			if (
				args.length > 1 ||
				(args[0] !== undefined &&
					args[0] !== "on" &&
					args[0] !== "off" &&
					args[0] !== "toggle")
			) {
				appendErrorMessage("usage: /fast [on|off|toggle]");
				return true;
			}
			const model = currentState.snapshot.runtime_health?.model;
			if (!model?.current) {
				appendErrorMessage("Model is not loaded yet");
				return true;
			}
			const fast =
				args[0] === "on"
					? true
					: args[0] === "off"
						? false
						: !(model.fast === true);
			const snapshot = await rpc.request.setModel({
				workspace_path: workspacePath,
				name: model.current,
				provider: model.provider,
				reasoning: (model.reasoning as ReasoningLevel) ?? "medium",
				fast,
			});
			applyControlSnapshot(
				snapshot,
				fast ? "Fast mode enabled" : "Fast mode disabled",
			);
			setComposer("");
			setComposerNotice(`Fast mode ${fast ? "enabled" : "disabled"}`);
			return true;
		}
		default:
			if (command.startsWith("/")) {
				appendErrorMessage(`Unknown command: ${command}. Type /help.`);
				return true;
			}
			return false;
	}
};

const runBangCommand = async (
	workspacePath: string,
	message: string,
): Promise<boolean> => {
	const command = message.trim().slice(1).trim();
	if (!command) {
		appendErrorMessage("bang command is empty");
		return true;
	}
	beginShellCommand(command);
	try {
		const result = await rpc.request.execShell({
			workspace_path: workspacePath,
			command,
		});
		const queuedResult = {
			...result,
			id: createShellResultId(),
		};
		appendLocalExchange(`!${command}`, formatShellResultMessage(queuedResult));
		finishShellCommand(queuedResult);
	} catch (error) {
		failShellCommand(error);
	}
	return true;
};

export const sendPrompt = async (): Promise<void> => {
	const currentState = getDesktopViewState();
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const message = currentState.composer.trim();
	if (
		!workspacePath ||
		message.length === 0 ||
		currentState.isStreaming ||
		currentState.isShellRunning
	) {
		return;
	}
	if (message.startsWith("!")) {
		await runBangCommand(workspacePath, message);
		return;
	}
	if (message.startsWith("/")) {
		const handled = await runSlashCommand(currentState, workspacePath, message);
		if (handled) return;
	}

	beginPromptRun(message);

	try {
		const started = await rpc.request.startRun({
			workspace_path: workspacePath,
			session_id: currentState.snapshot.selected_session_id,
			message: buildRuntimeMessage(message, currentState.pendingShellResults),
		});
		if (currentState.pendingShellResults.length > 0) {
			clearPendingShellResults();
		}
		attachStartedRun({ ...started, workspace_path: workspacePath });
	} catch (error) {
		revertPromptRunStart(error);
	}
};

export const cancelRun = async (): Promise<void> => {
	const currentState = getDesktopViewState();
	if (!currentState.activeRunId) return;
	await rpc.request.cancelRun({ run_id: currentState.activeRunId });
};

export const openTranscriptLink = async (href: string): Promise<void> => {
	const result = await rpc.request.openLink({
		href,
		workspace_path: getDesktopViewState().snapshot.selected_workspace_path,
	});
	if (!result.ok) {
		appendErrorMessage(result.message ?? "Failed to open link");
	}
};
