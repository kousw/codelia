import type { InspectBundle } from "../../shared/types";

export const InspectPane = ({ inspect }: { inspect: InspectBundle | null }) => {
	if (!inspect) {
		return (
			<div className="inspect-stack">
				<div className="inspect-lead">
					<p className="panel-kicker">Inspector</p>
					<h3>Load deeper context only when the task needs it.</h3>
					<p className="muted">
						Keep the main pane focused on the active conversation, then pull
						runtime context, MCP inventory, and skill metadata on demand.
					</p>
				</div>
				<div className="inspect-group">
					<div className="inspect-list">
						<div className="inspect-item">
							<strong>Context</strong>
							<div className="muted">
								Current workspace root, cwd, and active file metadata.
							</div>
						</div>
						<div className="inspect-item">
							<strong>MCP</strong>
							<div className="muted">
								Configured servers, transport state, and available tool counts.
							</div>
						</div>
						<div className="inspect-item">
							<strong>Skills</strong>
							<div className="muted">
								Installed skills plus any load errors worth surfacing before
								execution.
							</div>
						</div>
					</div>
				</div>
			</div>
		);
	}

	const context = inspect.context;

	return (
		<div className="inspect-stack">
			<div className="inspect-card">
				<h3>Context</h3>
				<div className="inspect-list">
					<div className="inspect-item">
						<strong>cwd</strong>
						<div className="muted">
							{context.ui_context?.cwd ?? context.runtime_working_dir ?? "-"}
						</div>
					</div>
					<div className="inspect-item">
						<strong>workspace</strong>
						<div className="muted">
							{context.ui_context?.workspace_root ?? "-"}
						</div>
					</div>
					<div className="inspect-item">
						<strong>active file</strong>
						<div className="muted">
							{context.ui_context?.active_file_path ?? "-"}
						</div>
					</div>
				</div>
				{context.execution_environment ? (
					<pre>{context.execution_environment}</pre>
				) : null}
			</div>

			<div className="inspect-card">
				<h3>MCP</h3>
				<div className="inspect-list">
					{inspect.mcp.servers.length === 0 ? (
						<div className="inspect-item muted">No MCP servers configured.</div>
					) : (
						inspect.mcp.servers.map((server) => (
							<div key={server.id} className="inspect-item">
								<strong>{server.id}</strong>
								<div className="muted">
									{`${server.state} • ${server.transport}${
										server.tools !== undefined ? ` • ${server.tools} tools` : ""
									}`}
								</div>
							</div>
						))
					)}
				</div>
			</div>

			<div className="inspect-card">
				<h3>Skills</h3>
				<div className="inspect-list">
					{inspect.skills.skills.length === 0 ? (
						<div className="inspect-item muted">No skills found.</div>
					) : (
						inspect.skills.skills.map((skill) => (
							<div key={skill.filePath ?? skill.title} className="inspect-item">
								<strong>{skill.title}</strong>
								<div className="muted">{skill.description ?? ""}</div>
							</div>
						))
					)}
					{inspect.skills.errors.length > 0 ? (
						<div className="inspect-item">
							<strong>Load Errors</strong>
							<pre>
								{inspect.skills.errors.map((error) => error.message).join("\n")}
							</pre>
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
};
