import { useEffect, useRef, useState } from "react";
import { GitBranch, uiIconProps } from "../../icons";
import type { ComposerGitState } from "./composer-types";

export const ComposerBranchPicker = ({
	git,
	onSwitchBranch,
}: {
	git?: ComposerGitState;
	onSwitchBranch: (branch: string) => Promise<void>;
}) => {
	const branchMenuRef = useRef<HTMLDivElement | null>(null);
	const [branchMenuOpen, setBranchMenuOpen] = useState(false);
	const branchOptions = [
		...new Set([
			...(git?.branch ? [git.branch] : []),
			...(git?.branches ?? []),
		]),
	];
	const branchPickerDisabled = !git?.branch || branchOptions.length === 0;

	useEffect(() => {
		if (!branchMenuOpen) {
			return;
		}
		const closeBranchMenu = (event: MouseEvent) => {
			if (
				branchMenuRef.current &&
				!branchMenuRef.current.contains(event.target as Node)
			) {
				setBranchMenuOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setBranchMenuOpen(false);
			}
		};
		window.addEventListener("mousedown", closeBranchMenu);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("mousedown", closeBranchMenu);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [branchMenuOpen]);

	useEffect(() => {
		if (branchPickerDisabled && branchMenuOpen) {
			setBranchMenuOpen(false);
		}
	}, [branchMenuOpen, branchPickerDisabled]);

	return (
		<div className="composer-branch-control" ref={branchMenuRef}>
			<GitBranch {...uiIconProps} className="composer-branch-icon" />
			<button
				type="button"
				className="composer-branch-button"
				aria-label="Git branch"
				aria-haspopup="listbox"
				aria-expanded={branchMenuOpen}
				disabled={branchPickerDisabled}
				title={git?.branch ?? "no-git"}
				onClick={() => setBranchMenuOpen((current) => !current)}
			>
				<span>{git?.branch ?? "no-git"}</span>
			</button>
			{branchMenuOpen ? (
				<div className="composer-branch-menu" role="listbox">
					{branchOptions.map((branch) => (
						<button
							type="button"
							key={branch}
							className={`composer-branch-option${
								branch === git?.branch ? " is-selected" : ""
							}`}
							role="option"
							aria-selected={branch === git?.branch}
							title={branch}
							onClick={() => {
								setBranchMenuOpen(false);
								void onSwitchBranch(branch);
							}}
						>
							<span>{branch}</span>
						</button>
					))}
				</div>
			) : null}
			{git?.isDirty ? (
				<span className="composer-branch-dirty">dirty</span>
			) : null}
		</div>
	);
};
