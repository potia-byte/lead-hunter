import { z } from "zod";
import type { SellableAction } from "./types.js";

/**
 * Everything that describes WHAT is being sold and WHO counts as a lead lives
 * here, not in code or prompts. Swap the profile to hunt for leads of another
 * product; the pipeline, verification and scoring are unchanged.
 */

export const SELLABLE_ACTIONS = [
  "channel_subscribe",
  "bot_start",
  "mini_app_launch",
  "registration",
  "first_action",
  "community_join",
  "app_install",
  "first_purchase",
] as const satisfies readonly SellableAction[];

export interface ActionOffer {
  /** Human label used in reports, e.g. "Mini App launches". */
  label: string;
  /** One sentence the seller can paste as a first offer. */
  offer: string;
}

export interface ProductProfile {
  /** Product name used in prompts and reports. */
  name: string;
  /** What the product is and what the seller offers a lead; goes into prompts. */
  description: string;
  /** Which kinds of business count as a good lead (prompt text). */
  goodLeadCriteria: string;
  /** Which entities must be rejected outright (prompt text). */
  rejectCriteria: string;
  /** Short description used to ask a model for more discovery queries. */
  queryPlanningContext: string;
  seedEntityQueries: string[];
  seedPostQueries: string[];
  /** Label and first-offer text per sellable action. */
  actions: Record<SellableAction, ActionOffer>;
  /** First match wins when a business could be sold several actions. */
  actionPriority: SellableAction[];
}

const offerSchema = z.object({
  label: z.string().min(1),
  offer: z.string().min(1),
});

export const productProfileSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  goodLeadCriteria: z.string().min(1),
  rejectCriteria: z.string().min(1),
  queryPlanningContext: z.string().min(1),
  seedEntityQueries: z.array(z.string().min(2).max(40)).min(1),
  seedPostQueries: z.array(z.string().min(2).max(40)).min(1),
  actions: z.object(
    Object.fromEntries(
      SELLABLE_ACTIONS.map((action) => [action, offerSchema]),
    ) as Record<SellableAction, typeof offerSchema>,
  ),
  actionPriority: z.array(z.enum(SELLABLE_ACTIONS)).min(1),
});

/** Parses and validates a profile loaded from JSON; throws with a readable message. */
export function parseProductProfile(value: unknown): ProductProfile {
  return productProfileSchema.parse(value);
}

/**
 * A fictional product used by tests and the demo. Nothing here is a real
 * company: replace it with your own profile (see config/product.example.json).
 */
export const DEFAULT_PROFILE: ProductProfile = {
  name: "Acme Rewards",
  description:
    "Acme Rewards is a Telegram Mini App where users complete tasks (subscribe to a channel, start a bot, open a Mini App, register, make a first action or purchase) and advertisers pay per verified action.",
  goodLeadCriteria:
    "A good lead is a business or product that could pay for such actions: Mini Apps, bots, games, apps, web services, crypto/fintech products, exchanges, e-commerce, education, and also channels or communities that visibly promote themselves.",
  rejectCriteria:
    'Reject only: personal blogs without a product, ad sellers/agencies/"buy ads here" catalogs, outright fraud (phishing, wallet drainers, pyramid schemes), pornography, drugs, pure news aggregators with no product, dead or empty pages.',
  queryPlanningContext:
    "businesses that could buy user actions (channel subscriptions, bot starts, Mini App launches, registrations, first purchases) from a rewards Mini App",
  seedEntityQueries: [
    "mini app",
    "miniapp",
    "tap game",
    "telegram game",
    "игра бот",
    "crypto wallet",
    "криптокошелек",
    "обменник",
    "p2p exchange",
    "airdrop",
    "vpn bot",
    "vpn",
    "курсы",
    "онлайн школа",
    "english school",
    "магазин",
    "shop bot",
    "маркетплейс",
    "доставка",
    "fintech",
    "кэшбэк",
    "cashback",
    "подписки",
    "нейросеть бот",
    "ai bot",
    "gpt bot",
    "знакомства бот",
    "фитнес",
    "финансы",
    "инвестиции",
    "trading bot",
    "casual game",
    "nft",
    "web3",
    "стартап",
    "saas",
    "сервис",
    "приложение",
    "мини приложение",
    "referral",
  ],
  seedPostQueries: [
    "erid",
    "реклама erid",
    "запустили mini app",
    "наш мини апп",
    "реферальная программа",
    "пригласи друга",
    "розыгрыш подписка",
    "giveaway",
    "airdrop tasks",
    "по вопросам рекламы",
    "сотрудничество",
    "partnership",
  ],
  actions: {
    mini_app_launch: {
      label: "Mini App launches",
      offer: "Free test batch of ~30-50 Mini App launches, then a paid pilot per confirmed launch.",
    },
    bot_start: {
      label: "bot starts",
      offer: "Free test batch of ~30-50 bot starts, then a paid pilot per confirmed start.",
    },
    registration: {
      label: "registrations",
      offer: "Free test batch of ~30-50 registrations, then a paid pilot per confirmed registration.",
    },
    app_install: {
      label: "installs with registration",
      offer: "Free test batch of ~30-50 installs with registration, then a paid pilot per confirmed install.",
    },
    first_action: {
      label: "first actions",
      offer: "Free test batch of ~30-50 first actions, then a paid pilot per confirmed action.",
    },
    channel_subscribe: {
      label: "channel subscriptions",
      offer: "Free test batch of ~30-50 channel subscriptions, then a paid pilot per confirmed subscription.",
    },
    community_join: {
      label: "community joins",
      offer: "Free test batch of ~30-50 community joins, then a paid pilot per confirmed join.",
    },
    first_purchase: {
      label: "first purchases",
      offer: "Free test batch of ~10 first purchases, then a paid pilot per confirmed purchase.",
    },
  },
  actionPriority: [
    "mini_app_launch",
    "bot_start",
    "registration",
    "first_action",
    "app_install",
    "channel_subscribe",
    "community_join",
    "first_purchase",
  ],
};
