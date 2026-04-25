const DISCLOSURE_ANIMATION = {
	duration: 240,
	easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

export const animateDisclosureBody = (
	element: HTMLElement,
	direction: "open" | "close",
	onFinish?: () => void,
) => {
	const targetHeight = element.scrollHeight;
	if (targetHeight <= 0) {
		onFinish?.();
		return;
	}
	element.getAnimations().forEach((animation) => {
		animation.cancel();
	});
	element.style.overflow = "hidden";
	const frames =
		direction === "open"
			? [
					{
						opacity: 0.42,
						transform: "translateY(-3px)",
						height: "0px",
					},
					{
						opacity: 1,
						transform: "translateY(0)",
						height: `${targetHeight}px`,
					},
				]
			: [
					{
						opacity: 1,
						transform: "translateY(0)",
						height: `${targetHeight}px`,
					},
					{
						opacity: 0.42,
						transform: "translateY(-3px)",
						height: "0px",
					},
				];
	const cleanup = () => {
		element.style.overflow = "";
		onFinish?.();
	};
	const animation = element.animate(frames, DISCLOSURE_ANIMATION);
	animation.addEventListener("finish", cleanup, { once: true });
	animation.addEventListener("cancel", cleanup, { once: true });
};
