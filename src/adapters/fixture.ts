import type { FetchPage } from "../enrich.js";
import {
  type LlmClient,
  type LlmCompletion,
  type LlmOptions,
  LlmUnavailableError,
} from "../llm.js";
import {
  type EntityStub,
  type FoundPost,
  type PostSearchResult,
  type TelegramDiscovery,
} from "../source.js";
import type { PublicPost, RawEntity } from "../types.js";
import type { WebPreview, WebProfile } from "../webpreview.js";

/**
 * In-memory stand-ins for every external dependency, driven by a synthetic
 * "world". Used by the tests and by `npm run demo`: no network, no keys.
 */

export interface FixtureWorld {
  /** Entities that Telegram search can return and `fetchEntity` can read. */
  entities: RawEntity[];
  /** Entity search: query -> ids of `entities` it returns. Unknown queries return nothing. */
  entitySearch: Record<string, string[]>;
  /** Public-post search: query -> (host entity id, post) pairs. */
  postSearch?: Record<string, Array<{ hostId: string; post: PublicPost }>>;
  /** Profiles reachable only by t.me/<name> (no Telegram peer id). */
  webProfiles: Record<string, WebProfile>;
  /** Recent posts per channel for the t.me/s/<name> preview. */
  webPosts: Record<string, PublicPost[]>;
  /** Websites: URL (no trailing slash) -> HTML. */
  sites: Record<string, string>;
}

function stubOfEntity(entity: RawEntity): EntityStub {
  return {
    id: entity.id,
    kind: entity.kind,
    username: entity.username,
    title: entity.title,
    participants: entity.participants,
  };
}

export function createFixtureDiscovery(
  world: FixtureWorld,
): TelegramDiscovery & { calls: string[] } {
  const byId = new Map(world.entities.map((entity) => [entity.id, entity]));
  const byName = new Map(
    world.entities.map((entity) => [entity.username.toLowerCase(), entity]),
  );
  const calls: string[] = [];
  return {
    calls,
    async searchEntities(query) {
      calls.push(`search:${query}`);
      return (world.entitySearch[query] ?? [])
        .map((id) => byId.get(id))
        .filter((entity): entity is RawEntity => entity !== undefined)
        .map(stubOfEntity);
    },
    async searchPosts(query): Promise<PostSearchResult> {
      calls.push(`posts:${query}`);
      const posts: FoundPost[] = [];
      for (const item of world.postSearch?.[query] ?? []) {
        const host = byId.get(item.hostId);
        if (host) posts.push({ host: stubOfEntity(host), post: item.post });
      }
      return { ok: true, posts, remainsToday: 10 };
    },
    async fetchEntity(stub, postLimit) {
      calls.push(`fetch:${stub.username}`);
      const entity = byId.get(stub.id);
      if (!entity) throw new Error(`fixture has no entity ${stub.id}`);
      return { ...entity, posts: entity.posts.slice(0, postLimit) };
    },
    async resolve(username) {
      calls.push(`resolve:${username}`);
      const entity = byName.get(username.toLowerCase());
      return entity ? stubOfEntity(entity) : null;
    },
    async disconnect() {},
  };
}

export function createFixtureWebPreview(world: FixtureWorld): WebPreview {
  return {
    async profile(username) {
      const known = world.webProfiles[username.toLowerCase()];
      if (known) return known;
      const entity = world.entities.find(
        (item) => item.username.toLowerCase() === username.toLowerCase(),
      );
      if (!entity) return null;
      return {
        username: entity.username,
        kind: entity.kind,
        title: entity.title,
        about: entity.about,
        participants: entity.participants,
      };
    },
    async channelPosts(username) {
      const key = username.toLowerCase();
      return world.webPosts[key] ?? [];
    },
  };
}

export function createFixtureFetchPage(world: FixtureWorld): FetchPage {
  return async (url) => {
    const html = world.sites[url.replace(/\/$/, "")];
    if (html === undefined) throw new Error("HTTP 404");
    return { html, finalUrl: url };
  };
}

/**
 * Canned model answers, keyed by what the prompt asks about. This is what
 * lets the demo run with no API key: it exercises every code path after the
 * model call (JSON parsing, quote verification, scoring, dedupe), but it says
 * nothing about real model quality.
 */
export interface ReplayReplies {
  /** Entity id -> a classification result object (the model's JSON, per entity). */
  classification: Record<string, Record<string, unknown>>;
  /** Business name -> review verdict. */
  review?: Record<
    string,
    { verdict: "confirm" | "adjust" | "reject"; adjustment: number; reason: string }
  >;
}

export function createReplayLlm(replies: ReplayReplies): LlmClient & {
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    async completion(
      prompt: string,
      options: LlmOptions,
    ): Promise<LlmCompletion> {
      prompts.push(prompt);
      const route = `replay/${options.tier}`;
      const usage = { inputTokens: 0, outputTokens: 0 };
      if (prompt.includes('{"results":[')) {
        const ids = [...prompt.matchAll(/^### id=(\S+) /gmu)].map(
          (match) => match[1] ?? "",
        );
        const results = ids.map((id) => ({
          id,
          ...(replies.classification[id] ?? {
            is_business: false,
            reject_reason: "no canned reply for this entity",
          }),
        }));
        return { text: JSON.stringify({ results }), route, usage };
      }
      if (prompt.includes("final reviewer")) {
        const name = /^Lead: (.+?) \(@/mu.exec(prompt)?.[1] ?? "";
        const verdict = replies.review?.[name] ?? {
          verdict: "confirm",
          adjustment: 0,
          reason: "canned confirm",
        };
        return { text: JSON.stringify(verdict), route, usage };
      }
      if (prompt.includes('"entity_queries"'))
        return {
          text: '{"entity_queries":[],"post_queries":[]}',
          route,
          usage,
        };
      throw new LlmUnavailableError("replay LLM does not know this prompt");
    },
  };
}
