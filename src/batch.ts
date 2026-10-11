import { normalizeEvidenceUrl } from "./canonical.js";
import { profileUrl } from "./classify.js";
import {
  type ActionOffer,
  DEFAULT_PROFILE,
  type ProductProfile,
} from "./config.js";
import { type LeadRecord, leadRecordSchema } from "./lead-record.js";
import { allContacts, explainScore } from "./score.js";
import { clip, daysAgo } from "./text.js";
import type {
  AdSighting,
  Classification,
  Enrichment,
  RawEntity,
  Score,
  SellableAction,
  StrongReview,
} from "./types.js";

/**
 * Turns a scored business into an evidence-first lead record. Every fact cites
 * one of the lead's sources; a record that fails validation is not emitted.
 * What is being sold (labels, offers, action priority) comes from the product
 * profile.
 */

export const RESEARCH_SOURCE = "telegram_ai_research";

export function primaryAction(
  classification: Classification,
  members: RawEntity[],
  profile: ProductProfile = DEFAULT_PROFILE,
): SellableAction {
  const actions = new Set(classification.sellableActions);
  if (members.some((member) => member.hasMainApp))
    actions.add("mini_app_launch");
  else if (members.some((member) => member.kind === "bot"))
    actions.add("bot_start");
  if (actions.size === 0) actions.add("channel_subscribe");
  return (
    profile.actionPriority.find((action) => actions.has(action)) ??
    "channel_subscribe"
  );
}

function offerOf(action: SellableAction, profile: ProductProfile): ActionOffer {
  return profile.actions[action];
}

export function firstOffer(
  action: SellableAction,
  profile: ProductProfile = DEFAULT_PROFILE,
): string {
  return offerOf(action, profile).offer;
}

export interface BusinessView {
  key: string;
  members: RawEntity[];
  primary: RawEntity;
  classification: Classification;
  sightings: AdSighting[];
  enrichment: Enrichment | null;
  score: Score;
  review: StrongReview | null;
  finalScore: number;
  mergeReasons: string[];
}

class Sources {
  private readonly urls = new Map<string, { url: string; label: string }>();
  constructor(private readonly retrievedAt: string) {}

  add(url: string, label: string): string | null {
    let key: string;
    try {
      key = normalizeEvidenceUrl(url);
    } catch {
      return null;
    }
    if (!this.urls.has(key)) {
      if (this.urls.size >= 20) return null;
      this.urls.set(key, { url, label: clip(label, 200) });
    }
    return this.urls.get(key)?.url ?? null;
  }

  list() {
    return [...this.urls.values()].map((source) => ({
      ...source,
      retrievedAt: this.retrievedAt,
    }));
  }
}

export function buildResearchLead(
  view: BusinessView,
  context: {
    runId: string;
    models: string[];
    now: Date;
    sourceQueries: string[];
    profile?: ProductProfile;
  },
): { lead: LeadRecord | null; errors: string[] } {
  const { classification: c, primary, members } = view;
  const retrievedAt = primary.fetchedAt;
  const sources = new Sources(retrievedAt);
  const profile = sources.add(
    profileUrl(primary),
    `Telegram profile @${primary.username}`,
  ) as string;
  for (const member of members)
    if (member !== primary)
      sources.add(profileUrl(member), `Telegram profile @${member.username}`);

  const profileCfg = context.profile ?? DEFAULT_PROFILE;
  const facts: LeadRecord["verifiedFacts"] = [];
  const keyUses = new Map<string, number>();
  const fact = (
    key: string,
    value: string,
    url: string | null,
    confidence: number,
  ) => {
    if (facts.length >= 26 || !value.trim()) return;
    const cited = url ? sources.add(url, key) : null;
    // The CRM keeps one fact per (lead, key); a repeat keeps its own source
    // under a numbered key instead of being merged into the first.
    const uses = (keyUses.get(key) ?? 0) + 1;
    keyUses.set(key, uses);
    facts.push({
      key: uses === 1 ? key : `${key}_${uses}`,
      value: clip(value, 1000),
      sourceUrl: cited ?? profile,
      confidence,
    });
  };

  const action = primaryAction(c, members, profileCfg);
  const offer = firstOffer(action, profileCfg);
  const handles = members.map(
    (member) => `@${member.username} (${member.kind})`,
  );

  fact("research_source", RESEARCH_SOURCE, profile, 100);
  fact("fit_score", String(view.finalScore), profile, 100);
  fact("score_breakdown", explainScore(view.score), profile, 100);
  fact(
    "entity_type",
    `${c.projectType}; ${members.map((member) => member.kind).join(", ")}`,
    profile,
    90,
  );
  fact("telegram_entities", handles.join(", "), profile, 100);
  fact("description", c.whatItDoes, profile, 70);
  fact("suggested_action", action, profile, 70);
  fact("suggested_first_offer", offer, profile, 70);
  for (const sighting of view.sightings.slice(0, 4))
    fact(
      "evidence_of_ad_spend",
      `Paid placement (${sighting.marker}) on @${sighting.hostUsername}, ${new Date(sighting.date * 1000).toISOString().slice(0, 10)}: «${sighting.excerpt}»`,
      sighting.postUrl,
      95,
    );
  for (const item of c.adSpendEvidence.slice(0, 2))
    fact(
      "evidence_of_ad_spend",
      `${item.claim}: «${item.quote}»`,
      item.sourceUrl,
      85,
    );
  for (const item of c.acquisitionEvidence.slice(0, 3))
    fact(
      "evidence_of_growth",
      `${item.claim}: «${item.quote}»`,
      item.sourceUrl,
      85,
    );
  for (const item of c.monetizationEvidence.slice(0, 2))
    fact(
      "evidence_of_monetization",
      `${item.claim}: «${item.quote}»`,
      item.sourceUrl,
      85,
    );

  const latestPost = members
    .flatMap((member) => member.posts.map((post) => ({ member, post })))
    .sort((left, right) => right.post.date - left.post.date)[0];
  if (latestPost)
    fact(
      "recent_activity",
      `Last post ${Math.round(daysAgo(latestPost.post.date, context.now))} day(s) ago (${new Date(latestPost.post.date * 1000).toISOString().slice(0, 10)})`,
      `https://t.me/${latestPost.member.username}/${latestPost.post.id}`,
      100,
    );
  const botUsers = members.find((member) => member.botActiveUsers);
  if (botUsers)
    fact(
      "bot_monthly_users",
      String(botUsers.botActiveUsers),
      profileUrl(botUsers),
      90,
    );
  if (view.enrichment?.adPageUrl)
    fact(
      "advertising_page",
      view.enrichment.adPageUrl,
      view.enrichment.adPageUrl,
      80,
    );
  if (view.review)
    fact(
      "strong_review",
      `${view.review.verdict} (${view.review.adjustment >= 0 ? "+" : ""}${view.review.adjustment}) by ${view.review.model}: ${view.review.reason}`,
      profile,
      80,
    );
  if (view.mergeReasons.length > 0)
    fact("merged_entities", view.mergeReasons.join("; "), profile, 90);
  fact(
    "source_query",
    context.sourceQueries.join(" | ") || "unknown",
    profile,
    100,
  );
  fact(
    "source_type",
    [
      ...new Set(
        members.flatMap((member) =>
          member.discoveries.map((item) => item.sourceType),
        ),
      ),
    ].join(", "),
    profile,
    100,
  );
  fact(
    "discovered_at",
    members
      .flatMap((member) => member.discoveries.map((item) => item.at))
      .sort()[0] ?? retrievedAt,
    profile,
    100,
  );
  fact("last_checked_at", retrievedAt, profile, 100);
  fact("models_used", context.models.join(", "), profile, 100);
  fact(
    "research_status",
    `run ${context.runId}; ${c.droppedClaims} unverifiable model claim(s) dropped`,
    profile,
    100,
  );

  const contacts: LeadRecord["publicContacts"] = [];
  const seen = new Set<string>();
  for (const contact of allContacts(view)) {
    const key = contact.value.toLowerCase();
    if (seen.has(key) || contacts.length >= 10) continue;
    const cited = sources.add(contact.sourceUrl, `contact ${contact.value}`);
    if (!cited) continue;
    seen.add(key);
    contacts.push(
      contact.kind === "email"
        ? {
            kind: "email",
            value: contact.value,
            sourceUrl: cited,
            contactName: `${contact.role} contact`,
          }
        : {
            kind: "telegram",
            value: contact.value,
            sourceUrl: cited,
            contactName: `${contact.role} contact`,
          },
    );
  }
  const website = c.website ? sources.add(c.website, "official website") : null;
  const primaryAudience = members.find((member) => member.participants);

  const whyUrl =
    view.sightings[0]?.postUrl ??
    c.adSpendEvidence[0]?.sourceUrl ??
    c.acquisitionEvidence[0]?.sourceUrl ??
    profile;
  const needUrl =
    c.acquisitionEvidence[0]?.sourceUrl ??
    view.sightings[0]?.postUrl ??
    profile;
  const verifiedCount =
    view.sightings.length +
    c.adSpendEvidence.length +
    c.acquisitionEvidence.length +
    c.monetizationEvidence.length;

  const candidate = {
    type: "advertiser",
    project: c.businessName,
    segment: c.niche,
    website: website ?? "",
    telegramUrl: profile,
    publicContacts: contacts,
    sources: sources.list(),
    verifiedFacts: facts,
    audienceDescription: primaryAudience
      ? {
          value: `Publicly visible: ${primaryAudience.participants} subscribers on @${primaryAudience.username}`,
          sourceUrl:
            sources.add(profileUrl(primaryAudience), "audience") ?? profile,
          confidence: 90,
        }
      : {
          value: "unknown: Telegram does not show the audience size",
          sourceUrl: profile,
          confidence: 10,
        },
    likelyAcquisitionNeed: {
      value: c.acquisitionEvidence[0]
        ? `${c.acquisitionEvidence[0].claim}: «${c.acquisitionEvidence[0].quote}»`
        : view.sightings[0]
          ? `Already buys advertising on Telegram (@${view.sightings[0].hostUsername})`
          : "unknown: no explicit growth signals found",
      sourceUrl: sources.add(needUrl, "acquisition evidence") ?? profile,
      confidence: c.acquisitionEvidence[0] || view.sightings[0] ? 80 : 20,
    },
    whyProductFits: {
      value: clip(
        `Score ${view.finalScore}/100. Sellable: ${offerOf(action, profileCfg).label}. ${view.score.factors
          .filter((item) => item.points > 0)
          .map((item) => item.reason)
          .join("; ")}`,
        1000,
      ),
      sourceUrl: sources.add(whyUrl, "fit evidence") ?? profile,
      confidence: Math.min(95, 50 + 5 * Math.min(8, verifiedCount)),
    },
    confidence: Math.min(95, 50 + 5 * Math.min(8, verifiedCount)),
    language: c.language.length >= 2 ? c.language : "ru",
    country: "",
    estimatedSize: primaryAudience
      ? `${primaryAudience.participants} subscribers`
      : "",
    notes: clip(
      [
        `[${RESEARCH_SOURCE}] Score ${view.finalScore}/100 (${c.projectType}, ${c.niche}).`,
        c.whatItDoes,
        `Offer: ${offer}`,
        view.review
          ? `Strong-model review: ${view.review.verdict}: ${view.review.reason}`
          : "",
        `Breakdown: ${explainScore(view.score)}`,
      ]
        .filter(Boolean)
        .join("\n"),
      1500,
    ),
  };
  const parsed = leadRecordSchema.safeParse(candidate);
  if (!parsed.success)
    return {
      lead: null,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    };
  return { lead: parsed.data, errors: [] };
}
