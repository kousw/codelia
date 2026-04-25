import { promises as fs } from "node:fs";
import path from "node:path";
import type { BaseMessage, SessionState } from "@codelia/core";
import type { ApprovalMode } from "@codelia/shared-types";
import type { RuntimeState } from "../runtime-state";

const RESUME_CONTEXT_META_KEY = "codelia_resume_context";
const RESUME_CONTEXT_SCHEMA_VERSION = 1;
const RESUME_DIFF_TAG = '<system-reminder type="session.resume.diff">';
const MAX_RESUME_DETAIL_LINES = 3;

type ResumeTrackedFile = {
	path: string;
	mtime_ms: number;
};

type ResumeContextMeta = {
	schema_version: 1;
	workspace_root?: string;
	working_dir?: string;
	sandbox_root?: string;
	approval_mode?: ApprovalMode;
	model_provider?: string;
	model_name?: string;
	initial_agents?: ResumeTrackedFile[];
	loaded_skills?: ResumeTrackedFile[];
};

type ResumeContextState = Pick<
	RuntimeState,
	| "lastUiContext"
	| "agentsResolver"
	| "skillsResolver"
	| "runtimeWorkingDir"
	| "runtimeSandboxRoot"
	| "approvalMode"
	| "currentModelProvider"
	| "currentModelName"
	| "systemPrompt"
>;

type ResumeDiffResult = {
	summary: string;
	systemReminder: string;
	changed: boolean;
};

type ResumeDiffBuildOptions = {
	bestEffortCurrentContext?: boolean;
};

const normalizePath = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return path.resolve(trimmed);
};

const normalizeMtime = (value: unknown): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.trunc(value);
};

const normalizeText = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeApprovalMode = (value: unknown): ApprovalMode | undefined => {
	if (value === "minimal" || value === "trusted" || value === "full-access") {
		return value;
	}
	return undefined;
};

const normalizeTrackedFiles = (value: unknown): ResumeTrackedFile[] => {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const files: ResumeTrackedFile[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as Record<string, unknown>;
		const filePath = normalizePath(record.path);
		const mtime = normalizeMtime(record.mtime_ms);
		if (!filePath || mtime === undefined || seen.has(filePath)) continue;
		seen.add(filePath);
		files.push({ path: filePath, mtime_ms: mtime });
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	return files;
};

const trimDetails = (lines: string[]): string[] => {
	if (lines.length <= MAX_RESUME_DETAIL_LINES) {
		return lines;
	}
	const remaining = lines.length - MAX_RESUME_DETAIL_LINES;
	return [
		...lines.slice(0, MAX_RESUME_DETAIL_LINES),
		`... and ${remaining} more change(s)`,
	];
};

const contentToString = (content: BaseMessage["content"]): string => {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if (
				"type" in part &&
				part.type === "text" &&
				typeof part.text === "string"
			) {
				return part.text;
			}
			return "";
		})
		.join("");
};

const isResumeDiffSystemMessage = (message: BaseMessage): boolean =>
	message.role === "system" &&
	contentToString(message.content).includes(RESUME_DIFF_TAG);

const resolveWorkspaceRoot = (state: ResumeContextState): string | undefined =>
	normalizePath(
		state.lastUiContext?.workspace_root ??
			state.agentsResolver?.getRootDir() ??
			state.runtimeSandboxRoot ??
			state.runtimeWorkingDir,
	);

const collectCurrentInitialAgents = (
	state: ResumeContextState,
): ResumeTrackedFile[] => {
	const snapshot = state.agentsResolver?.getSnapshot();
	if (!snapshot) return [];
	return snapshot.initialFiles
		.map((file) => ({
			path: normalizePath(file.path),
			mtime_ms: normalizeMtime(file.mtimeMs),
		}))
		.filter(
			(entry): entry is ResumeTrackedFile =>
				entry.path !== undefined && entry.mtime_ms !== undefined,
		)
		.sort((left, right) => left.path.localeCompare(right.path));
};

const collectCurrentLoadedSkills = (
	state: ResumeContextState,
): ResumeTrackedFile[] => {
	const snapshot = state.skillsResolver?.getSnapshot();
	if (!snapshot) return [];
	return snapshot.loaded_versions
		.map((entry) => ({
			path: normalizePath(entry.path),
			mtime_ms: normalizeMtime(entry.mtime_ms),
		}))
		.filter(
			(entry): entry is ResumeTrackedFile =>
				entry.path !== undefined && entry.mtime_ms !== undefined,
		)
		.sort((left, right) => left.path.localeCompare(right.path));
};

const parseResumeContextMeta = (
	meta: SessionState["meta"],
): ResumeContextMeta | null => {
	const raw = meta?.[RESUME_CONTEXT_META_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return null;
	}
	const record = raw as Record<string, unknown>;
	const schemaVersion = record.schema_version;
	if (schemaVersion !== RESUME_CONTEXT_SCHEMA_VERSION) {
		return null;
	}
	const workspaceRoot = normalizePath(record.workspace_root);
	const workingDir = normalizePath(record.working_dir);
	const sandboxRoot = normalizePath(record.sandbox_root);
	const approvalMode = normalizeApprovalMode(record.approval_mode);
	const modelProvider = normalizeText(record.model_provider);
	const modelName = normalizeText(record.model_name);
	const initialAgents = normalizeTrackedFiles(record.initial_agents);
	const loadedSkills = normalizeTrackedFiles(record.loaded_skills);
	return {
		schema_version: RESUME_CONTEXT_SCHEMA_VERSION,
		...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
		...(workingDir ? { working_dir: workingDir } : {}),
		...(sandboxRoot ? { sandbox_root: sandboxRoot } : {}),
		...(approvalMode ? { approval_mode: approvalMode } : {}),
		...(modelProvider ? { model_provider: modelProvider } : {}),
		...(modelName ? { model_name: modelName } : {}),
		...(initialAgents.length > 0 ? { initial_agents: initialAgents } : {}),
		...(loadedSkills.length > 0 ? { loaded_skills: loadedSkills } : {}),
	};
};

export const hasStructuredResumeContextMeta = (
	meta: SessionState["meta"],
): boolean => parseResumeContextMeta(meta) !== null;

const summarizeTrackedFileDiff = (
	label: string,
	savedFiles: ResumeTrackedFile[],
	currentFiles: ResumeTrackedFile[],
): string[] => {
	if (savedFiles.length === 0 && currentFiles.length === 0) {
		return [];
	}
	const savedByPath = new Map(
		savedFiles.map((file) => [file.path, file.mtime_ms]),
	);
	const currentByPath = new Map(
		currentFiles.map((file) => [file.path, file.mtime_ms]),
	);
	const details: string[] = [];
	for (const [filePath, savedMtime] of savedByPath) {
		const currentMtime = currentByPath.get(filePath);
		if (currentMtime === undefined) {
			details.push(`${label} removed from current context: ${filePath}`);
			continue;
		}
		if (currentMtime !== savedMtime) {
			details.push(
				`${label} updated: ${filePath} (mtime ${savedMtime} -> ${currentMtime})`,
			);
		}
	}
	for (const [filePath] of currentByPath) {
		if (!savedByPath.has(filePath)) {
			details.push(`${label} added in current context: ${filePath}`);
		}
	}
	return trimDetails(details);
};

const summarizeCurrentLoadedSkillDiff = (
	savedSkills: ResumeTrackedFile[],
	currentSkills: ResumeTrackedFile[],
): Promise<string[]> =>
	(async () => {
		if (savedSkills.length === 0 && currentSkills.length === 0) {
			return [];
		}
		const savedByPath = new Map(
			savedSkills.map((file) => [file.path, file.mtime_ms]),
		);
		const currentByPath = new Map(
			currentSkills.map((file) => [file.path, file.mtime_ms]),
		);
		const details: string[] = [];
		for (const [filePath, savedMtime] of savedByPath) {
			const currentLoadedMtime = currentByPath.get(filePath);
			if (currentLoadedMtime !== undefined) {
				if (currentLoadedMtime !== savedMtime) {
					details.push(
						`Loaded skill updated in current context: ${filePath} (mtime ${savedMtime} -> ${currentLoadedMtime})`,
					);
				}
				continue;
			}
			try {
				const stat = await fs.stat(filePath);
				const currentFileMtime = normalizeMtime(stat.mtimeMs);
				if (currentFileMtime !== undefined && currentFileMtime !== savedMtime) {
					details.push(
						`Loaded skill file updated since save: ${filePath} (mtime ${savedMtime} -> ${currentFileMtime})`,
					);
				}
			} catch {
				details.push(`Loaded skill file missing since save: ${filePath}`);
			}
		}
		for (const [filePath] of currentByPath) {
			if (!savedByPath.has(filePath)) {
				details.push(`Loaded skill added in current context: ${filePath}`);
			}
		}
		return trimDetails(details);
	})();

export const stripResumeDiffSystemMessages = (
	messages: SessionState["messages"],
): SessionState["messages"] =>
	messages.filter((message) => !isResumeDiffSystemMessage(message));

export const stripStartupSystemMessages = (
	messages: SessionState["messages"],
): SessionState["messages"] => {
	let firstNonSystem = 0;
	while (
		firstNonSystem < messages.length &&
		messages[firstNonSystem]?.role === "system"
	) {
		firstNonSystem += 1;
	}
	return firstNonSystem === 0 ? messages : messages.slice(firstNonSystem);
};

export const prependCurrentStartupSystemMessage = (
	messages: SessionState["messages"],
	systemPrompt: string | null | undefined,
): SessionState["messages"] => {
	const prompt = normalizeText(systemPrompt);
	if (!prompt) {
		return messages;
	}
	return [{ role: "system", content: prompt }, ...messages];
};

export const injectResumeDiffSystemReminder = (
	messages: SessionState["messages"],
	systemReminder: string,
): SessionState["messages"] => {
	const stripped = stripResumeDiffSystemMessages(messages);
	const reminder: BaseMessage = {
		role: "system",
		content: systemReminder,
	};
	let insertAt = 0;
	while (insertAt < stripped.length && stripped[insertAt]?.role === "system") {
		insertAt += 1;
	}
	return [
		...stripped.slice(0, insertAt),
		reminder,
		...stripped.slice(insertAt),
	];
};

export const mergeResumeContextIntoSessionMeta = (
	meta: Record<string, unknown> | undefined,
	state: ResumeContextState,
): Record<string, unknown> | undefined => {
	const nextMeta = meta ? { ...meta } : {};
	const resumeMeta: ResumeContextMeta = {
		schema_version: RESUME_CONTEXT_SCHEMA_VERSION,
		...(resolveWorkspaceRoot(state)
			? { workspace_root: resolveWorkspaceRoot(state) }
			: {}),
		...(normalizePath(state.runtimeWorkingDir)
			? { working_dir: normalizePath(state.runtimeWorkingDir) }
			: {}),
		...(normalizePath(state.runtimeSandboxRoot)
			? { sandbox_root: normalizePath(state.runtimeSandboxRoot) }
			: {}),
		...(state.approvalMode ? { approval_mode: state.approvalMode } : {}),
		...(normalizeText(state.currentModelProvider)
			? { model_provider: normalizeText(state.currentModelProvider) }
			: {}),
		...(normalizeText(state.currentModelName)
			? { model_name: normalizeText(state.currentModelName) }
			: {}),
	};
	const initialAgents = collectCurrentInitialAgents(state);
	if (initialAgents.length > 0) {
		resumeMeta.initial_agents = initialAgents;
	}
	const loadedSkills = collectCurrentLoadedSkills(state);
	if (loadedSkills.length > 0) {
		resumeMeta.loaded_skills = loadedSkills;
	}
	nextMeta[RESUME_CONTEXT_META_KEY] = resumeMeta;
	return Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
};

export const buildResumeDiff = async (
	meta: SessionState["meta"],
	state: ResumeContextState,
	options: ResumeDiffBuildOptions = {},
): Promise<ResumeDiffResult | null> => {
	const savedContext = parseResumeContextMeta(meta);
	const currentWorkspaceRoot = resolveWorkspaceRoot(state);
	const currentWorkingDir = normalizePath(state.runtimeWorkingDir);
	const currentSandboxRoot = normalizePath(state.runtimeSandboxRoot);
	const currentApprovalMode = normalizeApprovalMode(state.approvalMode);
	const currentModelProvider = normalizeText(state.currentModelProvider);
	const currentModelName = normalizeText(state.currentModelName);
	const currentAgents = collectCurrentInitialAgents(state);
	const currentLoadedSkills = collectCurrentLoadedSkills(state);
	const currentInitialAgentsKnown = state.agentsResolver !== null;
	const bestEffortCurrentContext = options.bestEffortCurrentContext === true;

	const contextLines: string[] = [];
	if (currentWorkspaceRoot) {
		contextLines.push(`Current workspace root: ${currentWorkspaceRoot}`);
	}
	if (currentWorkingDir) {
		contextLines.push(`Current working directory: ${currentWorkingDir}`);
	}
	if (currentSandboxRoot) {
		contextLines.push(`Current sandbox root: ${currentSandboxRoot}`);
	}
	if (currentApprovalMode) {
		contextLines.push(`Current approval mode: ${currentApprovalMode}`);
	}
	if (currentModelProvider || currentModelName) {
		contextLines.push(
			`Current model: ${currentModelProvider ?? "(unknown provider)"}/${
				currentModelName ?? "(unknown model)"
			}`,
		);
	}

	const detailLines: string[] = [];
	let changed = false;
	if (!savedContext) {
		detailLines.push(
			"Saved session has no structured resume metadata. Treat the current runtime/workspace context as authoritative.",
		);
		changed = true;
	} else {
		const comparePath = (
			label: string,
			savedValue: string | undefined,
			currentValue: string | undefined,
		): void => {
			if (bestEffortCurrentContext && currentValue === undefined) {
				return;
			}
			if (savedValue === currentValue) return;
			changed = true;
			detailLines.push(
				`${label}: ${savedValue ?? "(unknown)"} -> ${currentValue ?? "(unknown)"}`,
			);
		};
		comparePath(
			"Workspace root changed",
			savedContext.workspace_root,
			currentWorkspaceRoot,
		);
		comparePath(
			"Working directory changed",
			savedContext.working_dir,
			currentWorkingDir,
		);
		comparePath(
			"Sandbox root changed",
			savedContext.sandbox_root,
			currentSandboxRoot,
		);
		if (
			savedContext.approval_mode !== currentApprovalMode &&
			(!bestEffortCurrentContext || currentApprovalMode !== undefined)
		) {
			changed = true;
			detailLines.push(
				`Approval mode changed: ${savedContext.approval_mode ?? "(unknown)"} -> ${currentApprovalMode ?? "(unknown)"}`,
			);
		}
		if (
			(savedContext.model_provider !== currentModelProvider ||
				savedContext.model_name !== currentModelName) &&
			(!bestEffortCurrentContext ||
				currentModelProvider !== undefined ||
				currentModelName !== undefined)
		) {
			changed = true;
			detailLines.push(
				`Model changed: ${savedContext.model_provider ?? "(unknown provider)"}/${
					savedContext.model_name ?? "(unknown model)"
				} -> ${currentModelProvider ?? "(unknown provider)"}/${
					currentModelName ?? "(unknown model)"
				}`,
			);
		}
		if (!(bestEffortCurrentContext && !currentInitialAgentsKnown)) {
			const agentDiffs = summarizeTrackedFileDiff(
				"Initial AGENTS",
				savedContext.initial_agents ?? [],
				currentAgents,
			);
			if (agentDiffs.length > 0) {
				changed = true;
				detailLines.push(...agentDiffs);
			}
		}
		const skillDiffs = await summarizeCurrentLoadedSkillDiff(
			savedContext.loaded_skills ?? [],
			currentLoadedSkills,
		);
		if (skillDiffs.length > 0) {
			changed = true;
			detailLines.push(...skillDiffs);
		}
		if (!changed) {
			detailLines.push(
				"No material workspace/AGENTS/skill changes were detected from saved resume metadata.",
			);
		}
	}

	if (contextLines.length === 0 && detailLines.length === 0) {
		return null;
	}
	const summaryLines = [
		"Resume context:",
		...contextLines.map((line) => `- ${line}`),
		...detailLines.map((line) => `- ${line}`),
	];
	const systemLines = [
		'<system-reminder type="session.resume.diff">',
		"Session resumed in current runtime context:",
		...contextLines.map((line) => `- ${line}`),
		...detailLines.map((line) => `- ${line}`),
		"Use the current runtime/workspace context for subsequent actions.",
		"</system-reminder>",
	];
	return {
		summary: summaryLines.join("\n"),
		systemReminder: systemLines.join("\n"),
		changed,
	};
};
