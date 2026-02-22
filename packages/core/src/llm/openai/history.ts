import { MessageHistoryAdapter } from "../../history";

// Responses API-specific re-injection is no longer required.
// Keep a dedicated class name so history strategy can diverge later.
export class ResponsesHistoryAdapter extends MessageHistoryAdapter {}

// Backward-compatible alias for existing imports.
export class OpenAIHistoryAdapter extends ResponsesHistoryAdapter {}
