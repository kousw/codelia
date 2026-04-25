import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopWorkspace } from "../../../shared/types";
import {
	Activity,
	ChevronDown,
	Code2,
	FolderOpen,
	PanelRightClose,
	PanelRightOpen,
	SlidersHorizontal,
	uiIconProps,
} from "../../icons";

type WorkspaceOpenTarget = "cursor" | "finder";

const OPEN_TARGET_META: Record<
	WorkspaceOpenTarget,
	{ label: string; menuLabel: string; Icon: LucideIcon }
> = {
	cursor: {
		label: "Cursor",
		menuLabel: "Open in Cursor",
		Icon: Code2,
	},
	finder: {
		label: "Finder",
		menuLabel: "Reveal in Finder",
		Icon: FolderOpen,
	},
};

export const WorkspaceTopbar = ({
	workspace,
	runtimeConnected,
	inspectOpen,
	onToggleInspect,
	onOpenWorkspaceTarget,
	onChooseWorkspace,
}: {
	workspace?: DesktopWorkspace;
	runtimeConnected: boolean;
	inspectOpen: boolean;
	onToggleInspect: () => Promise<void>;
	onOpenWorkspaceTarget: (target: WorkspaceOpenTarget) => Promise<void>;
	onChooseWorkspace: () => Promise<void>;
}) => {
	const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
	const [workspaceOpenTarget, setWorkspaceOpenTarget] =
		useState<WorkspaceOpenTarget>("cursor");
	const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
	const openTargetMeta = OPEN_TARGET_META[workspaceOpenTarget];
	const OpenTargetIcon = openTargetMeta.Icon;
	const InspectToggleIcon = inspectOpen ? PanelRightClose : PanelRightOpen;
	const workspaceName = workspace?.name ?? "Select a workspace";

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && workspaceMenuOpen) {
				setWorkspaceMenuOpen(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [workspaceMenuOpen]);

	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (
				workspaceMenuOpen &&
				workspaceMenuRef.current &&
				!workspaceMenuRef.current.contains(event.target as Node)
			) {
				setWorkspaceMenuOpen(false);
			}
		};
		window.addEventListener("pointerdown", onPointerDown);
		return () => window.removeEventListener("pointerdown", onPointerDown);
	}, [workspaceMenuOpen]);

	return (
		<header className="topbar electrobun-webkit-app-region-drag">
			<div className="topbar-breadcrumbs">
				<span className="breadcrumb-strong">{workspaceName}</span>
			</div>
			<div className="topbar-actions electrobun-webkit-app-region-no-drag">
				<div className="topbar-menu" ref={workspaceMenuRef}>
					<div className="open-split-button">
						<button
							type="button"
							className="button open-split-main"
							onClick={() => {
								if (!workspace?.path) {
									void onChooseWorkspace();
									return;
								}
								void onOpenWorkspaceTarget(workspaceOpenTarget);
							}}
						>
							<span className="open-split-icon">
								<OpenTargetIcon {...uiIconProps} />
							</span>
							<span className="open-split-label">{openTargetMeta.label}</span>
						</button>
						<button
							type="button"
							className="button open-split-toggle"
							aria-label="Choose workspace open target"
							aria-expanded={workspaceMenuOpen}
							onClick={() => setWorkspaceMenuOpen((open) => !open)}
						>
							<ChevronDown
								{...uiIconProps}
								className="open-split-chevron-icon"
							/>
						</button>
					</div>
					{workspaceMenuOpen && workspace?.path ? (
						<div className="menu-popover">
							{(
								[
									["cursor", OPEN_TARGET_META.cursor],
									["finder", OPEN_TARGET_META.finder],
								] as const
							).map(([target, meta]) => {
								const Icon = meta.Icon;
								return (
									<button
										key={target}
										type="button"
										className={`menu-item${
											workspaceOpenTarget === target ? " is-selected" : ""
										}`}
										onClick={() => {
											setWorkspaceOpenTarget(target);
											setWorkspaceMenuOpen(false);
										}}
									>
										<span className="menu-item-icon">
											<Icon {...uiIconProps} />
										</span>
										<span>{meta.menuLabel}</span>
									</button>
								);
							})}
							<button
								type="button"
								className="menu-item"
								onClick={() => {
									setWorkspaceMenuOpen(false);
									void onChooseWorkspace();
								}}
							>
								<span className="menu-item-icon">
									<FolderOpen {...uiIconProps} />
								</span>
								<span>Choose Workspace...</span>
							</button>
						</div>
					) : null}
				</div>
				<output
					className={`topbar-icon-state${runtimeConnected ? " is-connected" : ""}`}
					title={runtimeConnected ? "Runtime connected" : "Runtime offline"}
					aria-label={
						runtimeConnected ? "Runtime connected" : "Runtime offline"
					}
				>
					<Activity {...uiIconProps} className="button-icon" />
				</output>
				<button
					type="button"
					className="button button-subtle icon-button"
					onClick={() => void onToggleInspect()}
					aria-label={inspectOpen ? "Hide Inspect" : "Inspect"}
					title={inspectOpen ? "Hide Inspect" : "Inspect"}
				>
					<InspectToggleIcon {...uiIconProps} className="button-icon" />
				</button>
				<button
					type="button"
					className="button button-subtle icon-button"
					aria-label="View options"
					title="View options"
					disabled
				>
					<SlidersHorizontal {...uiIconProps} className="button-icon" />
				</button>
			</div>
		</header>
	);
};
