import type { GeneratedUiChartItem } from "../../../../../protocol/src/index";

const BAR_CHART_WIDTH = 240;

export const GeneratedUiBarChart = ({
	title,
	max,
	items,
}: {
	title: string;
	max: number | null;
	items: GeneratedUiChartItem[];
}) => {
	const resolvedMax = Math.max(
		max ?? 0,
		...items.map((item) => Math.max(0, item.value)),
		1,
	);
	return (
		<section className="generated-ui-chart">
			{title ? <div className="generated-ui-group-title">{title}</div> : null}
			<div className="generated-ui-chart-body">
				{items.map((item, index) => (
					<div
						key={`${item.label}-${index}`}
						className="generated-ui-chart-row"
					>
						<div className="generated-ui-chart-label">{item.label}</div>
						<div className="generated-ui-chart-track">
							<div
								className={`generated-ui-chart-fill tone-${item.tone}`}
								style={{
									width: `${Math.max(
										8,
										(item.value / resolvedMax) * BAR_CHART_WIDTH,
									)}px`,
								}}
							/>
						</div>
						<div className="generated-ui-chart-value">{item.value}</div>
					</div>
				))}
			</div>
		</section>
	);
};
