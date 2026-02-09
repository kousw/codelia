import { MessageHistoryAdapter } from "../../history";

// OpenAI-specific re-injection is no longer required.
// Keep the adapter class for compatibility with existing construction paths.
export class OpenAIHistoryAdapter extends MessageHistoryAdapter {}
