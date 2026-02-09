const SKILL_MENTION_PATTERN = /\$([a-z0-9]+(?:-[a-z0-9]+)*)/g;

const extractSkillMentions = (value: string): string[] => {
	const mentions: string[] = [];
	for (const match of value.matchAll(SKILL_MENTION_PATTERN)) {
		const name = match[1]?.trim().toLowerCase();
		if (!name || mentions.includes(name)) continue;
		mentions.push(name);
	}
	return mentions;
};

const buildSkillMentionHint = (mentions: string[]): string => {
	const lines: string[] = [
		"",
		"<skill_mentions>",
		...mentions.map((name) => `- ${name}`),
		"</skill_mentions>",
	];
	return lines.join("\n");
};

export const prepareRunInputText = (inputText: string): string => {
	const mentions = extractSkillMentions(inputText);
	if (!mentions.length) return inputText;
	return `${inputText}${buildSkillMentionHint(mentions)}`;
};
