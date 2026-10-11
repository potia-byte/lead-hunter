import type { EntityKind, PublicPost, RawEntity } from "./types.js";

/**
 * The discovery boundary. Lead Hunter only needs to search public entities and
 * posts, read a public profile with its recent posts, and resolve a handle.
 * Anything that can do that can feed the pipeline: the optional teleproto
 * adapter (live Telegram, read-only) or the fixture source used by tests and
 * the demo.
 */

export interface EntityStub {
  id: string;
  kind: EntityKind;
  username: string;
  title: string;
  participants: number | null;
  /** Lets a resumed run load the peer without contacts.ResolveUsername. */
  accessHash?: string;
}

export interface FoundPost {
  host: EntityStub;
  post: PublicPost;
}

export type PostSearchResult =
  | { ok: true; posts: FoundPost[]; remainsToday: number }
  | { ok: false; reason: string };

export interface TelegramDiscovery {
  searchEntities(query: string): Promise<EntityStub[]>;
  searchPosts(query: string): Promise<PostSearchResult>;
  fetchEntity(stub: EntityStub, postLimit: number): Promise<RawEntity>;
  resolve(username: string): Promise<EntityStub | null>;
  disconnect(): Promise<void>;
}

/** Telegram refused for longer than we are willing to wait. */
export class DiscoveryStoppedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DiscoveryStoppedError";
  }
}
