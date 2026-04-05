import { useDesktopStore } from "../state/desktop-store";

export const useModalState = () => {
	const pendingUiRequest = useDesktopStore((state) => state.pendingUiRequest);
	const pendingLocalDialog = useDesktopStore(
		(state) => state.pendingLocalDialog,
	);
	const modalText = useDesktopStore((state) => state.modalText);
	const modalPickIds = useDesktopStore((state) => state.modalPickIds);

	return {
		pendingUiRequest,
		pendingLocalDialog,
		modalText,
		modalPickIds,
	};
};
