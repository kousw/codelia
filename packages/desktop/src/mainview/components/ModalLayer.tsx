import type { ViewState } from "../controller";
import { commitState, hideSession, submitModal } from "../controller";

export const ModalLayer = ({ state }: { state: ViewState }) => {
	const request = state.pendingUiRequest;

	if (request?.method === "ui.confirm.request") {
		return (
			<div className="modal-backdrop">
				<div className="modal">
					<h3>{request.params.title}</h3>
					<p className="muted">{request.params.message}</p>
					<div className="modal-actions">
						<button
							type="button"
							className="button"
							onClick={() => void submitModal({ ok: false })}
						>
							{request.params.cancel_label ?? "Cancel"}
						</button>
						<button
							type="button"
							className={`button${
								request.params.danger_level === "danger"
									? " danger"
									: " primary"
							}`}
							onClick={() => void submitModal({ ok: true })}
						>
							{request.params.confirm_label ?? "Confirm"}
						</button>
					</div>
				</div>
			</div>
		);
	}

	if (request?.method === "ui.prompt.request") {
		return (
			<div className="modal-backdrop">
				<div className="modal">
					<h3>{request.params.title}</h3>
					<p className="muted">{request.params.message}</p>
					{request.params.multiline ? (
						<textarea
							id="modal-text"
							className="textarea"
							rows={6}
							value={state.modalText}
							onChange={(event) =>
								commitState((draft) => {
									draft.modalText = event.target.value;
								})
							}
						/>
					) : (
						<input
							id="modal-text"
							className="input"
							type={request.params.secret ? "password" : "text"}
							value={state.modalText}
							onChange={(event) =>
								commitState((draft) => {
									draft.modalText = event.target.value;
								})
							}
						/>
					)}
					<div className="modal-actions">
						<button
							type="button"
							className="button"
							onClick={() => void submitModal({ value: null })}
						>
							Cancel
						</button>
						<button
							type="button"
							className="button primary"
							onClick={() => void submitModal({ value: state.modalText })}
						>
							Submit
						</button>
					</div>
				</div>
			</div>
		);
	}

	if (request?.method === "ui.pick.request") {
		return (
			<div className="modal-backdrop">
				<div className="modal">
					<h3>{request.params.title}</h3>
					<div className="pick-list">
						{request.params.items.map((item) => (
							<label key={item.id} className="pick-option">
								<input
									type={request.params.multi ? "checkbox" : "radio"}
									name="pick-option"
									value={item.id}
									checked={state.modalPickIds.includes(item.id)}
									onChange={(event) =>
										commitState((draft) => {
											if (request.params.multi) {
												if (event.target.checked) {
													draft.modalPickIds = [
														...new Set([...draft.modalPickIds, item.id]),
													];
												} else {
													draft.modalPickIds = draft.modalPickIds.filter(
														(value) => value !== item.id,
													);
												}
												return;
											}
											draft.modalPickIds = event.target.checked
												? [item.id]
												: [];
										})
									}
								/>
								<span>
									<strong>{item.label}</strong>
									{item.detail ? (
										<small className="muted">{item.detail}</small>
									) : null}
								</span>
							</label>
						))}
					</div>
					<div className="modal-actions">
						<button
							type="button"
							className="button"
							onClick={() => void submitModal({ ids: [] })}
						>
							Cancel
						</button>
						<button
							type="button"
							className="button primary"
							onClick={() => void submitModal({ ids: state.modalPickIds })}
						>
							Choose
						</button>
					</div>
				</div>
			</div>
		);
	}

	if (state.pendingLocalDialog?.kind === "hide-session") {
		const pendingLocalDialog = state.pendingLocalDialog;

		return (
			<div className="modal-backdrop">
				<div className="modal">
					<h3>Hide Session?</h3>
					<p className="muted">
						"{pendingLocalDialog.sessionTitle}" will disappear from the desktop
						session list, but its shared session history will stay on disk.
					</p>
					<p className="muted">
						There is not a restore surface in the desktop UI yet, so use this
						only when you really want to hide it.
					</p>
					<div className="modal-actions">
						<button
							type="button"
							className="button"
							onClick={() =>
								commitState((draft) => {
									draft.pendingLocalDialog = null;
								})
							}
						>
							Cancel
						</button>
						<button
							type="button"
							className="button danger"
							onClick={() => void hideSession(pendingLocalDialog.sessionId)}
						>
							Hide Session
						</button>
					</div>
				</div>
			</div>
		);
	}

	return null;
};
