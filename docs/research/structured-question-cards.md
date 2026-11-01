# Structured question cards across AI Provider types

Research for [#241](https://github.com/cgbarlow/gantry/issues/241), part of map [#238](https://github.com/cgbarlow/gantry/issues/238) (v0.13.0 AI interview). Sources read 2026-11-01. Every claim links to the first-party doc or source file it comes from.

**Question.** Which AI Provider types (Anthropic, OpenAI, Ollama, LM Studio, OpenRouter, custom OpenAI-compatible) can reliably emit AskUserQuestion-style question cards through tool calling or structured output, with streaming? How do their wire formats differ? What is the fallback when a model can't call tools? Can "Test connection" detect the capability?

## Answer in brief

- **Every type can carry a question card as a tool call.** The differences are in how reliable it is and whether it can be forced, not in whether it exists.
- **Don't force the tool. Use `tool_choice: "auto"` everywhere.** Anthropic's newest models (Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1) reject forced tool use with a 400. Ollama's OpenAI-compatible endpoint doesn't support `tool_choice` at all, and LM Studio's docs don't mention it. In the interview, free chat alongside the cards is a valid turn anyway, so a turn that returns plain text is normal, not a failure.
- **Treat the schema as a contract the model can only approximate, and validate in Gantry.** Strict mode guarantees the shape on Anthropic and OpenAI. But Anthropic's strict grammar can't express "2–4 options" or "1–4 questions" (array bounds other than `minItems` 0/1 aren't supported), and the local runtimes enforce nothing. Gantry's Node server must check counts and the recommendation itself.
- **Streaming: show the card only when the tool call is complete.** Anthropic buffers each key/value pair before streaming it. Ollama sends a tool call whole in one chunk. Chat Completions and the Responses API send argument fragments. A progressively built card isn't worth the cost. Show a "preparing questions…" placeholder as soon as the tool call starts.
- **Fallback: a JSON-in-text card, then plain chat.** Don't turn the model away. If a model has no working tool calling, use the same card schema in a fenced ` ```gantry-questions ` block in the text, parsed and validated with the same validator. If neither parses, the turn shows as plain chat and the architect replies in free text. Iris already works this way (JSON in text, no tool use).
- **Detection: metadata hint plus a probe call at Test connection.** Read the capability flag where the provider publishes one (Ollama, LM Studio, OpenRouter, Anthropic). Then run one cheap probe: the real card tool, streamed, `tool_choice: auto`. Record the outcome as `cards: native | fallback`. The probe is authoritative, and it is the only option for OpenAI and custom endpoints.
- **One decision this raises:** OpenAI's newest models (GPT-6 Astra, GPT-6.1 Sol) **require the Responses API for tool calling**. If the OpenAI type speaks Chat Completions as Iris does, those models drop to the fallback. See [Open decision](#open-decision-for-the-map).

## Support by AI Provider type

| AI Provider type | Tool calling | Force a tool? | Schema enforcement | Tool-call streaming | Capability metadata | Verdict |
|---|---|---|---|---|---|---|
| **Anthropic** (Messages API) | Yes, on every model | `any`/`tool` on older models. **400 on Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1.** Error with manual extended thinking | `strict: true` (grammar-constrained), all models. No `maxItems`, `minLength`; `minItems` 0/1 only | `input_json_delta` fragments, buffered per key/value (unless `eager_input_streaming`) | `GET /v1/models` → `capabilities.structured_outputs` (no forced-tool flag) | **Native, auto + strict** |
| **OpenAI** | Yes. GPT-6 Astra / GPT-6.1 Sol: **Responses API only** | `required` or named function | `strict: true`. Supports `minItems`/`maxItems`. All fields required, `additionalProperties: false` | Chat: `delta.tool_calls[]` fragments. Responses: `response.function_call_arguments.delta`/`.done` | `GET /models` has **no** capability info | **Native** (if the wire format matches the model) |
| **OpenRouter** | Yes, normalised across providers | `auto`/`none`/named function | `strict` passed through; "exact compliance is not guaranteed on every endpoint" | Chat and Responses formats | `GET /api/v1/models` → `supported_parameters` includes `tools`, `tool_choice`, `structured_outputs` | **Native when listed, else fallback.** Send `provider.require_parameters: true` |
| **Ollama** (`/v1` OpenAI-compatible) | Yes, for tool-trained models | **`tool_choice` unsupported** on `/v1` | None for tools. `response_format`/`format` JSON-schema available for plain output | Native `/api/chat` sends tool calls whole in one chunk. `/v1` not documented | `POST /api/show` → `capabilities` contains `"tools"` | **Native if `tools` capability, else fallback** |
| **LM Studio** (`/v1` OpenAI-compatible) | "Native" (template + parser) or "Default" (prompted, "results will vary") | Not documented | Tool args not enforced. `response_format: json_schema` is grammar-enforced (llama.cpp / Outlines) | `delta.tool_calls[]` fragments | `GET /api/v1/models` → `capabilities.trained_for_tool_use` | **Native if trained_for_tool_use, else fallback.** Unparseable calls land in `content` |
| **Custom OpenAI-compatible** | Unknown | Unknown | Unknown | Assume Chat Completions fragments | None assumed | **Probe decides** |

### Anthropic

- Tool definition: `name`, `description`, `input_schema` (JSON Schema), optional `input_examples`. Response: a `tool_use` block `{id, name, input}` where `input` is an **object**. Results go back as `tool_result` blocks. ([Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools))
- `tool_choice`: `auto` (default with tools), `any`, `tool`, `none`. With `any`/`tool` "the models will not emit a natural language response or explanation before `tool_use` content blocks", and "Forcing a tool also skips thinking". ([Define tools › Forcing tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use))
- **Forced tool use is rejected by the newest models.** "Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1, and Claude Mythos 5.1 don't support forced tool use. Sending `tool_choice: {"type": "any"}` or `tool_choice: {"type": "tool", ...}` … returns a 400 `invalid_request_error`: `tool_choice: type "tool" and "any" are not supported for this model.`" The recommended replacement is "`auto` with strict tool use". Forcing also fails with manual extended thinking. ([API errors › Forced tool use not supported](https://platform.claude.com/docs/en/api/errors#forced-tool-use-not-supported); [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use))
- Prefill is also gone on Claude 4.6+ ("This model does not support assistant message prefill"), so the old "prefill `{`" trick for JSON-in-text is unavailable. ([API errors › Prefill not supported](https://platform.claude.com/docs/en/api/errors#prefill-not-supported))
- **Strict tool use:** `strict: true` "guarantees Claude's tool inputs match your JSON Schema by constraining the model's token sampling", and it is available on every model. ([Strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use))
- **Schema limits that matter for cards:** `additionalProperties` must be `false`. Array `minItems` supports "only values 0 and 1". "Array constraints beyond `minItems` of 0 or 1", `minLength`/`maxLength`, numeric bounds and recursive schemas are not supported, and using one gives a 400. Per request: at most 20 strict tools, 24 optional parameters and 16 union-typed parameters. ([Structured outputs › JSON Schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations))
- **Streaming:** `content_block_start` with `{"type":"tool_use", …, "input":{}}`, then `content_block_delta` events with `{"type":"input_json_delta","partial_json":"…"}`, then `content_block_stop`. `stop_reason` is `tool_use`. "Current models only support emitting one complete key and value property from `input` at a time … there might be delays between streaming events." ([Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming))
- `eager_input_streaming: true` skips the buffering, but "you might receive partial or invalid JSON", and `max_tokens` can cut a parameter off midway. Not needed for small card payloads. ([Fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming))
- **Metadata:** `GET /v1/models` returns a `capabilities` object (`structured_outputs`, `thinking.types`, `image_input`, `pdf_input`, …). It has no field for forced tool use, so the probe/allow-list approach still applies. The reference example sends `anthropic-version: 2026-10-21`. Iris pins `2023-06-01`, so check that the `capabilities` field comes back under the version Gantry pins. ([List Models](https://platform.claude.com/docs/en/api/models/list); `iris/backend/app/ai/client.py`)

### OpenAI

- **Chat Completions:** `tools: [{type:"function", function:{name, description, parameters, strict}}]`. `strict` defaults to `false`. `tool_choice` is `none` | `auto` | `required` | `{type:"function", function:{name}}` | `{type:"allowed_tools", …}`. `parallel_tool_calls` defaults to `true`. `finish_reason` `"tool_calls"`. A tool call's `function.arguments` is a **JSON string**. Stream chunks carry `choices[].delta.tool_calls[]` with `index`, optional `id`, optional `function.name` and `function.arguments` fragments. ([Chat create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create); [Chat streaming events](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events))
- **Responses API:** flat tool shape `{type:"function", name, description, parameters, strict}`. Streaming emits `response.output_item.added`, then `response.function_call_arguments.delta` and `response.function_call_arguments.done` (the latter carrying the full `arguments`). ([Function calling](https://developers.openai.com/api/docs/guides/function-calling))
- **"GPT-6 Astra and GPT-6.1 Sol require the Responses API for tool calling."** Chat Completions requests "remain non-strict by default". Reasoning items returned alongside tool calls "must also be passed back with tool call outputs". ([Function calling](https://developers.openai.com/api/docs/guides/function-calling))
- **Strict:** "Setting `strict` to `true` will ensure function calls reliably adhere to the function schema, instead of being best effort". This requires `additionalProperties: false` and every property in `required` (optional fields are written as a `null` union). `parallel_tool_calls: false` "ensures exactly zero or one tool is called". ([Function calling](https://developers.openai.com/api/docs/guides/function-calling))
- **Schema subset:** arrays support `minItems` **and** `maxItems`. The root must be an object and must not use `anyOf`. Limits are 5000 properties, 10 nesting levels and 1000 enum values. `allOf`, `not` and `if/then/else` are unsupported. Refusals come back in a `refusal` field that "does not necessarily follow the schema". ([Structured outputs › Supported schemas](https://developers.openai.com/api/docs/guides/structured-outputs))
- **Metadata:** `GET /models/{model}` returns only `id`, `created`, `object`, `owned_by`, `shutdown_date`, with no capability info. ([Retrieve model](https://developers.openai.com/api/reference/resources/models/methods/retrieve))

### OpenRouter

- "OpenRouter standardizes the tool calling interface across models and providers". It accepts both Responses (`/api/v1/responses`) and Chat Completions (`/api/v1/chat/completions`) shapes. `tool_choice` takes `auto`, `none` or a named function. `parallel_tool_calls` defaults to true "for most models". ([Tool calling](https://openrouter.ai/docs/guides/features/tool-calling.md))
- **Model metadata:** `GET /api/v1/models?supported_parameters=tools` filters to tool-capable models. Each model's `supported_parameters` lists `tools`, `tool_choice`, `structured_outputs`, `response_format`, …. ([Models](https://openrouter.ai/docs/guides/overview/models.md))
- **Routing:** by default, providers "that don't support all the parameters … can still receive the request, but will ignore unknown parameters". `require_parameters: true` stops that. `tools` and `response_format` act as a soft preference even without it, but "if none of a model's providers support the parameter … the parameter is ignored". So without `require_parameters`, tools can be silently dropped. ([Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection.md))
- **Strict:** "Enforcement varies by provider … exact compliance is not guaranteed on every endpoint." Structured outputs stream "valid partial JSON". ([Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md))

### Ollama

- Native `/api/chat` takes OpenAI-shaped `tools`. Replies carry `message.tool_calls[].function.{name, arguments}`, with `arguments` as an **object**. Results go back as `{"role":"tool","tool_name":…}`. Streaming: "gather every chunk of `thinking`, `content`, and `tool_calls`". ([Tool calling](https://docs.ollama.com/capabilities/tool-calling))
- The streaming parser "focuses on understanding the structure of a tool call rather than simply looking for JSON". In the example, the whole call arrives in a single chunk. ([Ollama blog, "Streaming responses with tool calling", 2025-05-28](https://ollama.com/blog/streaming-tool))
- **OpenAI-compatible `/v1/chat/completions`:** Tools ✅, `response_format` ✅, streaming ✅, **`tool_choice` ❌**. ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility))
- Structured outputs: pass a JSON Schema in `format` (native) or `response_format` (`/v1`). The docs advise also putting the schema in the prompt, and "Ollama's cloud currently does not support structured outputs". ([Structured outputs](https://docs.ollama.com/capabilities/structured-outputs))
- **Metadata:** `POST /api/show` returns `capabilities: string[]` ([Show model details](https://docs.ollama.com/api-reference/show-model-details.md)). The defined values include `"tools"` (`CapabilityTools = Capability("tools")`). ([ollama/ollama `types/model/capability.go`](https://github.com/ollama/ollama/blob/main/types/model/capability.go))

### LM Studio

- Tools work on `/v1/chat/completions` and `/v1/responses`. "Native" support needs both a tool-aware chat template and LM Studio support for that model's call format. Otherwise LM Studio gives "Default" support (a custom system prompt and format), and "Results will vary by model". ([Tool use](https://lmstudio.ai/docs/developer/openai-compat/tools))
- Streaming: "Function names and arguments are sent in pieces via `chunk.choices[0].delta.tool_calls…`. These chunks must be accumulated". ([Tool use › Streaming](https://lmstudio.ai/docs/developer/openai-compat/tools))
- Failure mode: when LM Studio can't parse a call, the text goes into `message.content` instead of `tool_calls`. "Smaller models and models that were not trained for tool use may output improperly formatted tool calls." ([Tool use](https://lmstudio.ai/docs/developer/openai-compat/tools))
- `tool_choice` is not documented. The chat-completions "Supported payload parameters" list doesn't name it. ([Chat completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions))
- Structured output uses `response_format: {type:"json_schema"}`. Enforcement is grammar-based: llama.cpp for GGUF, Outlines for MLX. "Not all models are capable of structured output, particularly LLMs below 7B parameters." ([Structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output))
- **Metadata:** `GET /api/v1/models` returns `capabilities.trained_for_tool_use: boolean` (and `vision`). ([REST › List models](https://lmstudio.ai/docs/developer/rest/list))

## Wire formats: three families

Gantry's Node proxy needs one adapter per family, all normalised to a single internal `QuestionCardCall { id, input }` event.

| | Anthropic Messages | OpenAI Chat Completions (OpenAI, OpenRouter, Ollama `/v1`, LM Studio, custom) | OpenAI Responses (OpenAI GPT-6+, optionally OpenRouter) |
|---|---|---|---|
| Tool def | `{name, description, input_schema, strict}` | `{type:"function", function:{name, description, parameters, strict}}` | `{type:"function", name, description, parameters, strict}` |
| Call in reply | content block `tool_use {id, name, input: object}` | `message.tool_calls[] {id, function:{name, arguments: string}}` | output item `function_call {call_id, name, arguments: string}` |
| Stop signal | `stop_reason: "tool_use"` | `finish_reason: "tool_calls"` | `response.completed` with function_call items |
| Stream | `content_block_start` → `input_json_delta.partial_json`… → `content_block_stop` | `delta.tool_calls[{index, id?, function:{name?, arguments}}]`, concatenated by `index` | `response.function_call_arguments.delta` … `.done` |
| Answer goes back as | `user` message with `tool_result {tool_use_id, content}` | `{role:"tool", tool_call_id, content}` | input item `function_call_output {call_id, output}` |

The card tool is a *client tool whose "execution" is the architect answering*. Gantry stops the turn, renders the card, and sends the architect's choice back as the tool result. That is how AskUserQuestion itself works, and it gives the decisions log a natural record: question (tool input), answer (tool result), cited source (a field in the input).

## Recommended design

1. **One tool, `ask_architect`, using a portable schema subset:** objects with `additionalProperties: false`, every property `required` (nullable where optional), and no array bounds or string-length keywords. That subset passes Anthropic strict, OpenAI strict and the local runtimes. Suggested shape: `questions[]` → `{question, header, multiSelect, options[] → {label, description}, recommended (label), why (one line), source {document, locator}}`. **"Other" is a UI affordance, not a model option.** Gantry always adds the free-text answer, as AskUserQuestion does.
2. **Validate in Gantry, not just in the provider:** 1–4 questions, 2–4 options, `recommended` names an existing option, `source.document` names a real Source document. If validation fails, return the tool result with `is_error: true` (Anthropic) or an error message (others) so the model can correct itself once. The pattern comes from [Fine-grained tool streaming › Handling invalid JSON](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming#handling-invalid-json-in-tool-responses). After that, fall back.
3. **`tool_choice: "auto"` on every type, plus `strict: true` where supported** (Anthropic, OpenAI, and OpenRouter when `supported_parameters` includes `structured_outputs`). Also set `parallel_tool_calls: false` (OpenAI/OpenRouter) or `disable_parallel_tool_use` (Anthropic) so a turn yields at most one card. The system prompt tells the model to ask through the tool. Forcing buys little: it suppresses the model's lead-in text and its thinking, and it breaks on the newest Claude models.
4. **OpenRouter: send `provider: {require_parameters: true}`** whenever tools are sent, so they aren't silently dropped.
5. **Streaming UX:** stream text deltas live. On the first tool-call event (`content_block_start`/`tool_use`, the first `delta.tool_calls`, or `response.output_item.added`), show a "preparing questions…" placeholder. Render the card only once the call is complete and valid.
6. **Fallback ladder** (per AI Provider, chosen at Test connection, and downgraded at runtime if a tools request errors):
   - **native**: tool calling as above.
   - **fallback**: no `tools` sent. The system prompt asks for the same schema in a fenced ` ```gantry-questions ` JSON block, which Gantry parses with the same validator. On LM Studio and Ollama, Gantry *could* add `response_format`/`format` JSON-schema enforcement, but that forces the *whole* reply into JSON and loses free chat in that turn. Use it only for a dedicated "ask" turn, if at all.
   - **chat-only**: if nothing parses, show the text as a chat message. The architect still answers in free text, the interview continues, and the decisions log records the question as free text with no options.
   - **Don't refuse the model.** Weak local models still give a usable (if clunkier) interview. Show the mode in AI Provider settings ("Question cards: native / text fallback") so the architect knows why a session feels different.

## Detecting the capability at "Test connection"

Iris's Test sends one `"Say 'ok'"` chat and reports latency (`iris/backend/app/ai/client.py`, `test_connection`). Gantry extends that to two steps:

1. **Metadata hint (free, explains the result).**
   - Anthropic: `GET /v1/models/{id}` → `capabilities.structured_outputs`. Tool calling is universal.
   - OpenRouter: `GET /api/v1/models` → the model's `supported_parameters` ∋ `tools` (and `structured_outputs`).
   - Ollama: `POST /api/show {model}` → `capabilities` ∋ `"tools"`. This is the native endpoint, so the base URL minus `/v1`.
   - LM Studio: `GET /api/v1/models` → `capabilities.trained_for_tool_use`. This is the native REST path, not `/v1`.
   - OpenAI and custom: no metadata. Skip this step.
2. **Probe call (authoritative).** One streamed request with the real `ask_architect` tool, `tool_choice: auto`, and the prompt "Ask me one question with two options using the tool". Pass means a complete, validator-passing tool call arrived through the streaming adapter. This exercises the exact path the interview uses, including fragment accumulation. Cost is one small call. A 400 that mentions tools, a text-only reply, or an invalid call means `fallback`. Store the result per AI Provider (it lives in the browser alongside the key).

A metadata "no" can skip the probe and go straight to fallback. A metadata "yes" still runs the probe: LM Studio "Default" support and OpenRouter provider routing both mean metadata can be optimistic.

## Open decision for the map

**Which API should the OpenAI type speak?** OpenAI's tool calling on GPT-6 Astra / GPT-6.1 Sol needs the Responses API ([Function calling](https://developers.openai.com/api/docs/guides/function-calling)). Options:

- (a) The OpenAI type uses **Responses**, and everything else uses Chat Completions. That means three adapters, but OpenAI's newest models get native cards.
- (b) Everything OpenAI-shaped uses **Chat Completions**, as Iris does. That means two adapters, and GPT-6+ falls back to text cards.

Recommendation: (a). The Responses adapter is small, and OpenRouter accepts the Responses shape too, so it isn't OpenAI-only code.

## Not verified

- Whether Anthropic `GET /v1/models` returns `capabilities` under `anthropic-version: 2023-06-01`. The reference example uses `2026-10-21`.
- How Ollama's `/v1` endpoint streams tool calls (whole or fragmented). The native endpoint sends them whole. The Chat Completions adapter handles both.
- How reliable "Default" tool use is on LM Studio models without the hammer badge. That is an empirical question for the probe, not something the docs can answer.
