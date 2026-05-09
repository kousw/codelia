export type ClientToolChoice = "auto" | "required" | "none" | string;

export type ClientToolDefinition = {
	type?: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict?: boolean;
	timeout_ms?: number;
	approval?: "default" | "never";
};

export type ClientToolCallRequestParams = {
	run_id: string;
	name: string;
	arguments?: Record<string, unknown>;
	raw_arguments: string;
};

export type ClientToolStructuredResult =
	| { type: "text"; text: string }
	| { type: "json"; value: unknown }
	| { type: "parts"; parts: unknown[] };

export type ClientToolResultValue =
	| string
	| number
	| boolean
	| null
	| ClientToolStructuredResult
	| Record<string, unknown>
	| unknown[];

export type ClientToolCallResult =
	| {
			ok: true;
			result?: ClientToolResultValue;
	  }
	| {
			ok: false;
			error: string;
	  };
