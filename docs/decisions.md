# Decisions

The local TUI exposes a `decision` tool for structured classification, routing,
and ordered scoring. Ask Codelia to use **OpenAI Decisions** or **Google
Decisions**, and describe the evidence and the questions to evaluate. The tool
returns probabilities and, when supplied by the provider, confidence values;
it does not generate explanations.

For example, ask: “Use Google Decisions to check whether `photo.png` shows
damage, and rate its severity as low, medium, or high.” The file must be
accessible on the runtime host. You can also attach an image, or specify an
existing image artifact or a public image URL. Codelia can use the artifact ID
included with an attachment or generated image. Merely viewing an image does
not select it for a decision; identify the image in the request. PNG, JPEG,
and WebP images are accepted, up to four images and 16 MiB combined. Text and
images can be used together, or an image can be the sole evidence.

The tool supports yes/no predicates, choices with named options, and ordered
score levels. Multiple questions share the same evidence and are evaluated
independently. Scores use a probability-weighted, zero-based level index; the
tool also returns the distribution over the supplied levels. Probabilities are
estimates, so choose thresholds and review procedures appropriate to the task.

| Provider | Decision model | API key |
| --- | --- | --- |
| OpenAI | `gpt-6-luna` | Saved OpenAI API key or `OPENAI_API_KEY` |
| Google | `gemini-decision-1` | Saved Google API key, `GOOGLE_API_KEY`, or `GEMINI_API_KEY` |

The selected provider's API-key account is billed for the request. OpenAI
chat OAuth alone cannot authorize Decisions, although an OpenAI API key can be
used alongside it. Existing approval mode and permission rules apply; the
confirmation identifies the provider, evidence references, and questions.
No provider, model, endpoint, or authentication fallback is performed.

Decisions are independent of `/image-model` and chat model selection. The
current tool supports shared text and image evidence, not PDF, audio, video, or
per-question images. Decision usage is returned with the tool result when the
provider supplies it; it is not added to the chat usage totals.
