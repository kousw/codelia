import { useDesktopStore } from "../state/desktop-store";

export const useInspectState = () => {
	const inspectOpen = useDesktopStore((state) => state.inspectOpen);
	const inspect = useDesktopStore((state) => state.inspect);

	return {
		inspectOpen,
		inspect,
	};
};
