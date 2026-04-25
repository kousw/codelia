import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

export const AssistantMarkdown = ({
	content,
	finalized,
	onOpenLink,
}: {
	content: string;
	finalized: boolean;
	onOpenLink: (href: string) => Promise<void>;
}) => {
	return (
		<div className={`assistant-copy${finalized ? "" : " is-streaming"}`}>
			<div className="assistant-copy-body markdown-body">
				<ReactMarkdown
					remarkPlugins={MARKDOWN_REMARK_PLUGINS}
					skipHtml
					components={{
						a: ({ node: _node, ...props }) => {
							const href = props.href;
							return (
								<button
									type="button"
									className="markdown-link-button"
									onClick={(event) => {
										event.preventDefault();
										if (typeof href === "string") {
											void onOpenLink(href);
										}
									}}
								>
									{props.children}
								</button>
							);
						},
						code: ({ className, children, ...props }) => {
							const hasLanguage =
								typeof className === "string" &&
								className.includes("language-");
							if (hasLanguage) {
								return (
									<code className={className} {...props}>
										{children}
									</code>
								);
							}
							return (
								<code className="markdown-inline-code" {...props}>
									{children}
								</code>
							);
						},
						pre: ({ node: _node, ...props }) => (
							<pre className="markdown-code-block" {...props} />
						),
					}}
				>
					{content}
				</ReactMarkdown>
			</div>
		</div>
	);
};
