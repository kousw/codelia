import {
	forwardRef,
	type MouseEventHandler,
	type ReactNode,
	type Ref,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";

const AUTO_SCROLL_BUFFER_PX = 72;

const isNearBottom = (element: HTMLElement): boolean =>
	element.scrollHeight - element.scrollTop - element.clientHeight <=
	AUTO_SCROLL_BUFFER_PX;

const assignRef = <T,>(ref: Ref<T> | undefined, value: T) => {
	if (!ref) return;
	if (typeof ref === "function") {
		ref(value);
		return;
	}
	ref.current = value;
};

export const TranscriptScrollRegion = forwardRef<
	HTMLElement,
	{
		className: string;
		followSignal: object;
		onClick?: MouseEventHandler<HTMLElement>;
		onClickCapture?: MouseEventHandler<HTMLElement>;
		children: ReactNode;
	}
>(function TranscriptScrollRegion(
	{ className, followSignal, onClick, onClickCapture, children },
	forwardedRef,
) {
	const regionRef = useRef<HTMLElement | null>(null);
	const shouldStickToBottomRef = useRef(true);

	useEffect(() => {
		const root = regionRef.current;
		if (!root) return;
		const syncScrollIntent = () => {
			shouldStickToBottomRef.current = isNearBottom(root);
		};
		syncScrollIntent();
		root.addEventListener("scroll", syncScrollIntent, { passive: true });
		return () => {
			root.removeEventListener("scroll", syncScrollIntent);
		};
	}, []);

	useLayoutEffect(() => {
		const root = regionRef.current;
		if (!root || !shouldStickToBottomRef.current) return;
		root.scrollTop = root.scrollHeight;
	}, [followSignal]);

	return (
		<section
			ref={(node) => {
				regionRef.current = node;
				assignRef(forwardedRef, node);
			}}
			className={className}
			onClick={onClick}
			onClickCapture={onClickCapture}
		>
			{children}
		</section>
	);
});
