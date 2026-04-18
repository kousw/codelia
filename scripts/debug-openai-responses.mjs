import OpenAI from "openai";

const usage = `Usage: bun run debug:openai:responses -- [--model <model>] [--input <text>]

Examples:
  bun run debug:openai:responses -- --model gpt-5.4 --input test
  bun run debug:openai:responses -- --input "hello from minimal repro"`;

const parseArgs = (argv) => {
	const options = {
		model: "gpt-5.4",
		input: "test",
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--model") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("--model requires a value");
			}
			options.model = value;
			index += 1;
			continue;
		}
		if (arg === "--input") {
			const value = argv[index + 1];
			if (!value) {
				throw new Error("--input requires a value");
			}
			options.input = value;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
};

const main = async () => {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(usage);
		return;
	}

	const apiKey = process.env.OPENAI_API_KEY?.trim();
	if (!apiKey) {
		throw new Error("OPENAI_API_KEY is required");
	}

	const client = new OpenAI({ apiKey });
	const response = await client.responses.create({
		model: options.model,
		input: options.input,
		store: false,
	});

	console.dir(
		{
			id: response.id,
			status: response.status,
			output_text: response.output_text,
			output: response.output,
			usage: response.usage,
		},
		{ depth: null, colors: process.stdout.isTTY },
	);
};

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	console.error(usage);
	process.exitCode = 1;
});
