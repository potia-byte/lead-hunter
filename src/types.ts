/**
 * Shared shapes for the Lead Hunter pipeline.
 *
 * Everything here is either copied verbatim from a public Telegram or web
 * page, or derived from such a copy by deterministic code. LLM output never
 * lands in these records unverified: classify.ts checks every quote, link and
 * contact against the text it claims to come from before keeping it.
 */

export type EntityKind = "channel" | "group" | "bot";

export type SourceType =
  | "entity_search"
  | "post_search"
  | "ad_post_target"
  | "profile_link"
  | "snowball";

export interface PublicPost {
  id: number;
  /** Unix seconds. */
  date: number;
  text: string;
  views: number | null;
  forwards: number | null;
  /** Every URL in the post: plain text, hidden text links and URL buttons. */
  links: string[];
}

export interface Discovery {
  sourceType: SourceType;
  /** The search query, or the post URL that led here. */
  source: string;
  at: string;
}

/** A public Telegram entity exactly as it was read. */
export interface RawEntity {
  /** Telegram peer id, stable across username changes. */
  id: string;
  kind: EntityKind;
  username: string;
  title: string;
  about: string;
  /** Subscriber count for channels and groups, when public. */
  participants: number | null;
  /** Monthly active users Telegram shows for Mini App bots. */
  botActiveUsers: number | null;
  hasMainApp: boolean;
  verified: boolean;
  scamOrFake: boolean;
  /** URLs from the profile description. */
  aboutLinks: string[];
  posts: PublicPost[];
  discoveries: Discovery[];
  fetchedAt: string;
}

/** An ad post found on some channel, pointing at a would-be advertiser. */
export interface AdSighting {
  /** Public URL of the ad post: https://t.me/<channel>/<id>. */
  postUrl: string;
  hostUsername: string;
  /** Why the post counts as an ad: "erid", "#реклама", ... */
  marker: string;
  date: number;
  /** Telegram handle or web domain the ad promotes. */
  target: string;
  excerpt: string;
  /** Legal advertiser from the ad-law line, when the post carries one. */
  advertiser?: string;
  inn?: string;
}

export type ProjectType =
  | "mini_app"
  | "bot"
  | "game"
  | "mobile_app"
  | "web_service"
  | "crypto_project"
  | "exchange_or_wallet"
  | "fintech"
  | "ecommerce"
  | "education"
  | "media_channel"
  | "community"
  | "ad_seller_or_agency"
  | "personal_blog"
  | "other";

export type SellableAction =
  | "channel_subscribe"
  | "bot_start"
  | "mini_app_launch"
  | "registration"
  | "first_action"
  | "community_join"
  | "app_install"
  | "first_purchase";

/** A claim tied to a verbatim quote from a specific public text. */
export interface Evidence {
  claim: string;
  quote: string;
  /** Public URL of the text the quote comes from. */
  sourceUrl: string;
}

export interface ContactFinding {
  kind: "telegram" | "email";
  value: string;
  role: "advertising" | "partnership" | "support" | "owner" | "general";
  sourceUrl: string;
}

/** Verified, LLM-assisted reading of one entity. */
export interface Classification {
  entityId: string;
  isBusiness: boolean;
  rejectReason: string | null;
  businessName: string;
  projectType: ProjectType;
  niche: string;
  whatItDoes: string;
  language: string;
  sellableActions: SellableAction[];
  website: string | null;
  contacts: ContactFinding[];
  adSpendEvidence: Evidence[];
  acquisitionEvidence: Evidence[];
  monetizationEvidence: Evidence[];
  /** Claims the verifier threw away because the quote was not in the text. */
  droppedClaims: number;
  model: string;
}

export interface WebPage {
  url: string;
  title: string;
  text: string;
  links: string[];
  emails: string[];
}

export interface Enrichment {
  website: string;
  pages: WebPage[];
  contacts: ContactFinding[];
  adPageUrl: string | null;
  error: string | null;
}

export interface ScoreFactor {
  key:
    | "product_fit"
    | "acquisition_need"
    | "ad_spend"
    | "activity"
    | "reachability"
    | "monetization"
    | "telegram_relevance";
  points: number;
  max: number;
  reason: string;
}

export interface Score {
  total: number;
  factors: ScoreFactor[];
}

export interface StrongReview {
  model: string;
  verdict: "confirm" | "adjust" | "reject";
  adjustment: number;
  reason: string;
}

/** One business, possibly spanning several Telegram entities and a site. */
export interface BusinessLead {
  key: string;
  entityIds: string[];
  primary: string;
  mergeReasons: string[];
}
