import type { FixtureWorld, ReplayReplies } from "../src/adapters/fixture.js";
import { DEFAULT_PROFILE, type ProductProfile } from "../src/config.js";
import type { PublicPost, RawEntity } from "../src/types.js";

/**
 * A fully synthetic Telegram "world" for the demo and the tests. Every name,
 * handle, domain and email below is invented; nothing was read from Telegram.
 * Ages are in days relative to DEMO_NOW so the data never goes stale.
 */

export const DEMO_NOW = new Date("2026-10-01T12:00:00Z");
const DAY = 86_400;
const nowSeconds = Math.floor(DEMO_NOW.getTime() / 1000);

function post(
  id: number,
  ageDays: number,
  text: string,
  links: string[] = [],
): PublicPost {
  return {
    id,
    date: nowSeconds - Math.round(ageDays * DAY),
    text,
    views: 1000 + id,
    forwards: null,
    links,
  };
}

function entity(partial: Partial<RawEntity> & Pick<RawEntity, "id" | "username" | "title">): RawEntity {
  return {
    kind: "channel",
    about: "",
    participants: 2000,
    botActiveUsers: null,
    hasMainApp: false,
    verified: false,
    scamOrFake: false,
    aboutLinks: [],
    posts: [],
    discoveries: [],
    fetchedAt: DEMO_NOW.toISOString(),
    ...partial,
  };
}

const novaChannel = entity({
  id: "1001",
  username: "novabudget_demo",
  title: "Nova Budget",
  participants: 5200,
  about:
    "Nova Budget: a Mini App for personal budgeting. Advertising: @novabudget_ads. https://novabudget-demo.app",
  aboutLinks: ["https://novabudget-demo.app"],
  posts: [
    post(
      11,
      1,
      "We launched the referral program: invite a friend and get Premium free for a month.",
    ),
    post(
      10,
      6,
      "Premium plan costs 299 RUB per month. Open the app and try it.",
      ["https://t.me/novabudget_demo_bot"],
    ),
  ],
});

const novaBot = entity({
  id: "1002",
  kind: "bot",
  username: "novabudget_demo_bot",
  title: "Nova Budget",
  participants: null,
  botActiveUsers: 18000,
  hasMainApp: true,
  about: "Open Nova Budget. News: t.me/novabudget_demo",
  aboutLinks: ["https://t.me/novabudget_demo"],
});

const dealsHost = entity({
  id: "1004",
  username: "daily_deals_demo",
  title: "Daily Deals Digest",
  participants: 52_000,
  about: "Best deals every day. Advertising: @dailydeals_ads",
  posts: [
    post(
      40,
      2,
      "Ad. erid: 2VtzqDEMO001\nPlay @tapzilla_demo_bot and earn tokens every day!",
      ["https://t.me/tapzilla_demo_bot?start=ad1"],
    ),
    post(
      41,
      5,
      "#advertising erid: 2VtzqDEMO002\nGet fit with @fitpulse_demo",
      ["https://t.me/fitpulse_demo"],
    ),
    post(42, 1, "Today's top deals: three discounts you should not miss."),
  ],
});

const megaphoneHost = entity({
  id: "1011",
  username: "megaphone_demo",
  title: "Megaphone Media",
  participants: 30_000,
  about: "Ads in our network: write @megaphone_sales",
  posts: [
    post(
      60,
      3,
      "Ad. Advertiser: Nova Budget LLC. erid: 2VtzqDEMO003\nTake control of your money: @novabudget_demo",
      ["https://t.me/novabudget_demo"],
    ),
  ],
});

const personalBlog = entity({
  id: "1006",
  username: "mashas_notes_demo",
  title: "Masha's Notes",
  participants: 900,
  about: "Thoughts about life and travel.",
  posts: [post(70, 4, "Back from a trip to the mountains. Photos below.")],
});

const tinyShop = entity({
  id: "1007",
  username: "tiny_shop_demo",
  title: "Tiny Shop",
  participants: 120,
  about: "A very small shop.",
  posts: [post(80, 2, "New goods arrived.")],
});

const scamChannel = entity({
  id: "1008",
  username: "quick_money_demo",
  title: "Quick Money",
  participants: 8000,
  about: "Double your deposit in a day!",
  scamOrFake: true,
  posts: [post(90, 1, "Send us money, get double back.")],
});

const staleNews = entity({
  id: "1009",
  username: "stale_news_demo",
  title: "Stale News",
  participants: 20_000,
  about: "News from the region.",
  posts: [post(100, 300, "An old headline.")],
});

const school = entity({
  id: "1010",
  username: "learnhub_demo",
  title: "LearnHub Online School",
  participants: 7600,
  about:
    "Online school of English and programming. Partnership: partners@learnhub-demo.org",
  posts: [
    post(
      110,
      2,
      "Enrolment is open: a trial lesson is free, a full course costs 4900 RUB.",
    ),
    post(
      111,
      9,
      "Giveaway! Subscribe to the channel and win a month of lessons.",
    ),
  ],
});

const tapzillaPosts = [
  post(
    120,
    1,
    "Season 3 of the tap game starts. Invite friends for a bonus airdrop!",
  ),
];

const fitpulsePosts = [
  post(
    130,
    2,
    "FitPulse Studio: subscription from 990 RUB per month for all workouts.",
  ),
];

/** Same product, small query seed list matching the fixture world. */
export const demoProfile: ProductProfile = {
  ...DEFAULT_PROFILE,
  seedEntityQueries: ["mini app", "deals", "ad network", "online school", "notes"],
  seedPostQueries: ["erid"],
};

export const demoWorld: FixtureWorld = {
  entities: [
    novaChannel,
    novaBot,
    dealsHost,
    megaphoneHost,
    personalBlog,
    tinyShop,
    scamChannel,
    staleNews,
    school,
  ],
  entitySearch: {
    "mini app": ["1001", "1002"],
    deals: ["1004", "1007"],
    "ad network": ["1011"],
    "online school": ["1010"],
    notes: ["1006", "1008", "1009"],
  },
  postSearch: {
    erid: [{ hostId: "1011", post: megaphoneHost.posts[0] as PublicPost }],
  },
  webProfiles: {
    tapzilla_demo_bot: {
      username: "tapzilla_demo_bot",
      kind: "bot",
      title: "Tapzilla",
      about: "Tap to earn tokens. Season 3 is live.",
      participants: null,
    },
    fitpulse_demo: {
      username: "fitpulse_demo",
      kind: "channel",
      title: "FitPulse Studio",
      about: "Workouts and nutrition. Subscription: https://fitpulse-demo.fit",
      participants: 1800,
    },
  },
  webPosts: {
    novabudget_demo: novaChannel.posts,
    daily_deals_demo: dealsHost.posts,
    megaphone_demo: megaphoneHost.posts,
    learnhub_demo: school.posts,
    fitpulse_demo: fitpulsePosts,
    tapzilla_demo_bot: tapzillaPosts,
  },
  sites: {
    "https://novabudget-demo.app":
      '<title>Nova Budget</title><a href="/advertising">Advertising</a><a href="https://t.me/novabudget_demo">Telegram</a>',
    "https://novabudget-demo.app/advertising":
      '<p>Write to <a href="mailto:ads@novabudget-demo.app">ads@novabudget-demo.app</a></p>',
    "https://fitpulse-demo.fit":
      '<title>FitPulse</title><p>Partnerships: partner@fitpulse-demo.fit</p>',
  },
};

/** What a model would plausibly answer; quotes are copied from the texts above. */
export const demoReplies: ReplayReplies = {
  classification: {
    "1001": {
      is_business: true,
      business_name: "Nova Budget",
      project_type: "mini_app",
      niche: "personal finance",
      what_it_does: "Budgeting Mini App with a paid Premium plan.",
      language: "en",
      sellable_actions: ["mini_app_launch", "registration"],
      website_link: "L1",
      contacts: [{ ref: "H1", role: "advertising" }],
      ad_spend: [],
      acquisition: [
        {
          claim: "referral program",
          source: "P11",
          quote: "invite a friend and get Premium free for a month",
        },
      ],
      monetization: [
        {
          claim: "paid plan",
          source: "P10",
          quote: "Premium plan costs 299 RUB per month",
        },
      ],
    },
    "1002": {
      is_business: true,
      business_name: "Nova Budget",
      project_type: "mini_app",
      niche: "personal finance",
      what_it_does: "The Mini App of Nova Budget.",
      language: "en",
      sellable_actions: ["mini_app_launch"],
      website_link: null,
      contacts: [],
      ad_spend: [],
      acquisition: [],
      monetization: [],
    },
    "1004": {
      is_business: false,
      reject_reason: "ad seller / deals aggregator",
      project_type: "ad_seller_or_agency",
      business_name: "Daily Deals Digest",
      niche: "media",
    },
    "1006": {
      is_business: false,
      reject_reason: "personal blog without a product",
      project_type: "personal_blog",
      business_name: "Masha's Notes",
      niche: "personal",
    },
    "1011": {
      is_business: false,
      reject_reason: "ad seller network",
      project_type: "ad_seller_or_agency",
      business_name: "Megaphone Media",
      niche: "media",
    },
    "1010": {
      is_business: true,
      business_name: "LearnHub Online School",
      project_type: "education",
      niche: "online education",
      what_it_does: "Online courses of English and programming.",
      language: "en",
      sellable_actions: ["channel_subscribe", "registration"],
      website_link: null,
      contacts: [{ ref: "E1", role: "partnership" }],
      ad_spend: [],
      acquisition: [
        {
          claim: "giveaway for subscribers",
          source: "P111",
          quote: "Subscribe to the channel and win a month of lessons",
        },
      ],
      monetization: [
        {
          claim: "paid course",
          source: "P110",
          quote: "a full course costs 4900 RUB",
        },
      ],
    },
    "web:tapzilla_demo_bot": {
      is_business: true,
      business_name: "Tapzilla",
      project_type: "game",
      niche: "tap-to-earn game",
      what_it_does: "Tap game with token rewards.",
      language: "en",
      sellable_actions: ["bot_start", "mini_app_launch"],
      website_link: null,
      contacts: [],
      ad_spend: [],
      acquisition: [],
      monetization: [],
    },
    "web:fitpulse_demo": {
      is_business: true,
      business_name: "FitPulse Studio",
      project_type: "web_service",
      niche: "fitness subscription",
      what_it_does: "Workout subscription service.",
      language: "en",
      sellable_actions: ["registration", "first_purchase"],
      website_link: "L1",
      contacts: [],
      ad_spend: [],
      acquisition: [],
      // Deliberately invented: the verifier must drop it (see droppedClaims).
      monetization: [
        {
          claim: "claims 1M paying users",
          source: "about",
          quote: "one million paying members worldwide",
        },
      ],
    },
  },
  review: {
    "Nova Budget": {
      verdict: "confirm",
      adjustment: 0,
      reason: "Real product with visible growth and revenue signals.",
    },
  },
};
