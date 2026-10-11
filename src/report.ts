import type { BusinessView } from "./batch.js";
import { firstOffer, primaryAction } from "./batch.js";
import { DEFAULT_PROFILE, type ProductProfile } from "./config.js";
import type { RunResult, RunState } from "./pipeline.js";
import { allContacts } from "./score.js";

/** Funnel numbers and the TOP list, as JSON for tooling and Markdown for people. */

export interface Funnel {
  entityQueries: number;
  postQueries: number;
  rawCandidates: number;
  fetched: number;
  fetchFailed: number;
  adSightings: number;
  adTargetsResolved: number;
  prefilterRejected: number;
  classified: number;
  classifyFailed: number;
  notBusiness: number;
  businesses: number;
  entitiesMerged: number;
  qualified: number;
  leadsBuilt: number;
  leadErrors: number;
}

export function funnelOf(state: RunState, result: RunResult): Funnel {
  const done = Object.values(state.queriesDone);
  const classified = Object.values(state.classifications);
  return {
    entityQueries: done.filter((item) => item.kind === "entity").length,
    postQueries: done.filter((item) => item.kind === "post").length,
    rawCandidates: Object.keys(state.stubs).length,
    fetched: Object.keys(state.entities).length,
    fetchFailed: Object.keys(state.fetchFailed).length,
    adSightings: state.sightings.length,
    adTargetsResolved: Object.values(state.resolved).filter(Boolean).length,
    prefilterRejected: Object.keys(state.prefilterRejected).length,
    classified: classified.length,
    classifyFailed: Object.keys(state.classifyFailed).length,
    notBusiness: classified.filter((item) => !item.isBusiness).length,
    businesses: result.businesses.length,
    entitiesMerged: result.businesses.reduce(
      (sum, view) => sum + view.members.length - 1,
      0,
    ),
    qualified: result.qualified.length,
    leadsBuilt: result.leads.length,
    leadErrors: result.leadErrors.length,
  };
}

export function topEntry(
  view: BusinessView,
  profile: ProductProfile = DEFAULT_PROFILE,
) {
  const action = primaryAction(view.classification, view.members, profile);
  return {
    business: view.classification.businessName,
    telegram: view.members.map(
      (member) => `@${member.username} (${member.kind})`,
    ),
    website: view.classification.website,
    whatItDoes: view.classification.whatItDoes,
    niche: view.classification.niche,
    score: view.finalScore,
    baseScore: view.score.total,
    factors: view.score.factors,
    action,
    firstOffer: firstOffer(action, profile),
    contacts: allContacts(view).map(
      (contact) => `${contact.value} [${contact.role}] ← ${contact.sourceUrl}`,
    ),
    adSpend: [
      ...view.sightings
        .slice(0, 4)
        .map(
          (item) =>
            `ad on @${item.hostUsername} (${item.marker}) ${item.postUrl}`,
        ),
      ...view.classification.adSpendEvidence.map(
        (item) => `«${item.quote}» ${item.sourceUrl}`,
      ),
    ],
    acquisition: view.classification.acquisitionEvidence.map(
      (item) => `«${item.quote}» ${item.sourceUrl}`,
    ),
    monetization: view.classification.monetizationEvidence.map(
      (item) => `«${item.quote}» ${item.sourceUrl}`,
    ),
    review: view.review,
  };
}

export function markdownReport(
  state: RunState,
  result: RunResult,
  top: number,
  profile: ProductProfile = DEFAULT_PROFILE,
): string {
  const funnel = funnelOf(state, result);
  const usage = result.ledger.toJSON();
  const lines = [
    `# Lead Hunter run ${state.runId}`,
    "",
    "## Funnel",
    ...Object.entries(funnel).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Usage",
    `- Telegram requests: ${JSON.stringify(usage.telegramRequests)}`,
    `- Web requests: ${usage.webRequests}; browser sessions: ${usage.browserSessions}`,
    ...usage.llm.map(
      (line) =>
        `- ${line.route}: ${line.calls} calls (${line.failures} failed), ${line.inputTokens} in / ${line.outputTokens} out tokens`,
    ),
    "",
    "## Stops",
    ...(state.stops.length > 0
      ? state.stops.map((stop) => `- ${stop}`)
      : ["- none"]),
    "",
    `## TOP ${top}`,
  ];
  result.qualified.slice(0, top).forEach((view, index) => {
    const entry = topEntry(view, profile);
    lines.push(
      "",
      `### ${index + 1}. ${entry.business} — ${entry.score}/100`,
      `- Telegram: ${entry.telegram.join(", ")}`,
      `- Website: ${entry.website ?? "—"}`,
      `- What: ${entry.whatItDoes || "—"} (${entry.niche})`,
      `- Action to sell: ${entry.action}`,
      `- First offer: ${entry.firstOffer}`,
      `- Contacts: ${entry.contacts.join("; ") || "—"}`,
      `- Ad spend: ${entry.adSpend.join("; ") || "—"}`,
      `- Growth: ${entry.acquisition.join("; ") || "—"}`,
      `- Revenue: ${entry.monetization.join("; ") || "—"}`,
      `- Score: ${entry.factors.map((item) => `${item.key} ${item.points}/${item.max}`).join(", ")}`,
      `- Review: ${entry.review ? `${entry.review.verdict} ${entry.review.adjustment} — ${entry.review.reason} (${entry.review.model})` : "—"}`,
    );
  });
  return `${lines.join("\n")}\n`;
}
