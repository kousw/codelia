import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	fetchSettings,
	type Provider,
	type PublicSettings,
	patchSettings,
	type ReasoningEffort,
} from "../api";

type Props = {
	isOpen: boolean;
	onClose: () => void;
};

type ReasoningChoice = "" | ReasoningEffort;

const formatUpdatedAt = (value?: string): string => {
	if (!value) return "never";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
};

const formatExpiry = (timestamp?: number): string => {
	if (!timestamp) return "unknown";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "unknown";
	return date.toLocaleString();
};

export const SettingsDialog = ({ isOpen, onClose }: Props) => {
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [oauthConnecting, setOauthConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [settings, setSettings] = useState<PublicSettings | null>(null);

	const [provider, setProvider] = useState<Provider>("openai");
	const [model, setModel] = useState("");
	const [reasoning, setReasoning] = useState<ReasoningChoice>("");
	const [openaiApiKey, setOpenaiApiKey] = useState("");
	const [anthropicApiKey, setAnthropicApiKey] = useState("");
	const [clearOpenAIKey, setClearOpenAIKey] = useState(false);
	const [clearAnthropicKey, setClearAnthropicKey] = useState(false);
	const oauthPollTimerRef = useRef<number | null>(null);
	const oauthPopupRef = useRef<Window | null>(null);

	const stopOAuthPolling = useCallback(() => {
		if (oauthPollTimerRef.current !== null) {
			window.clearInterval(oauthPollTimerRef.current);
			oauthPollTimerRef.current = null;
		}
		setOauthConnecting(false);
	}, []);

	useEffect(() => {
		if (!isOpen) return;

		const load = async () => {
			setLoading(true);
			setError(null);
			setNotice(null);
			try {
				const data = await fetchSettings();
				setSettings(data);
				setProvider(data.provider ?? "openai");
				setModel(data.model ?? "");
				setReasoning(data.reasoning ?? "");
				setOpenaiApiKey("");
				setAnthropicApiKey("");
				setClearOpenAIKey(false);
				setClearAnthropicKey(false);
			} catch (loadError) {
				setError(
					loadError instanceof Error ? loadError.message : String(loadError),
				);
			} finally {
				setLoading(false);
			}
		};

		void load();
	}, [isOpen]);

	useEffect(() => {
		if (!isOpen) {
			stopOAuthPolling();
		}
	}, [isOpen, stopOAuthPolling]);

	useEffect(() => {
		return () => {
			stopOAuthPolling();
			if (oauthPopupRef.current && !oauthPopupRef.current.closed) {
				oauthPopupRef.current.close();
			}
		};
	}, [stopOAuthPolling]);

	const keyStateText = useMemo(() => {
		if (!settings) {
			return {
				openai: "Not loaded",
				anthropic: "Not loaded",
			};
		}
		return {
			openai: settings.openai_api_key_set
				? `Saved (${settings.openai_api_key_preview ?? "hidden"})`
				: "Not saved",
			anthropic: settings.anthropic_api_key_set
				? `Saved (${settings.anthropic_api_key_preview ?? "hidden"})`
				: "Not saved",
		};
	}, [settings]);

	const openAiOAuthStatus = useMemo(() => {
		if (!settings?.openai_oauth_connected) return "Not connected";
		return `Connected (expires ${formatExpiry(settings.openai_oauth_expires_at)})`;
	}, [settings]);

	if (!isOpen) return null;

	const handleSubmit = async (event: FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const next = await patchSettings({
				provider,
				model,
				...(reasoning ? { reasoning } : { clear_reasoning: true }),
				...(openaiApiKey.trim() ? { openai_api_key: openaiApiKey.trim() } : {}),
				...(anthropicApiKey.trim()
					? { anthropic_api_key: anthropicApiKey.trim() }
					: {}),
				...(clearOpenAIKey ? { clear_openai_api_key: true } : {}),
				...(clearAnthropicKey ? { clear_anthropic_api_key: true } : {}),
			});
			setSettings(next);
			setNotice("Saved. New runs will use updated settings.");
			setOpenaiApiKey("");
			setAnthropicApiKey("");
			setClearOpenAIKey(false);
			setClearAnthropicKey(false);
			onClose();
		} catch (saveError) {
			setError(
				saveError instanceof Error ? saveError.message : String(saveError),
			);
		} finally {
			setSaving(false);
		}
	};

	const handleConnectOpenAiOAuth = () => {
		if (oauthConnecting || loading || saving) return;
		setError(null);
		setNotice("Complete OpenAI sign-in in the popup window.");
		setOauthConnecting(true);

		const popup = window.open(
			"/api/settings/openai/oauth/start",
			"codelia-openai-oauth",
			"popup,width=620,height=780",
		);
		if (!popup) {
			setOauthConnecting(false);
			setError("Popup was blocked. Allow popups and try again.");
			return;
		}
		oauthPopupRef.current = popup;

		const startedAt = Date.now();
		const poll = async () => {
			try {
				const latest = await fetchSettings();
				setSettings(latest);
				if (latest.openai_oauth_connected) {
					stopOAuthPolling();
					setNotice("OpenAI OAuth connected. New runs can use OAuth.");
					return;
				}
			} catch {
				// polling errors are temporary in dev; keep waiting
			}

			if (Date.now() - startedAt > 3 * 60 * 1000) {
				stopOAuthPolling();
				setError("OpenAI OAuth timed out. Try again.");
				return;
			}
			if (popup.closed && Date.now() - startedAt > 2_000) {
				stopOAuthPolling();
				setError("OAuth popup was closed before completion.");
			}
		};

		void poll();
		oauthPollTimerRef.current = window.setInterval(() => {
			void poll();
		}, 1500);
	};

	const handleDisconnectOpenAiOAuth = async () => {
		if (loading || saving) return;
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const latest = await patchSettings({ clear_openai_oauth: true });
			setSettings(latest);
			setNotice("OpenAI OAuth disconnected.");
		} catch (disconnectError) {
			setError(
				disconnectError instanceof Error
					? disconnectError.message
					: String(disconnectError),
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="az-modal" role="presentation">
			<button
				type="button"
				className="az-modal-overlay"
				aria-label="Close settings dialog"
				onClick={onClose}
			/>
			<section
				className="az-modal-card"
				role="dialog"
				aria-modal="true"
				aria-label="Model and authentication settings"
			>
				<header className="az-modal-head">
					<div>
						<p className="az-overline">Runtime Settings</p>
						<h2 className="az-modal-title">Authentication & Model</h2>
						<p className="az-modal-subtitle">
							Last updated: {formatUpdatedAt(settings?.updated_at)}
						</p>
					</div>
					<button
						type="button"
						className="az-btn az-btn-muted"
						onClick={onClose}
					>
						Close
					</button>
				</header>

				{loading ? (
					<div className="az-muted-box">Loading settings...</div>
				) : null}
				{error ? (
					<div className="az-error-banner az-inline-banner">{error}</div>
				) : null}
				{notice ? (
					<div className="az-notice-banner az-inline-banner">{notice}</div>
				) : null}

				<form
					onSubmit={handleSubmit}
					className="az-settings-form"
					autoComplete="off"
					data-1p-ignore="true"
					data-lpignore="true"
				>
					<input
						type="text"
						name="username"
						autoComplete="username"
						tabIndex={-1}
						aria-hidden="true"
						className="az-autofill-trap"
					/>
					<input
						type="password"
						name="password"
						autoComplete="current-password"
						tabIndex={-1}
						aria-hidden="true"
						className="az-autofill-trap"
					/>
					<label className="az-form-row" htmlFor="provider">
						<span>Provider</span>
						<select
							id="provider"
							value={provider}
							onChange={(e) => setProvider(e.target.value as Provider)}
							disabled={loading || saving}
							className="az-select"
						>
							<option value="openai">OpenAI</option>
							<option value="anthropic">Anthropic</option>
						</select>
					</label>

					<label className="az-form-row" htmlFor="model">
						<span>Model</span>
						<input
							id="model"
							type="text"
							name="az_model"
							value={model}
							onChange={(e) => setModel(e.target.value)}
							placeholder="e.g. gpt-5"
							disabled={loading || saving}
							className="az-input az-input-single"
							autoComplete="off"
							data-1p-ignore="true"
							data-lpignore="true"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
					</label>

					<label className="az-form-row" htmlFor="reasoning">
						<span>Reasoning (OpenAI)</span>
						<select
							id="reasoning"
							value={reasoning}
							onChange={(e) => setReasoning(e.target.value as ReasoningChoice)}
							disabled={loading || saving}
							className="az-select"
						>
							<option value="">Use default</option>
							<option value="low">low</option>
							<option value="medium">medium</option>
							<option value="high">high</option>
						</select>
					</label>

					<div className="az-key-block">
						<div className="az-key-head">
							<p>OpenAI API Key</p>
							<span>{keyStateText.openai}</span>
						</div>
						<input
							type="password"
							name="az_openai_api_key"
							value={openaiApiKey}
							onChange={(e) => setOpenaiApiKey(e.target.value)}
							placeholder="sk-..."
							autoComplete="new-password"
							disabled={loading || saving}
							className="az-input az-input-single"
							data-1p-ignore="true"
							data-lpignore="true"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
						<label className="az-check-row">
							<input
								type="checkbox"
								checked={clearOpenAIKey}
								onChange={(e) => setClearOpenAIKey(e.target.checked)}
								disabled={loading || saving}
							/>
							<span>Clear saved OpenAI key</span>
						</label>
					</div>

					<div className="az-key-block">
						<div className="az-key-head">
							<p>OpenAI OAuth (ChatGPT Plus/Pro)</p>
							<span>{openAiOAuthStatus}</span>
						</div>
						<p className="az-helper-text">
							Connect OAuth to use your ChatGPT subscription for OpenAI runs.
						</p>
						<div className="az-inline-actions">
							<button
								type="button"
								className="az-btn az-btn-solid"
								onClick={handleConnectOpenAiOAuth}
								disabled={loading || saving || oauthConnecting}
							>
								{oauthConnecting
									? "Waiting for OAuth..."
									: "Connect OpenAI OAuth"}
							</button>
							<button
								type="button"
								className="az-btn az-btn-muted"
								onClick={handleDisconnectOpenAiOAuth}
								disabled={
									loading || saving || !settings?.openai_oauth_connected
								}
							>
								Disconnect OAuth
							</button>
						</div>
					</div>

					<div className="az-key-block">
						<div className="az-key-head">
							<p>Anthropic API Key</p>
							<span>{keyStateText.anthropic}</span>
						</div>
						<input
							type="password"
							name="az_anthropic_api_key"
							value={anthropicApiKey}
							onChange={(e) => setAnthropicApiKey(e.target.value)}
							placeholder="sk-ant-..."
							autoComplete="new-password"
							disabled={loading || saving}
							className="az-input az-input-single"
							data-1p-ignore="true"
							data-lpignore="true"
							autoCapitalize="off"
							autoCorrect="off"
							spellCheck={false}
						/>
						<label className="az-check-row">
							<input
								type="checkbox"
								checked={clearAnthropicKey}
								onChange={(e) => setClearAnthropicKey(e.target.checked)}
								disabled={loading || saving}
							/>
							<span>Clear saved Anthropic key</span>
						</label>
					</div>

					<div className="az-modal-actions">
						<button
							type="button"
							className="az-btn az-btn-muted"
							onClick={onClose}
							disabled={saving}
						>
							Cancel
						</button>
						<button
							type="submit"
							className="az-btn az-btn-accent"
							disabled={loading || saving}
						>
							{saving ? "Saving..." : "Save Settings"}
						</button>
					</div>
				</form>
			</section>
		</div>
	);
};
