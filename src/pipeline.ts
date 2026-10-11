import { adSightingsIn, isDomainTarget } from "./ads.js";
import { type BusinessView, buildResearchLead } from "./batch.js";
import { classifyBatch } from "./classify.js";
import { DEFAULT_PROFILE, type ProductProfile } from "./config.js";
import { groupBusinesses } from "./dedupe.js";
import { enrichWebsite, type FetchPage } from "./enrich.js";
import type { LeadRecord } from "./lead-record.js";
import type { LlmClient, UsageLedger } from "./llm.js";
import { planQueries } from "./queries.js";
import { reviewLead } from "./review.js";
import { isQualified, scoreLead } from "./score.js";
import {
  DiscoveryStoppedError,
  type EntityStub,
  type TelegramDiscovery,
} from "./source.js";
import {
  businessDomainOf,
  daysAgo,
  extractHandles,
  extractUrls,
  telegramTargetOf,
} from "./text.js";
import type {
  AdSighting,
  Classification,
  Discovery,
  Enrichment,
  PublicPost,
  RawEntity,
  StrongReview,
} from "./types.js";
import type { WebPreview, WebProfile } from "./webpreview.js";

/**
 * The Lead Hunter run: discover → fetch → mine ads → prefilter → classify →
 * dedupe → enrich → score → review → batch. Every stage is resumable: the
 * state is saved after each unit of work, and a rerun skips what is done.
 */

export interface Limits {
  llmEntityQueries: number;
  llmPostQueries: number;
  maxEntityQueries: number;
  maxPostQueries: number;
  maxFetch: number;
  maxResolve: number;
  postsPerEntity: number;
  minChannelSubscribers: number;
  classifyBatchSize: number;
  /** Batches in flight at once; the model pool spreads them over providers. */
  classifyConcurrency: number;
  maxClassify: number;
  maxEnrich: number;
  enrichMinScore: number;
  pagesPerSite: number;
  reviewTop: number;
  /** Channels whose recent posts are read on t.me/s/ to find ads. */
  maxWebChannels: number;
  /** 20 posts per page. */
  webPagesPerChannel: number;
  /** Advertiser handles looked up on t.me/<name> instead of the account. */
  maxWebResolve: number;
  /** Rounds of following channels that scanned channels mention or forward. */
  snowballDepth: number;
  /** Mentioned handles looked up on t.me/<name> per run. */
  maxSnowballProfiles: number;
}

export const DEFAULT_LIMITS: Limits = {
  llmEntityQueries: 40,
  llmPostQueries: 10,
  maxEntityQueries: 120,
  maxPostQueries: 20,
  maxFetch: 900,
  maxResolve: 150,
  postsPerEntity: 15,
  minChannelSubscribers: 300,
  classifyBatchSize: 4,
  classifyConcurrency: 4,
  maxClassify: 700,
  maxEnrich: 60,
  enrichMinScore: 30,
  pagesPerSite: 4,
  reviewTop: 30,
  maxWebChannels: 300,
  webPagesPerChannel: 3,
  maxWebResolve: 400,
  snowballDepth: 2,
  maxSnowballProfiles: 600,
};

export interface StubRecord extends EntityStub {
  discoveries: Discovery[];
}

export interface RunState {
  runId: string;
  createdAt: string;
  queries: {
    entity: string[];
    post: string[];
    generatedBy: string | null;
  } | null;
  queriesDone: Record<
    string,
    { kind: "entity" | "post"; found: number; note?: string }
  >;
  stubs: Record<string, StubRecord>;
  entities: Record<string, RawEntity>;
  fetchFailed: Record<string, string>;
  sightings: AdSighting[];
  resolved: Record<string, string | null>;
  prefilterRejected: Record<string, string>;
  classifications: Record<string, Classification>;
  classifyFailed: Record<string, string>;
  enrichments: Record<string, Enrichment>;
  reviews: Record<string, StrongReview | null>;
  ledger: unknown;
  stops: string[];
  /** Channels already read through the web preview, with the post count. */
  webScanned: Record<string, number>;
  /** Profiles of "web:<username>" stubs, found without the Telegram account. */
  webProfiles: Record<string, WebProfile>;
  /** How often scanned channels mention or forward each handle. */
  webMentions: Record<string, number>;
  snowballLooked: number;
}

export function emptyState(runId: string, now: Date): RunState {
  return {
    runId,
    createdAt: now.toISOString(),
    queries: null,
    queriesDone: {},
    stubs: {},
    entities: {},
    fetchFailed: {},
    sightings: [],
    resolved: {},
    prefilterRejected: {},
    classifications: {},
    classifyFailed: {},
    enrichments: {},
    reviews: {},
    ledger: {},
    stops: [],
    webScanned: {},
    webProfiles: {},
    webMentions: {},
    snowballLooked: 0,
  };
}

export interface PipelineDeps {
  state: RunState;
  save: (state: RunState) => Promise<void>;
  discovery: TelegramDiscovery | null;
  llm: LlmClient;
  /** Shared with the discovery layer so Telegram requests are counted too. */
  ledger: UsageLedger;
  fetchPage: FetchPage;
  renderPage?: FetchPage;
  limits: Limits;
  now: () => Date;
  log: (line: string) => void;
  /** Telegram ids fetched by earlier runs; refetching them only burns limits. */
  alreadyFetched?: ReadonlySet<string>;
  /** t.me web preview: ad scanning and handle lookups without the account. */
  webPreview?: WebPreview;
  /** What is being sold and who counts as a lead; defaults to a fictional product. */
  profile?: ProductProfile;
}

export interface RunResult {
  businesses: BusinessView[];
  qualified: BusinessView[];
  leads: LeadRecord[];
  leadErrors: Array<{ key: string; errors: string[] }>;
  ledger: UsageLedger;
}

function addStub(
  state: RunState,
  stub: EntityStub,
  discovery: Discovery,
): void {
  const existing = state.stubs[stub.id];
  if (existing) {
    if (!existing.discoveries.some((item) => item.source === discovery.source))
      existing.discoveries.push(discovery);
    return;
  }
  state.stubs[stub.id] = { ...stub, discoveries: [discovery] };
}

function addSightings(state: RunState, sightings: AdSighting[]): void {
  const seen = new Set(
    state.sightings.map((item) => `${item.postUrl}|${item.target}`),
  );
  for (const sighting of sightings) {
    const key = `${sighting.postUrl}|${sighting.target}`;
    if (!seen.has(key)) {
      seen.add(key);
      state.sightings.push(sighting);
    }
  }
}

/** Cheap deterministic filter so the model never sees obvious junk. */
export function prefilter(
  entity: RawEntity,
  limits: Limits,
  now: Date,
): string | null {
  if (entity.scamOrFake) return "marked scam/fake by Telegram";
  if (entity.kind === "group") return "group chat, not a business profile";
  if (!entity.about.trim() && entity.posts.every((post) => !post.text.trim()))
    return "empty profile";
  if (entity.kind === "channel") {
    if ((entity.participants ?? 0) < limits.minChannelSubscribers)
      return `fewer than ${limits.minChannelSubscribers} subscribers`;
    const latest = Math.max(0, ...entity.posts.map((post) => post.date));
    if (latest === 0 || daysAgo(latest, now) > 120)
      return "no posts in 120 days";
  }
  return null;
}

async function discover(
  deps: PipelineDeps,
  ledger: UsageLedger,
): Promise<void> {
  const { state, discovery, limits } = deps;
  if (!discovery || !state.queries) return;
  const at = deps.now().toISOString();

  let entityRuns = Object.values(state.queriesDone).filter(
    (item) => item.kind === "entity",
  ).length;
  for (const query of state.queries.entity) {
    if (entityRuns >= limits.maxEntityQueries) break;
    if (state.queriesDone[`entity:${query}`]) continue;
    const stubs = await discovery.searchEntities(query);
    for (const stub of stubs)
      addStub(state, stub, { sourceType: "entity_search", source: query, at });
    state.queriesDone[`entity:${query}`] = {
      kind: "entity",
      found: stubs.length,
    };
    entityRuns += 1;
    deps.log(`search "${query}": ${stubs.length} public entities`);
    await deps.save({ ...state, ledger: ledger.toJSON() });
  }

  let postRuns = Object.values(state.queriesDone).filter(
    (item) => item.kind === "post",
  ).length;
  for (const query of state.queries.post) {
    if (postRuns >= limits.maxPostQueries) break;
    if (state.queriesDone[`post:${query}`]) continue;
    const result = await discovery.searchPosts(query);
    if (!result.ok) {
      deps.log(`post search stopped: ${result.reason}`);
      state.stops.push(`post search: ${result.reason}`);
      break;
    }
    for (const { host, post } of result.posts) {
      addStub(state, host, {
        sourceType: "post_search",
        source: `https://t.me/${host.username}/${post.id}`,
        at,
      });
      addSightings(
        state,
        adSightingsIn({ username: host.username, posts: [post] }),
      );
    }
    state.queriesDone[`post:${query}`] = {
      kind: "post",
      found: result.posts.length,
    };
    postRuns += 1;
    deps.log(
      `post search "${query}": ${result.posts.length} posts, ${result.remainsToday} free searches left today`,
    );
    await deps.save({ ...state, ledger: ledger.toJSON() });
  }
}

function fetchPriority(stub: StubRecord): number {
  if (stub.discoveries.some((item) => item.sourceType === "ad_post_target"))
    return 0;
  if (stub.kind === "bot") return 1;
  if (stub.kind === "channel") return 2;
  return 3;
}

async function fetchEntities(
  deps: PipelineDeps,
  ledger: UsageLedger,
): Promise<void> {
  const { state, discovery, limits } = deps;
  const pending = Object.values(state.stubs)
    .filter((stub) => (isWebStub(stub) ? !!deps.webPreview : !!discovery))
    .filter((stub) => !state.entities[stub.id] && !state.fetchFailed[stub.id])
    .filter((stub) => !deps.alreadyFetched?.has(stub.id))
    .filter((stub) => stub.kind !== "group")
    .filter(
      (stub) =>
        stub.kind !== "channel" ||
        stub.participants === null ||
        stub.participants >= limits.minChannelSubscribers,
    )
    .sort(
      (left, right) =>
        fetchPriority(left) - fetchPriority(right) ||
        (right.participants ?? 0) - (left.participants ?? 0),
    );
  let fetched = Object.keys(state.entities).length;
  for (const stub of pending) {
    if (fetched >= limits.maxFetch) break;
    try {
      const entity =
        isWebStub(stub) || !discovery
          ? await webEntity(deps, stub)
          : await discovery.fetchEntity(stub, limits.postsPerEntity);
      entity.discoveries = stub.discoveries;
      state.entities[stub.id] = entity;
      addSightings(state, adSightingsIn(entity));
      fetched += 1;
    } catch (error) {
      if (error instanceof DiscoveryStoppedError) throw error;
      state.fetchFailed[stub.id] = (error as Error).message.slice(0, 200);
    }
    if (fetched % 10 === 0) {
      deps.log(
        `fetched ${fetched} entities, ${state.sightings.length} ad sightings so far`,
      );
      await deps.save({ ...state, ledger: ledger.toJSON() });
    }
  }
  await deps.save({ ...state, ledger: ledger.toJSON() });
}

const WEB_PREFIX = "web:";

/** A stub found through t.me/<name>: it has no Telegram peer id. */
function isWebStub(stub: EntityStub): boolean {
  return stub.id.startsWith(WEB_PREFIX);
}

async function webEntity(
  deps: PipelineDeps,
  stub: StubRecord,
): Promise<RawEntity> {
  const profile = deps.state.webProfiles[stub.id];
  if (!profile || !deps.webPreview)
    throw new Error("no web profile for this stub");
  const posts =
    profile.kind === "channel"
      ? await deps.webPreview.channelPosts(profile.username, 1)
      : [];
  return {
    id: stub.id,
    kind: profile.kind,
    username: profile.username,
    title: profile.title,
    about: profile.about,
    participants: profile.participants,
    botActiveUsers: null,
    hasMainApp: false,
    verified: false,
    scamOrFake: false,
    aboutLinks: extractUrls(profile.about),
    posts,
    discoveries: [],
    fetchedAt: deps.now().toISOString(),
  };
}

/**
 * Reads recent posts of known channels on t.me/s/ and records paid posts. Free
 * of account limits, and the Russian ad-law line names the legal advertiser.
 */
async function scanAdsOnWeb(
  deps: PipelineDeps,
  ledger: UsageLedger,
): Promise<void> {
  const { state, limits, webPreview } = deps;
  if (!webPreview) return;
  const channels = new Map<string, number>();
  for (const item of [
    ...Object.values(state.stubs),
    ...Object.values(state.entities),
  ])
    if (
      item.kind === "channel" &&
      (item.participants ?? 0) >= limits.minChannelSubscribers
    )
      channels.set(item.username, item.participants ?? 0);
  const queue = [...channels.entries()]
    .filter(([username]) => !(username in state.webScanned))
    .sort((left, right) => right[1] - left[1])
    .map(([username]) => username);
  let scanned = Object.keys(state.webScanned).length;
  const sightingsBefore = state.sightings.length;
  for (const username of queue) {
    if (scanned >= limits.maxWebChannels) break;
    const posts = await webPreview.channelPosts(
      username,
      limits.webPagesPerChannel,
    );
    state.webScanned[username] = posts.length;
    addSightings(state, adSightingsIn({ username, posts }));
    countMentions(state, username, posts);
    scanned += 1;
    if (scanned % 20 === 0) {
      deps.log(
        `web: read ${scanned} channels, ${state.sightings.length} ad sightings`,
      );
      await deps.save({ ...state, ledger: ledger.toJSON() });
    }
  }
  deps.log(
    `web: read ${scanned} channels, ${state.sightings.length - sightingsBefore} new ad sightings`,
  );
  await deps.save({ ...state, ledger: ledger.toJSON() });
}

function countMentions(
  state: RunState,
  host: string,
  posts: PublicPost[],
): void {
  const own = host.toLowerCase();
  for (const post of posts) {
    const handles = new Set<string>(extractHandles(post.text));
    for (const link of post.links) {
      const handle = telegramTargetOf(link);
      if (handle) handles.add(handle);
    }
    handles.delete(own);
    for (const handle of handles)
      state.webMentions[handle] = (state.webMentions[handle] ?? 0) + 1;
  }
}

/**
 * Snowball sampling: channels that scanned channels mention or forward are
 * looked up on t.me/<name>; the channels among them get scanned next round,
 * and bots become candidates. Most-mentioned first.
 */
async function snowball(
  deps: PipelineDeps,
  ledger: UsageLedger,
): Promise<number> {
  const { state, limits, webPreview } = deps;
  if (!webPreview) return 0;
  const known = new Set(
    Object.values(state.stubs).map((stub) => stub.username.toLowerCase()),
  );
  // Ad targets are left to resolveAdTargets, which records them as advertisers.
  for (const sighting of state.sightings) known.add(sighting.target);
  const queue = Object.entries(state.webMentions)
    .filter(([handle]) => !known.has(handle) && !(handle in state.resolved))
    .sort((left, right) => right[1] - left[1]);
  let added = 0;
  for (const [handle, mentions] of queue) {
    if (state.snowballLooked >= limits.maxSnowballProfiles) break;
    state.snowballLooked += 1;
    const profile = await webPreview.profile(handle);
    const useful =
      profile &&
      profile.kind !== "group" &&
      (profile.kind === "bot" ||
        (profile.participants ?? 0) >= limits.minChannelSubscribers);
    if (!profile || !useful) {
      state.resolved[handle] = null;
      continue;
    }
    const id = `${WEB_PREFIX}${profile.username.toLowerCase()}`;
    state.resolved[handle] = id;
    state.webProfiles[id] = profile;
    addStub(
      state,
      {
        id,
        kind: profile.kind,
        username: profile.username,
        title: profile.title,
        participants: profile.participants,
      },
      {
        sourceType: "snowball",
        source: `mentioned ${mentions}x by scanned channels`,
        at: deps.now().toISOString(),
      },
    );
    added += 1;
    if (state.snowballLooked % 20 === 0)
      await deps.save({ ...state, ledger: ledger.toJSON() });
  }
  deps.log(`snowball: ${added} new channel(s)/bot(s) from mentions`);
  await deps.save({ ...state, ledger: ledger.toJSON() });
  return added;
}

/** Resolves Telegram handles that other channels' ads point at. */
async function resolveAdTargets(
  deps: PipelineDeps,
  ledger: UsageLedger,
): Promise<number> {
  const { state, discovery, limits, webPreview } = deps;
  if (!discovery && !webPreview) return 0;
  const known = new Set(
    Object.values(state.stubs).map((stub) => stub.username.toLowerCase()),
  );
  const targets = [
    ...new Set(state.sightings.map((item) => item.target)),
  ].filter(
    (target) =>
      !isDomainTarget(target) &&
      !known.has(target) &&
      !(target in state.resolved),
  );
  let resolvedCount = Object.keys(state.resolved).length;
  let added = 0;
  const cap = webPreview ? limits.maxWebResolve : limits.maxResolve;
  for (const target of targets) {
    if (resolvedCount >= cap) break;
    let stub: EntityStub | null = null;
    if (webPreview) {
      // t.me/<name> answers without spending contacts.ResolveUsername.
      const profile = await webPreview.profile(target);
      if (profile) {
        stub = {
          id: `${WEB_PREFIX}${profile.username.toLowerCase()}`,
          kind: profile.kind,
          username: profile.username,
          title: profile.title,
          participants: profile.participants,
        };
        state.webProfiles[stub.id] = profile;
      }
    } else if (discovery) {
      stub = await discovery.resolve(target);
    }
    state.resolved[target] = stub?.id ?? null;
    resolvedCount += 1;
    if (stub) {
      const sighting = state.sightings.find((item) => item.target === target);
      addStub(state, stub, {
        sourceType: "ad_post_target",
        source: sighting?.postUrl ?? target,
        at: deps.now().toISOString(),
      });
      added += 1;
    }
    if (resolvedCount % 10 === 0)
      await deps.save({ ...state, ledger: ledger.toJSON() });
  }
  deps.log(`resolved ${added} advertiser handle(s) from ad posts`);
  await deps.save({ ...state, ledger: ledger.toJSON() });
  return added;
}

async function classifyAll(
  deps: PipelineDeps,
  ledger: UsageLedger,
): Promise<void> {
  const { state, limits } = deps;
  const now = deps.now();
  const pending: RawEntity[] = [];
  for (const entity of Object.values(state.entities)) {
    if (state.classifications[entity.id] || state.classifyFailed[entity.id])
      continue;
    const rejected = prefilter(entity, limits, now);
    if (rejected) {
      state.prefilterRejected[entity.id] = rejected;
      continue;
    }
    delete state.prefilterRejected[entity.id];
    pending.push(entity);
  }
  const budget = Math.max(
    0,
    limits.maxClassify - Object.keys(state.classifications).length,
  );
  const queue = pending.slice(0, budget);
  deps.log(
    `classifying ${queue.length} entities (${Object.keys(state.prefilterRejected).length} prefiltered out)`,
  );
  const batches: RawEntity[][] = [];
  for (let index = 0; index < queue.length; index += limits.classifyBatchSize)
    batches.push(queue.slice(index, index + limits.classifyBatchSize));
  let next = 0;
  let finished = 0;
  let exhausted = false;

  async function worker(): Promise<void> {
    while (!exhausted && next < batches.length) {
      const batch = batches[next] ?? [];
      next += 1;
      const result = await classifyBatch(deps.llm, ledger, batch, deps.profile);
      for (const item of result.classified)
        state.classifications[item.entityId] = item;
      // Leftovers get one solo attempt each before being marked failed.
      for (const entity of result.missing) {
        const solo =
          batch.length > 1
            ? await classifyBatch(deps.llm, ledger, [entity], deps.profile)
            : result;
        const item = solo.classified.find(
          (entry) => entry.entityId === entity.id,
        );
        if (item) state.classifications[entity.id] = item;
        else
          state.classifyFailed[entity.id] =
            solo.error ?? result.error ?? "no result";
      }
      if (result.error?.startsWith("exhausted")) {
        if (!exhausted) {
          exhausted = true;
          state.stops.push(`classification: ${result.error}`);
          deps.log(
            `models exhausted, stopping classification: ${result.error}`,
          );
        }
        await deps.save({ ...state, ledger: ledger.toJSON() });
        return;
      }
      await deps.save({ ...state, ledger: ledger.toJSON() });
      finished += 1;
      if (finished % 10 === 1)
        deps.log(`classified ${Object.keys(state.classifications).length}`);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, limits.classifyConcurrency) }, worker),
  );
}

function sightingsFor(
  state: RunState,
  members: RawEntity[],
  website: string | null,
  extraDomains: string[],
): AdSighting[] {
  const handles = new Set(
    members.map((member) => member.username.toLowerCase()),
  );
  const domains = new Set(extraDomains);
  const own = website ? businessDomainOf(website) : null;
  if (own) domains.add(own);
  return state.sightings.filter(
    (item) =>
      (handles.has(item.target) || domains.has(item.target)) &&
      !handles.has(item.hostUsername.toLowerCase()),
  );
}

export function buildBusinesses(state: RunState, now: Date): BusinessView[] {
  const inputs = Object.values(state.classifications)
    .filter((classification) => state.entities[classification.entityId])
    .map((classification) => ({
      entity: state.entities[classification.entityId] as RawEntity,
      classification,
      domains: [] as string[],
    }));
  const groups = groupBusinesses(inputs);
  return groups.map((group) => {
    const members = group.entityIds.map(
      (id) => state.entities[id] as RawEntity,
    );
    const primary = state.entities[group.primary] as RawEntity;
    const memberClassifications = group.entityIds
      .map((id) => state.classifications[id])
      .filter((item): item is Classification => Boolean(item));
    const base = state.classifications[group.primary] as Classification;
    const classification: Classification = {
      ...base,
      isBusiness: memberClassifications.some((item) => item.isBusiness),
      sellableActions: [
        ...new Set(
          memberClassifications.flatMap((item) => item.sellableActions),
        ),
      ],
      website:
        base.website ??
        memberClassifications.find((item) => item.website)?.website ??
        null,
      contacts: memberClassifications.flatMap((item) => item.contacts),
      adSpendEvidence: memberClassifications.flatMap(
        (item) => item.adSpendEvidence,
      ),
      acquisitionEvidence: memberClassifications.flatMap(
        (item) => item.acquisitionEvidence,
      ),
      monetizationEvidence: memberClassifications.flatMap(
        (item) => item.monetizationEvidence,
      ),
      droppedClaims: memberClassifications.reduce(
        (sum, item) => sum + item.droppedClaims,
        0,
      ),
    };
    const enrichment = state.enrichments[group.key] ?? null;
    const sightings = sightingsFor(state, members, classification.website, []);
    const score = scoreLead({
      members,
      classification,
      sightings,
      enrichment,
      now,
    });
    const review = state.reviews[group.key] ?? null;
    const finalScore = Math.max(
      0,
      Math.min(100, score.total + (review?.adjustment ?? 0)),
    );
    return {
      key: group.key,
      members,
      primary,
      classification,
      sightings,
      enrichment,
      score,
      review,
      finalScore,
      mergeReasons: group.mergeReasons,
    };
  });
}

export function qualifies(view: BusinessView): boolean {
  if (view.review?.verdict === "reject") return false;
  return isQualified(view.classification, {
    ...view.score,
    total: view.finalScore,
  });
}

export async function runPipeline(deps: PipelineDeps): Promise<RunResult> {
  const { state, limits } = deps;
  const profile = deps.profile ?? DEFAULT_PROFILE;
  const ledger = deps.ledger;
  const persist = () => deps.save({ ...state, ledger: ledger.toJSON() });

  if (!state.queries) {
    state.queries = await planQueries(
      deps.llm,
      ledger,
      {
        entity: limits.llmEntityQueries,
        post: limits.llmPostQueries,
      },
      [],
      profile,
    );
    deps.log(
      `planned ${state.queries.entity.length} entity and ${state.queries.post.length} post queries (generator: ${state.queries.generatedBy ?? "seeds only"})`,
    );
    await persist();
  }

  // Older states predate the web preview.
  state.webScanned ??= {};
  state.webProfiles ??= {};
  state.webMentions ??= {};
  state.snowballLooked ??= 0;
  const telegramStage = async (stage: () => Promise<void>) => {
    try {
      await stage();
    } catch (error) {
      if (!(error instanceof DiscoveryStoppedError)) throw error;
      state.stops.push(`telegram: ${error.message}`);
      deps.log(`Telegram discovery stopped: ${error.message}`);
      await persist();
    }
  };
  await telegramStage(async () => {
    await discover(deps, ledger);
    await fetchEntities(deps, ledger);
  });
  // The web stages need no account, so a Telegram stop does not end them.
  await scanAdsOnWeb(deps, ledger);
  for (let round = 0; round < limits.snowballDepth; round += 1) {
    if ((await snowball(deps, ledger)) === 0) break;
    await scanAdsOnWeb(deps, ledger);
  }
  await telegramStage(async () => {
    await resolveAdTargets(deps, ledger);
    // Advertisers and snowball finds; already-fetched stubs are skipped.
    await fetchEntities(deps, ledger);
  });

  await classifyAll(deps, ledger);

  // Enrich the promising ones, then rescore with what the websites add.
  const now = deps.now();
  let businesses = buildBusinesses(state, now);
  const toEnrich = businesses
    .filter(
      (view) =>
        view.classification.isBusiness &&
        view.classification.website &&
        !state.enrichments[view.key],
    )
    .filter((view) => view.score.total >= limits.enrichMinScore)
    .sort((left, right) => right.score.total - left.score.total)
    .slice(
      0,
      Math.max(0, limits.maxEnrich - Object.keys(state.enrichments).length),
    );
  for (const view of toEnrich) {
    state.enrichments[view.key] = await enrichWebsite(
      view.classification.website as string,
      {
        fetchPage: deps.fetchPage,
        ledger,
        maxPages: limits.pagesPerSite,
        ...(deps.renderPage ? { renderPage: deps.renderPage } : {}),
      },
    );
    await persist();
  }
  if (toEnrich.length > 0) deps.log(`enriched ${toEnrich.length} website(s)`);
  businesses = buildBusinesses(state, now);

  const toReview = businesses
    .filter(
      (view) =>
        isQualified(view.classification, view.score) &&
        !(view.key in state.reviews),
    )
    .sort((left, right) => right.score.total - left.score.total)
    .slice(
      0,
      Math.max(0, limits.reviewTop - Object.keys(state.reviews).length),
    );
  for (const view of toReview) {
    state.reviews[view.key] = await reviewLead(
      deps.llm,
      ledger,
      view.classification,
      view.score,
      view.sightings,
      view.members.map((member) => member.username),
      profile,
    );
    await persist();
  }
  if (toReview.length > 0)
    deps.log(`strong review of ${toReview.length} lead(s)`);
  businesses = buildBusinesses(state, now);

  const qualified = businesses
    .filter(qualifies)
    .sort((left, right) => right.finalScore - left.finalScore);
  const models = ledger
    .summary()
    .filter(
      (line) =>
        line.calls > line.failures && !line.route.endsWith(":unavailable"),
    )
    .map((line) => line.route);
  const leads: LeadRecord[] = [];
  const leadErrors: Array<{ key: string; errors: string[] }> = [];
  for (const view of qualified) {
    const sourceQueries = [
      ...new Set(
        view.members.flatMap((member) =>
          member.discoveries.map((item) => item.source),
        ),
      ),
    ].slice(0, 5);
    const built = buildResearchLead(view, {
      runId: state.runId,
      models,
      now,
      sourceQueries,
      profile,
    });
    if (built.lead) leads.push(built.lead);
    else leadErrors.push({ key: view.key, errors: built.errors });
  }
  await persist();
  return { businesses, qualified, leads, leadErrors, ledger };
}
