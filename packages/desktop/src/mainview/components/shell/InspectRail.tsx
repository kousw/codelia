import type { InspectBundle } from "../../../shared/types";
import { RefreshCw, uiIconProps, X } from "../../icons";
import { InspectPane } from "../InspectPane";

export const InspectRail = ({
	inspect,
	onRefresh,
	onClose,
}: {
	inspect: InspectBundle | null;
	onRefresh: () => Promise<void>;
	onClose: () => Promise<void>;
}) => {
	return (
		<aside className="panel inspect-rail">
			<div className="inspect-header">
				<h2>Inspect</h2>
				<div className="inspect-actions">
					<button
						type="button"
						className="button button-subtle icon-button"
						aria-label="Refresh inspect"
						title="Refresh inspect"
						onClick={() => void onRefresh()}
					>
						<RefreshCw {...uiIconProps} className="button-icon" />
					</button>
					<button
						type="button"
						className="button button-subtle icon-button"
						aria-label="Close inspect"
						title="Close inspect"
						onClick={() => void onClose()}
					>
						<X {...uiIconProps} className="button-icon" />
					</button>
				</div>
			</div>
			<div className="inspect-body">
				<InspectPane inspect={inspect} />
			</div>
		</aside>
	);
};
