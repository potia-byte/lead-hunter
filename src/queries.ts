import { z } from "zod";
import { DEFAULT_PROFILE, type ProductProfile } from "./config.js";
import { completeJson, type LlmClient, type UsageLedger } from "./llm.js";

/**
 * Discovery queries. contacts.search matches channel/bot names and usernames,
 * so entity queries are short product words; channels.searchPosts matches
 * post text, so post queries are phrases a promoting project would write.
 */

const querySchema = z.object({
  entity_queries: z.array(z.string()).catch([]),
  post_queries: z.array(z.string()).catch([]),
});

function clean(values: string[], known: Set<string>, limit: number): string[] {
  const out: string[] = [];
  for (const value of values) {
    const query = value.trim().replace(/\s+/g, " ").toLowerCase();
    if (query.length < 2 || query.length > 40 || known.has(query)) continue;
    known.add(query);
    out.push(query);
    if (out.length >= limit) break;
  }
  return out;
}

/** Seed queries plus model-generated ones that are not already in the plan. */
export async function planQueries(
  llm: LlmClient | null,
  ledger: UsageLedger,
  extra: { entity: number; post: number },
  exclude: readonly string[] = [],
  profile: ProductProfile = DEFAULT_PROFILE,
): Promise<{ entity: string[]; post: string[]; generatedBy: string | null }> {
  const known = new Set(exclude.map((query) => query.toLowerCase()));
  const entity = clean(profile.seedEntityQueries, known, 1000);
  const post = clean(profile.seedPostQueries, known, 1000);
  if (!llm || (extra.entity <= 0 && extra.post <= 0))
    return { entity, post, generatedBy: null };

  const reply = await completeJson(
    llm,
    ledger,
    {
      tier: "cheap",
      maxTokens: 1500,
      prompt: `We search public Telegram for ${profile.queryPlanningContext}.

Give ${extra.entity} short search queries (1-3 words, Russian and English mixed) for Telegram's channel/bot NAME search: product categories, app types, niches likely to spend on user acquisition (games, Mini Apps, fintech, crypto, education, e-commerce, services, AI tools, VPN, delivery, dating, health, travel, etc.).
Give ${extra.post} short phrases (2-5 words) that such projects write in PUBLIC POSTS when promoting or growing (launch announcements, referral programs, giveaways, "open the app", partnerships).
Avoid these, already used: ${[...known].slice(0, 80).join(", ")}.
Reply with JSON only: {"entity_queries":["..."],"post_queries":["..."]}`,
    },
    querySchema,
  );
  if (!reply.ok) return { entity, post, generatedBy: null };
  return {
    entity: [
      ...entity,
      ...clean(reply.value.entity_queries, known, extra.entity),
    ],
    post: [...post, ...clean(reply.value.post_queries, known, extra.post)],
    generatedBy: reply.route,
  };
}
