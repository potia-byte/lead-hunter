import { daysAgo } from "./text.js";
import type {
  AdSighting,
  Classification,
  ContactFinding,
  Enrichment,
  ProjectType,
  RawEntity,
  Score,
  ScoreFactor,
} from "./types.js";

/**
 * Explainable 0-100 fit score, computed by code from verified evidence only.
 * Audience size is deliberately a minor input: a small live Mini App with a
 * clear action to sell beats a huge news channel.
 */

export interface ScoreInput {
  members: RawEntity[];
  classification: Classification;
  sightings: AdSighting[];
  enrichment: Enrichment | null;
  now: Date;
}

const PRODUCT_TYPES: ReadonlySet<ProjectType> = new Set([
  "mini_app",
  "bot",
  "game",
  "mobile_app",
  "web_service",
  "crypto_project",
  "exchange_or_wallet",
  "fintech",
  "ecommerce",
  "education",
]);
const NOT_ADVERTISERS: ReadonlySet<ProjectType> = new Set([
  "ad_seller_or_agency",
  "personal_blog",
]);
const MONEY_TYPES: ReadonlySet<ProjectType> = new Set([
  "exchange_or_wallet",
  "fintech",
  "ecommerce",
  "game",
]);
const DEEP_ACTIONS = new Set([
  "bot_start",
  "mini_app_launch",
  "registration",
  "first_action",
  "app_install",
  "first_purchase",
]);

export const QUALIFY_THRESHOLD = 40;

function factor(
  key: ScoreFactor["key"],
  points: number,
  max: number,
  reason: string,
): ScoreFactor {
  return {
    key,
    points: Math.max(0, Math.min(max, Math.round(points))),
    max,
    reason,
  };
}

export function allContacts(
  input: Pick<ScoreInput, "classification" | "enrichment">,
): ContactFinding[] {
  return [
    ...input.classification.contacts,
    ...(input.enrichment?.contacts ?? []),
  ];
}

export function scoreLead(input: ScoreInput): Score {
  const { classification: c, members, sightings, now } = input;
  const factors: ScoreFactor[] = [];

  // A. Product fit
  let fit = PRODUCT_TYPES.has(c.projectType)
    ? 12
    : NOT_ADVERTISERS.has(c.projectType)
      ? 0
      : 7;
  if (c.sellableActions.length > 0) fit += 4;
  if (c.sellableActions.some((action) => DEEP_ACTIONS.has(action))) fit += 4;
  factors.push(
    factor(
      "product_fit",
      fit,
      20,
      `${c.projectType}; sellable: ${c.sellableActions.join(", ") || "none identified"}`,
    ),
  );

  // B. Acquisition need
  factors.push(
    factor(
      "acquisition_need",
      c.acquisitionEvidence.length * 5,
      15,
      c.acquisitionEvidence.length > 0
        ? `${c.acquisitionEvidence.length} quoted growth/referral signal(s)`
        : "no quoted growth signal",
    ),
  );

  // C. Evidence of spending
  const hosts = new Set(sightings.map((sighting) => sighting.hostUsername));
  const sightingPoints =
    hosts.size >= 3 ? 20 : hosts.size === 2 ? 16 : hosts.size === 1 ? 12 : 0;
  const ownPoints = Math.min(8, c.adSpendEvidence.length * 4);
  factors.push(
    factor(
      "ad_spend",
      sightingPoints + ownPoints,
      20,
      [
        hosts.size > 0 ? `advertised on ${hosts.size} other channel(s)` : "",
        c.adSpendEvidence.length > 0
          ? `${c.adSpendEvidence.length} own post(s) about paid promo`
          : "",
      ]
        .filter(Boolean)
        .join("; ") || "no evidence of paid promotion",
    ),
  );

  // D. Activity
  const lastPost = Math.max(
    0,
    ...members.flatMap((member) => member.posts.map((post) => post.date)),
  );
  const lastSighting = Math.max(
    0,
    ...sightings.map((sighting) => sighting.date),
  );
  const latest = Math.max(lastPost, lastSighting);
  const botUsers = Math.max(
    0,
    ...members.map((member) => member.botActiveUsers ?? 0),
  );
  let activity: number;
  let activityReason: string;
  if (latest > 0) {
    const age = daysAgo(latest, now);
    activity =
      age <= 3 ? 15 : age <= 14 ? 11 : age <= 45 ? 6 : age <= 120 ? 2 : 0;
    activityReason = `last public activity ${Math.round(age)} day(s) ago`;
  } else if (botUsers > 0) {
    activity = 10;
    activityReason = `${botUsers} monthly bot users shown by Telegram`;
  } else {
    activity = members.some((member) => member.hasMainApp) ? 6 : 3;
    activityReason = "no dated activity visible";
  }
  factors.push(factor("activity", activity, 15, activityReason));

  // E. Reachability
  const contacts = allContacts(input);
  const business = contacts.some(
    (contact) =>
      contact.role === "advertising" || contact.role === "partnership",
  );
  factors.push(
    factor(
      "reachability",
      business ? 10 : contacts.length > 0 ? 6 : c.website ? 3 : 0,
      10,
      business
        ? "public advertising/partnership contact"
        : contacts.length > 0
          ? "public contact, role unspecified"
          : c.website
            ? "website only"
            : "no public contact",
    ),
  );

  // F. Monetization
  const money =
    c.monetizationEvidence.length * 5 +
    (MONEY_TYPES.has(c.projectType) ? 3 : 0);
  factors.push(
    factor(
      "monetization",
      money,
      10,
      c.monetizationEvidence.length > 0
        ? `${c.monetizationEvidence.length} quoted revenue signal(s)`
        : MONEY_TYPES.has(c.projectType)
          ? "business type implies revenue"
          : "no visible monetization",
    ),
  );

  // G. Telegram relevance
  const hasApp = members.some((member) => member.hasMainApp);
  const hasBot = members.some((member) => member.kind === "bot");
  const bigChannel = members.some(
    (member) => member.kind === "channel" && (member.participants ?? 0) >= 1000,
  );
  const hasChannel = members.some((member) => member.kind === "channel");
  factors.push(
    factor(
      "telegram_relevance",
      hasApp ? 10 : hasBot ? 8 : bigChannel ? 6 : hasChannel ? 4 : 3,
      10,
      hasApp
        ? "runs a Telegram Mini App"
        : hasBot
          ? "runs a Telegram bot"
          : hasChannel
            ? "Telegram channel"
            : "Telegram group",
    ),
  );

  return {
    total: factors.reduce((sum, item) => sum + item.points, 0),
    factors,
  };
}

export function isQualified(
  classification: Classification,
  score: Score,
): boolean {
  return (
    classification.isBusiness &&
    !NOT_ADVERTISERS.has(classification.projectType) &&
    score.total >= QUALIFY_THRESHOLD
  );
}

export function explainScore(score: Score): string {
  return score.factors
    .map((item) => `${item.key} ${item.points}/${item.max} (${item.reason})`)
    .join("; ");
}
