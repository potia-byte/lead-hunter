import {
  type LlmClient,
  type LlmCompletion,
  LlmUnavailableError,
  type LlmOptions,
} from "../llm.js";

/**
 * LlmClient over any OpenAI-compatible `/chat/completions` endpoint.
 *
 * Provided so a live run needs no model-pool package. NOT VERIFIED against a
 * live provider in this repository: the unit test uses a stubbed fetch.
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  /** Model used for tier "cheap". */
  cheapModel: string;
  /** Model used for tier "strong"; defaults to the cheap one. */
  strongModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatReply {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenAiCompatibleClient(
  options: OpenAiCompatibleOptions,
): LlmClient {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    async completion(
      prompt: string,
      request: LlmOptions,
    ): Promise<LlmCompletion> {
      const model =
        request.tier === "strong"
          ? (options.strongModel ?? options.cheapModel)
          : options.cheapModel;
      const route = `openai-compatible/${model}`;
      let response: Response;
      try {
        response = await doFetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxTokens,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
        });
      } catch (error) {
        throw new LlmUnavailableError(
          `request failed: ${(error as Error).message}`,
        );
      }
      if (!response.ok)
        throw new LlmUnavailableError(
          `HTTP ${response.status} from ${route}`,
          response.status === 402 || response.status === 429,
        );
      const body = (await response.json()) as ChatReply;
      const text = body.choices?.[0]?.message?.content;
      if (!text) throw new LlmUnavailableError(`empty reply from ${route}`);
      return {
        text,
        route,
        usage: body.usage
          ? {
              inputTokens: body.usage.prompt_tokens ?? 0,
              outputTokens: body.usage.completion_tokens ?? 0,
            }
          : null,
      };
    },
  };
}
