import { z } from "zod";
import { DEFAULT_PROFILE, type ProductProfile } from "./config.js";
import { completeJson, type LlmClient, type UsageLedger } from "./llm.js";
import { explainScore } from "./score.js";
import type {
  AdSighting,
  Classification,
  Score,
  StrongReview,
} from "./types.js";

/**
 * Second opinion from the strongest free model on the leads that made the
 * cut. It may lower a score freely but raise it only a little, and it sees
 * the same verified quotes the score was built from — nothing else.
 */

const reviewSchema = z.object({
  verdict: z.enum(["confirm", "adjust", "reject"]).catch("confirm"),
  adjustment: z.coerce.number().catch(0),
  reason: z.string().catch(""),
});

export function reviewPrompt(
  classification: Classification,
  score: Score,
  sightings: AdSighting[],
  handles: string[],
  profile: ProductProfile = DEFAULT_PROFILE,
): string {
  const quotes = [
    ...classification.adSpendEvidence.map(
      (item) => `ad_spend: "${item.quote}" (${item.sourceUrl})`,
    ),
    ...classification.acquisitionEvidence.map(
      (item) => `growth: "${item.quote}" (${item.sourceUrl})`,
    ),
    ...classification.monetizationEvidence.map(
      (item) => `revenue: "${item.quote}" (${item.sourceUrl})`,
    ),
    ...sightings
      .slice(0, 5)
      .map(
        (item) =>
          `advertised on @${item.hostUsername} [${item.marker}]: "${item.excerpt}" (${item.postUrl})`,
      ),
  ];
  return `You are the final reviewer of a sales lead for ${profile.name}. ${profile.description}

Lead: ${classification.businessName} (${handles.map((handle) => `@${handle}`).join(", ")})
Type: ${classification.projectType}; niche: ${classification.niche}
What it does: ${classification.whatItDoes || "unknown"}
Website: ${classification.website ?? "none"}
Sellable actions: ${classification.sellableActions.join(", ") || "none"}
Score ${score.total}/100: ${explainScore(score)}
Verified evidence (quotes are real):
${quotes.join("\n") || "(none)"}

Judge ONLY from this. Is it a real business that could plausibly pay for what ${profile.name} sells? ${profile.goodLeadCriteria} ${profile.rejectCriteria} Adjustment range -30..+10.
Reply with JSON only: {"verdict":"confirm|adjust|reject","adjustment":0,"reason":"one or two sentences"}`;
}

export async function reviewLead(
  llm: LlmClient,
  ledger: UsageLedger,
  classification: Classification,
  score: Score,
  sightings: AdSighting[],
  handles: string[],
  profile: ProductProfile = DEFAULT_PROFILE,
): Promise<StrongReview | null> {
  const reply = await completeJson(
    llm,
    ledger,
    {
      tier: "strong",
      maxTokens: 800,
      prompt: reviewPrompt(classification, score, sightings, handles, profile),
    },
    reviewSchema,
    2,
  );
  if (!reply.ok) return null;
  const adjustment = Math.max(
    -30,
    Math.min(10, Math.round(reply.value.adjustment)),
  );
  return {
    model: reply.route,
    verdict: reply.value.verdict,
    adjustment: reply.value.verdict === "confirm" ? 0 : adjustment,
    reason: reply.value.reason.slice(0, 400),
  };
}
