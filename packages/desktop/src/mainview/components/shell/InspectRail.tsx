import type { ViewState } from "../../controller";
import { RefreshCw, X, uiIconProps } from "../../icons";
import { InspectPane } from "../InspectPane";

export const InspectRail = ({
	inspect,
	onRefresh,
	onClose,
}: {
	inspect: ViewState["inspect"];
	onRefresh: () => Promise<void>;
	onClose: () => Promise<void>;
}) => {
	return (
		<aside className="panel inspect-rail">
			<div className="inspect-header">
				<h2>Inspect</h2>
				<div className="topbar-actions">
					<button
						type="button"
						className="button has-icon"
						onClick={() => void onRefresh()}
					>
						<RefreshCw {...uiIconProps} className="button-icon" />
						<span>Refresh</span>
					</button>
					<button
						type="button"
						className="button has-icon"
						onClick={() => void onClose()}
					>
						<X {...uiIconProps} className="button-icon" />
						<span>Close</span>
					</button>
				</div>
			</div>
			<div className="inspect-body">
				<InspectPane inspect={inspect} />
			</div>
		</aside>
	);
};
