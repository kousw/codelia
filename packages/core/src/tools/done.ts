export class TaskComplete extends Error {
	public readonly finalMessage?: string;

	constructor(finalMessage?: string) {
		super("Task complete");
		this.name = "TaskComplete";
		this.finalMessage = finalMessage;
	}
}
