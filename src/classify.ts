import { z } from "zod";
import { DEFAULT_PROFILE, SELLABLE_ACTIONS, type ProductProfile } from "./config.js";
import { completeJson, type LlmClient, type UsageLedger } from "./llm.js";
import {
  businessDomainOf,
  clip,
  containsQuote,
  extractEmails,
  extractHandles,
  telegramTargetOf,
} from "./text.js";
import type {
  Classification,
  ContactFinding,
  Evidence,
  SellableAction,
  ProjectType,
  RawEntity,
} from "./types.js";

/**
 * Cheap-model reading of raw entities, then a deterministic verifier.
 *
 * The model never writes a link, handle or email itself: it picks references
 * (L1, H2, E1) from lists the code extracted from the public text. Every
 * claim must carry a quote, and a quote that is not literally present in the
 * cited text is dropped. What survives is safe to put in the CRM.
 */

export const PROJECT_TYPES = [
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
  "media_channel",
  "community",
  "ad_seller_or_agency",
  "personal_blog",
  "other",
] as const satisfies readonly ProjectType[];

export const ACTIONS = SELLABLE_ACTIONS;

const CONTACT_ROLES = [
  "advertising",
  "partnership",
  "support",
  "owner",
  "general",
] as const;

const claimSchema = z.object({
  claim: z.string().catch(""),
  source: z.string().catch(""),
  quote: z.string().catch(""),
});

const resultSchema = z.object({
  id: z.coerce.string(),
  is_business: z.boolean().catch(false),
  reject_reason: z.string().nullable().catch(null),
  business_name: z.string().catch(""),
  project_type: z.enum(PROJECT_TYPES).catch("other"),
  niche: z.string().catch("unknown"),
  what_it_does: z.string().catch(""),
  language: z.string().catch("unknown"),
  sellable_actions: z
    .array(z.string())
    .catch([])
    .transform((values) =>
      values.filter((value): value is SellableAction =>
        (ACTIONS as readonly string[]).includes(value),
      ),
    ),
  website_link: z.string().nullable().catch(null),
  contacts: z
    .array(
      z.object({
        ref: z.string(),
        role: z.enum(CONTACT_ROLES).catch("general"),
      }),
    )
    .catch([]),
  ad_spend: z.array(claimSchema).catch([]),
  acquisition: z.array(claimSchema).catch([]),
  monetization: z.array(claimSchema).catch([]),
});

export const classificationReplySchema = z.object({
  results: z.array(resultSchema).min(1),
});

type ClassificationResult = z.infer<typeof resultSchema>;

const MAX_POSTS = 8;
const POST_CHARS = 350;

/** Numbered references the model may cite, all extracted by code. */
export interface EntityRefs {
  links: Map<string, string>;
  handles: Map<string, string>;
  emails: Map<string, string>;
  /** "about" and "P<id>" mapped to their text and public URL. */
  texts: Map<string, { text: string; url: string }>;
}

export function profileUrl(entity: RawEntity): string {
  return `https://t.me/${entity.username}`;
}

export function postUrl(entity: RawEntity, postId: number): string {
  return `https://t.me/${entity.username}/${postId}`;
}

export function referencesOf(entity: RawEntity): EntityRefs {
  const posts = entity.posts.slice(0, MAX_POSTS);
  const texts = new Map<string, { text: string; url: string }>();
  texts.set("about", {
    text: `${entity.title}\n${entity.about}`,
    url: profileUrl(entity),
  });
  for (const post of posts)
    texts.set(`P${post.id}`, {
      text: post.text,
      url: postUrl(entity, post.id),
    });

  const own = entity.username.toLowerCase();
  const allText = [entity.about, ...posts.map((post) => post.text)].join("\n");
  const links = new Map<string, string>();
  const linkValues = new Set([
    ...entity.aboutLinks,
    ...posts.flatMap((post) => post.links),
  ]);
  let index = 1;
  for (const link of linkValues) {
    if (index > 25) break;
    links.set(`L${index}`, link);
    index += 1;
  }
  const handles = new Map<string, string>();
  extractHandles(allText)
    .filter((handle) => handle !== own)
    .slice(0, 15)
    .forEach((handle, position) => {
      handles.set(`H${position + 1}`, handle);
    });
  const emails = new Map<string, string>();
  extractEmails(allText)
    .slice(0, 5)
    .forEach((email, position) => {
      emails.set(`E${position + 1}`, email);
    });
  return { links, handles, emails, texts };
}

function describe(entity: RawEntity, refs: EntityRefs): string {
  const lines = [
    `### id=${entity.id} kind=${entity.kind} @${entity.username}`,
    `title: ${entity.title}`,
    `subscribers: ${entity.participants ?? "unknown"}${
      entity.botActiveUsers ? `; monthly users: ${entity.botActiveUsers}` : ""
    }${entity.hasMainApp ? "; has Mini App" : ""}`,
    `about: ${clip(entity.about.replace(/\s+/g, " "), 600) || "(empty)"}`,
  ];
  if (refs.links.size > 0)
    lines.push(
      `links: ${[...refs.links].map(([ref, url]) => `${ref}=${clip(url, 120)}`).join(" ")}`,
    );
  if (refs.handles.size > 0)
    lines.push(
      `handles: ${[...refs.handles].map(([ref, handle]) => `${ref}=@${handle}`).join(" ")}`,
    );
  if (refs.emails.size > 0)
    lines.push(
      `emails: ${[...refs.emails].map(([ref, email]) => `${ref}=${email}`).join(" ")}`,
    );
  for (const post of entity.posts.slice(0, MAX_POSTS)) {
    const date = new Date(post.date * 1000).toISOString().slice(0, 10);
    lines.push(
      `P${post.id} (${date}): ${clip(post.text.replace(/\s+/g, " "), POST_CHARS)}`,
    );
  }
  return lines.join("\n");
}

export function classificationPrompt(
  entities: RawEntity[],
  profile: ProductProfile = DEFAULT_PROFILE,
): string {
  const blocks = entities.map((entity) =>
    describe(entity, referencesOf(entity)),
  );
  return `You qualify potential ADVERTISERS for ${profile.name}. ${profile.description}

${profile.goodLeadCriteria} ${profile.rejectCriteria}

Rules — they are checked by code and violations are discarded:
- Use ONLY the text below. Never invent audience, budgets, owners, contacts or websites.
- website_link must be one of the L# references (the product's own site), or null.
- contacts must be H#/E# references (or an L# t.me link to a person/bot) with their role; own @username is not a contact.
- Every item in ad_spend / acquisition / monetization needs "source" ("about" or a post id like "P123") and a "quote" copied EXACTLY (5-120 chars) from that source.
- ad_spend: evidence the project pays for promotion (ad placements, "реклама", sponsored giveaways, paid collaborations, cross-promo, influencer deals).
- acquisition: evidence it needs users (launch, beta, "invite friends", referral program, growth pushes, giveaways, airdrops, contests).
- monetization: evidence of revenue (paid plans, shop, prices, fees, premium, commission).
- If unknown, use null or [].

Reply with JSON only:
{"results":[{"id":"<id>","is_business":true,"reject_reason":null,"business_name":"","project_type":"${PROJECT_TYPES.join("|")}","niche":"short niche","what_it_does":"one sentence from the text","language":"ru|en|...","sellable_actions":["${ACTIONS.join('","')}"],"website_link":"L1 or null","contacts":[{"ref":"H1","role":"${CONTACT_ROLES.join("|")}"}],"ad_spend":[{"claim":"","source":"P123","quote":""}],"acquisition":[],"monetization":[]}]}
Return one result per entity, in order.

${blocks.join("\n\n")}`;
}

function verifyClaims(
  claims: ClassificationResult["ad_spend"],
  refs: EntityRefs,
): { kept: Evidence[]; dropped: number } {
  const kept: Evidence[] = [];
  let dropped = 0;
  for (const claim of claims) {
    const source = refs.texts.get(claim.source.trim().replace(/^post\s*/i, ""));
    if (!source || !claim.quote || !containsQuote(source.text, claim.quote)) {
      dropped += 1;
      continue;
    }
    kept.push({
      claim: clip(claim.claim.trim() || "see quote", 200),
      quote: clip(claim.quote.trim(), 200),
      sourceUrl: source.url,
    });
  }
  return { kept, dropped };
}

/** Keeps only what the public text proves; everything else becomes null/[]. */
export function verifyClassification(
  entity: RawEntity,
  result: ClassificationResult,
  model: string,
): Classification {
  const refs = referencesOf(entity);
  const ad = verifyClaims(result.ad_spend, refs);
  const acquisition = verifyClaims(result.acquisition, refs);
  const monetization = verifyClaims(result.monetization, refs);
  let dropped = ad.dropped + acquisition.dropped + monetization.dropped;

  let website: string | null = null;
  if (result.website_link) {
    const link = refs.links.get(result.website_link.trim());
    if (link && businessDomainOf(link)) website = link;
    else dropped += 1;
  }

  const contacts: ContactFinding[] = [];
  for (const contact of result.contacts) {
    const ref = contact.ref.trim();
    const link = refs.links.get(ref);
    const handle =
      refs.handles.get(ref) ?? (link ? telegramTargetOf(link) : undefined);
    const email = refs.emails.get(ref);
    if ((!handle && !email) || handle === entity.username.toLowerCase()) {
      dropped += 1;
      continue;
    }
    // Contacts are cited from the profile when they appear there, otherwise
    // from the first post that mentions them.
    const value = handle ? `@${handle}` : (email as string);
    const source =
      [...refs.texts.values()].find((text) =>
        text.text.toLowerCase().includes(value.replace(/^@/, "").toLowerCase()),
      ) ?? refs.texts.get("about");
    contacts.push({
      kind: handle ? "telegram" : "email",
      value,
      role: contact.role,
      sourceUrl: source?.url ?? profileUrl(entity),
    });
  }

  return {
    entityId: entity.id,
    isBusiness: result.is_business && !entity.scamOrFake,
    rejectReason: entity.scamOrFake
      ? "Telegram marks this entity as scam or fake"
      : result.is_business
        ? null
        : clip(result.reject_reason ?? "not a business", 200),
    businessName: clip(result.business_name.trim() || entity.title, 160),
    projectType: result.project_type,
    niche: clip(result.niche.trim() || "unknown", 100),
    whatItDoes: clip(result.what_it_does.trim(), 300),
    language: clip(result.language.trim() || "unknown", 12),
    sellableActions: [...new Set(result.sellable_actions)],
    website,
    contacts,
    adSpendEvidence: ad.kept,
    acquisitionEvidence: acquisition.kept,
    monetizationEvidence: monetization.kept,
    droppedClaims: dropped,
    model,
  };
}

/**
 * Classifies a batch in one cheap call. Entities the reply leaves out are
 * returned in `missing` so the caller can retry them individually.
 */
export async function classifyBatch(
  llm: LlmClient,
  ledger: UsageLedger,
  entities: RawEntity[],
  profile: ProductProfile = DEFAULT_PROFILE,
): Promise<{
  classified: Classification[];
  missing: RawEntity[];
  error: string | null;
}> {
  const reply = await completeJson(
    llm,
    ledger,
    {
      tier: "cheap",
      prompt: classificationPrompt(entities, profile),
      maxTokens: 900 * entities.length,
    },
    classificationReplySchema,
  );
  if (!reply.ok)
    return { classified: [], missing: entities, error: reply.reason };
  const byId = new Map(
    reply.value.results.map((result) => [result.id, result]),
  );
  const classified: Classification[] = [];
  const missing: RawEntity[] = [];
  for (const entity of entities) {
    const result = byId.get(entity.id);
    if (result)
      classified.push(verifyClassification(entity, result, reply.route));
    else missing.push(entity);
  }
  return { classified, missing, error: null };
}
