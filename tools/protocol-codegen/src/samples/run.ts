// run.start, run.cancel and attachment uploads (Phase 2).
import { group, invalid, type Sample, typed } from "./helpers";

const textInput = { type: "text", text: "hello" };

export const runSamples: Sample[] = [
	...group("ui_to_runtime_request", "run.start", [
		typed("text input", { input: textInput }),
		typed("resumed session with client tools and context", {
			input: {
				type: "parts",
				parts: [
					{ type: "text", text: "see file" },
					{ type: "attachment_ref", attachment_id: "att_1" },
				],
			},
			session_id: "session-1",
			tools: [
				{
					name: "tui_open_selector",
					description: "Open a selector",
					parameters: { type: "object", properties: {} },
					approval: "never",
					timeout_ms: 30000,
				},
			],
			tool_choice: "auto",
			ui_context: {
				cwd: "/work",
				active_file: { path: "src/main.rs", language_id: "rust" },
				selection: {
					path: "src/main.rs",
					range: {
						start: { line: 1, column: 0 },
						end: { line: 2, column: 4 },
					},
				},
				extensions: { editor: "x" },
			},
			meta: { origin: "test" },
		}),
		typed("forced compaction", { input: textInput, force_compaction: true }),
		invalid("missing input", { session_id: "session-1" }),
		invalid("client tool without parameters", {
			input: textInput,
			tools: [{ name: "t", description: "d" }],
		}),
		invalid(
			"unknown client tool approval",
			{
				input: textInput,
				tools: [
					{ name: "t", description: "d", parameters: {}, approval: "always" },
				],
			},
			"typed",
		),
	]),
	...group("runtime_to_ui_response", "run.start", [
		typed("started", {
			run_id: "run-1",
			session_id: "session-1",
			session_log_path: "/logs/run-1.jsonl",
		}),
		invalid("without run id", { session_id: "session-1" }),
	]),
	...group("ui_to_runtime_request", "run.cancel", [
		typed("with reason", { run_id: "run-1", reason: "user" }),
		typed("without reason", { run_id: "run-1" }),
		invalid("missing run id", { reason: "user" }),
	]),
	...group("runtime_to_ui_response", "run.cancel", [
		typed("cancelled", { ok: true }),
		invalid("not ok", { ok: false }),
	]),
	...group("ui_to_runtime_request", "attachment.upload.begin", [
		typed("begin", {
			upload_key: "draft-1-f",
			display_name: "notes.txt",
			byte_size: 12,
			sha256: "a".repeat(64),
			session_id: "session-1",
		}),
		invalid("fractional size", {
			upload_key: "k",
			display_name: "n",
			byte_size: 1.5,
			sha256: "a".repeat(64),
		}),
	]),
	...group("runtime_to_ui_response", "attachment.upload.begin", [
		typed("begin acknowledged", { upload_id: "up-1", offset: 0 }),
		invalid("missing offset", { upload_id: "up-1" }),
	]),
	...group("ui_to_runtime_request", "attachment.upload.chunk", [
		typed("chunk", { upload_id: "up-1", offset: 0, data: "aGVsbG8=" }),
		invalid("missing data", { upload_id: "up-1", offset: 0 }),
	]),
	...group("runtime_to_ui_response", "attachment.upload.chunk", [
		typed("chunk acknowledged", { offset: 5 }),
		invalid("missing offset", {}),
	]),
	...group("ui_to_runtime_request", "attachment.upload.finish", [
		typed("finish", { upload_id: "up-1" }),
		invalid("missing upload id", {}),
	]),
	...group("runtime_to_ui_response", "attachment.upload.finish", [
		typed("finished", { attachment_id: "att_1" }),
		invalid("missing attachment id", {}),
	]),
	...group("ui_to_runtime_request", "attachment.upload.cancel", [
		typed("cancel", { upload_id: "up-1" }),
		invalid("missing upload id", {}),
	]),
	...group("runtime_to_ui_response", "attachment.upload.cancel", [
		typed("cancelled", { ok: true }),
		invalid("false acknowledgement", { ok: false }),
	]),
];
