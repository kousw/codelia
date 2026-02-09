import { describe, expect, test } from "bun:test";
import type { AgentEvent, SessionStateSummary, SkillCatalog } from "../src";

describe("@codelia/shared-types contracts", () => {
	test("AgentEvent shape remains stable for tool_result", () => {
		const event: AgentEvent = {
			type: "tool_result",
			tool: "bash",
			result: "ok",
			tool_call_id: "call_1",
			is_error: false,
		};
		expect(event).toMatchInlineSnapshot(`
      {
        "is_error": false,
        "result": "ok",
        "tool": "bash",
        "tool_call_id": "call_1",
        "type": "tool_result",
      }
    `);
	});

	test("SessionStateSummary shape remains stable", () => {
		const summary: SessionStateSummary = {
			session_id: "session_1",
			updated_at: "2026-02-08T00:00:00.000Z",
			run_id: "run_1",
			message_count: 3,
			last_user_message: "hello",
		};
		expect(summary).toMatchInlineSnapshot(`
      {
        "last_user_message": "hello",
        "message_count": 3,
        "run_id": "run_1",
        "session_id": "session_1",
        "updated_at": "2026-02-08T00:00:00.000Z",
      }
    `);
	});

	test("SkillCatalog shape remains stable", () => {
		const catalog: SkillCatalog = {
			skills: [
				{
					id: "skill_1",
					name: "repo-review",
					description: "Review pull requests with risk checklist.",
					path: "/repo/.agents/skills/repo-review/SKILL.md",
					dir: "/repo/.agents/skills/repo-review",
					scope: "repo",
					mtime_ms: 1738972800000,
				},
			],
			errors: [],
			truncated: false,
		};
		expect(catalog).toMatchInlineSnapshot(`
      {
        "errors": [],
        "skills": [
          {
            "description": "Review pull requests with risk checklist.",
            "dir": "/repo/.agents/skills/repo-review",
            "id": "skill_1",
            "mtime_ms": 1738972800000,
            "name": "repo-review",
            "path": "/repo/.agents/skills/repo-review/SKILL.md",
            "scope": "repo",
          },
        ],
        "truncated": false,
      }
    `);
	});
});
