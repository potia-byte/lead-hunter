import { Api, helpers, sessions, TelegramClient } from "teleproto";
import {
  createPacer,
  FloodWaitError,
  type PacingConfig,
  withFloodWait,
} from "../pacing.js";
import {
  DiscoveryStoppedError,
  type EntityStub,
  type FoundPost,
  type TelegramDiscovery,
} from "../source.js";
import { extractUrls } from "../text.js";
import type { PublicPost } from "../types.js";
import {
  type ChatLike,
  type MessageLike,
  postOf,
  postSearchRefusal,
  stubOf,
} from "./telegram-mappers.js";

/**
 * Live Telegram discovery over a user session (teleproto / MTProto), kept
 * behind the TelegramDiscovery interface. Read-only by construction: the only
 * requests it ever builds are listed in READ_ONLY_METHODS, and a test pins
 * that list against this file's source.
 *
 * NOT VERIFIED IN THIS REPOSITORY: no test here talks to Telegram. The code is
 * the version that ran on a scheduled host (see README); the pure mappers
 * (stubOf, postOf, postSearchRefusal) are unit-tested on synthetic objects.
 */

/** Every MTProto request this adapter may send. */
export const READ_ONLY_METHODS = [
  "contacts.Search",
  "contacts.ResolveUsername",
  "channels.CheckSearchPostsFlood",
  "channels.SearchPosts",
  "channels.GetFullChannel",
  "channels.GetChannels",
  "users.GetFullUser",
  "users.GetUsers",
  "messages.GetHistory",
] as const;

/** Optional sink for an audit trail; the adapter reports method + outcome only. */
export interface AuditSink {
  record(entry: {
    action: string;
    outcome: "allowed" | "failed";
    reason?: string;
  }): void;
}

function isFloodWait(error: unknown): error is { seconds: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "seconds" in error &&
    typeof (error as { seconds: unknown }).seconds === "number"
  );
}

export interface TeleprotoDiscoveryOptions {
  apiId: number;
  apiHash: string;
  /** A pre-authorised StringSession. The adapter never signs in by itself. */
  session: string;
  pacing: PacingConfig;
  audit?: AuditSink;
  /** Longest FLOOD_WAIT to sleep through before stopping the stage. */
  maxFloodWaitSeconds: number;
  /** Counts every MTProto request, for the run's cost ledger. */
  onRequest?: (method: string) => void;
}

export function createTeleprotoDiscovery(
  options: TeleprotoDiscoveryOptions,
): TelegramDiscovery {
  const pacer = createPacer(options.pacing);
  const peers = new Map<string, unknown>();
  let client: TelegramClient | undefined;

  async function connected(): Promise<TelegramClient> {
    if (client) return client;
    const created = new TelegramClient(
      new sessions.StringSession(options.session),
      options.apiId,
      options.apiHash,
      { connectionRetries: 3 },
    );
    await created.connect();
    if (!(await created.isUserAuthorized()))
      throw new DiscoveryStoppedError(
        "The Telegram session is no longer valid; authorise a new one manually",
      );
    client = created;
    return created;
  }

  async function call<T>(method: string, request: unknown): Promise<T> {
    await pacer.take();
    const telegram = await connected();
    options.onRequest?.(method);
    try {
      const result = await withFloodWait(
        async () => {
          try {
            return (await telegram.invoke(request as never)) as T;
          } catch (error) {
            if (isFloodWait(error)) throw new FloodWaitError(error.seconds);
            throw error;
          }
        },
        { maxWaitSeconds: options.maxFloodWaitSeconds },
      );
      options.audit?.record({
        action: `lead_hunter.${method}`,
        outcome: "allowed",
      });
      return result;
    } catch (error) {
      options.audit?.record({
        action: `lead_hunter.${method}`,
        outcome: "failed",
        reason: error instanceof Error ? error.name : "unknown",
      });
      if (error instanceof FloodWaitError)
        throw new DiscoveryStoppedError(
          `Telegram asked for a ${error.seconds}s pause on ${method}; stopping this stage`,
        );
      throw error;
    }
  }

  function remember(chats: ChatLike[]): EntityStub[] {
    const stubs: EntityStub[] = [];
    for (const chat of chats) {
      const stub = stubOf(chat);
      if (!stub) continue;
      peers.set(stub.id, chat);
      stubs.push(stub);
    }
    return stubs;
  }

  async function peerFor(stub: EntityStub): Promise<unknown> {
    const known = peers.get(stub.id);
    if (known) return known;
    if (stub.accessHash) {
      const loaded = await loadByAccessHash(stub, stub.accessHash);
      if (loaded) return loaded;
    }
    const resolved = await resolveUsername(stub.username);
    if (!resolved) throw new Error(`@${stub.username} no longer resolves`);
    return peers.get(resolved.id);
  }

  /**
   * users.GetUsers / channels.GetChannels by id + access hash: unlike
   * contacts.ResolveUsername, these carry no small daily cap.
   */
  async function loadByAccessHash(
    stub: EntityStub,
    accessHash: string,
  ): Promise<unknown> {
    const id = helpers.returnBigInt(stub.id);
    const hash = helpers.returnBigInt(accessHash);
    try {
      const chats =
        stub.kind === "bot"
          ? await call<ChatLike[]>(
              "users.GetUsers",
              new Api.users.GetUsers({
                id: [new Api.InputUser({ userId: id, accessHash: hash })],
              }),
            )
          : ((
              await call<{ chats?: ChatLike[] }>(
                "channels.GetChannels",
                new Api.channels.GetChannels({
                  id: [
                    new Api.InputChannel({ channelId: id, accessHash: hash }),
                  ],
                }),
              )
            ).chats ?? []);
      remember(chats);
      return peers.get(stub.id) ?? null;
    } catch (error) {
      if (error instanceof DiscoveryStoppedError) throw error;
      // A stale hash (e.g. another account's state): fall back to the handle.
      return null;
    }
  }

  async function resolveUsername(username: string): Promise<EntityStub | null> {
    try {
      const found = await call<{ chats?: ChatLike[]; users?: ChatLike[] }>(
        "contacts.ResolveUsername",
        new Api.contacts.ResolveUsername({ username }),
      );
      const stubs = remember([...(found.chats ?? []), ...(found.users ?? [])]);
      return (
        stubs.find(
          (stub) => stub.username.toLowerCase() === username.toLowerCase(),
        ) ?? null
      );
    } catch (error) {
      if (error instanceof DiscoveryStoppedError) throw error;
      // USERNAME_NOT_OCCUPIED / USERNAME_INVALID: a dead link, not a failure.
      return null;
    }
  }

  return {
    async searchEntities(query) {
      const found = await call<{ chats?: ChatLike[]; users?: ChatLike[] }>(
        "contacts.Search",
        new Api.contacts.Search({ q: query, limit: 50 }),
      );
      return remember([...(found.chats ?? []), ...(found.users ?? [])]);
    },

    async searchPosts(query) {
      let flood: {
        queryIsFree?: boolean;
        remains?: number;
        starsAmount?: unknown;
      };
      let result: { messages?: MessageLike[]; chats?: ChatLike[] };
      try {
        flood = await call(
          "channels.CheckSearchPostsFlood",
          new Api.channels.CheckSearchPostsFlood({ query }),
        );
        if (!flood.queryIsFree && (flood.remains ?? 0) <= 0)
          return {
            ok: false,
            reason: "free public-post search quota for today is used up",
          };
        // allowPaidStars is never passed: a search that would cost Stars fails.
        result = await call(
          "channels.SearchPosts",
          new Api.channels.SearchPosts({
            query,
            offsetRate: 0,
            offsetPeer: new Api.InputPeerEmpty(),
            offsetId: 0,
            limit: 50,
          }),
        );
      } catch (error) {
        const reason = postSearchRefusal(error);
        if (reason) return { ok: false, reason };
        throw error;
      }
      const remains = flood.remains ?? 0;
      const hosts = new Map(
        remember(result.chats ?? []).map((stub) => [stub.id, stub]),
      );
      const posts: FoundPost[] = [];
      for (const message of result.messages ?? []) {
        const host = hosts.get(String(message.peerId?.channelId ?? ""));
        const post = postOf(message);
        if (host && post) posts.push({ host, post });
      }
      return { ok: true, posts, remainsToday: Math.max(0, remains - 1) };
    },

    async fetchEntity(stub, postLimit) {
      const peer = await peerFor(stub);
      let about = "";
      let participants = stub.participants;
      let botActiveUsers: number | null = null;
      let hasMainApp = false;
      const chat = peer as ChatLike;
      let posts: PublicPost[] = [];

      if (stub.kind === "bot") {
        const full = await call<{
          fullUser?: {
            about?: string;
            botInfo?: { description?: string; hasPreviewMedias?: boolean };
          };
        }>(
          "users.GetFullUser",
          new Api.users.GetFullUser({ id: peer as never }),
        );
        about = [full.fullUser?.about, full.fullUser?.botInfo?.description]
          .filter(Boolean)
          .join("\n");
        botActiveUsers = chat.botActiveUsers ?? null;
        hasMainApp = chat.botHasMainApp === true;
      } else {
        const full = await call<{
          fullChat?: { about?: string; participantsCount?: number };
        }>(
          "channels.GetFullChannel",
          new Api.channels.GetFullChannel({ channel: peer as never }),
        );
        about = full.fullChat?.about ?? "";
        participants = full.fullChat?.participantsCount ?? participants;
        if (postLimit > 0) {
          const history = await call<{ messages?: MessageLike[] }>(
            "messages.GetHistory",
            new Api.messages.GetHistory({
              peer: peer as never,
              offsetId: 0,
              offsetDate: 0,
              addOffset: 0,
              limit: postLimit,
              maxId: 0,
              minId: 0,
              hash: 0 as never,
            }),
          );
          posts = (history.messages ?? [])
            .map(postOf)
            .filter((post): post is PublicPost => post !== null);
        }
      }

      return {
        id: stub.id,
        kind: stub.kind,
        username: stub.username,
        title: stub.title,
        about,
        participants,
        botActiveUsers,
        hasMainApp,
        verified: chat.verified === true,
        scamOrFake: chat.scam === true || chat.fake === true,
        aboutLinks: extractUrls(about),
        posts,
        discoveries: [],
        fetchedAt: new Date().toISOString(),
      };
    },

    resolve: resolveUsername,

    async disconnect() {
      await client?.disconnect();
      client = undefined;
    },
  };
}
