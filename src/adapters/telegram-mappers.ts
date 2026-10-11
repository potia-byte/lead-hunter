import type { EntityStub } from "../source.js";
import { extractUrls } from "../text.js";
import type { PublicPost } from "../types.js";

/**
 * Pure mappers from MTProto-shaped objects to Lead Hunter records. They have
 * no dependency on the Telegram client, so they can be tested on plain objects.
 */

export interface ChatLike {
  className?: string;
  id?: unknown;
  accessHash?: unknown;
  username?: string;
  usernames?: Array<{ username?: string; active?: boolean }>;
  title?: string;
  firstName?: string;
  lastName?: string;
  broadcast?: boolean;
  megagroup?: boolean;
  bot?: boolean;
  participantsCount?: number;
  verified?: boolean;
  scam?: boolean;
  fake?: boolean;
  botActiveUsers?: number;
  botHasMainApp?: boolean;
}

export interface MessageLike {
  className?: string;
  id?: number;
  date?: number;
  message?: string;
  views?: number;
  forwards?: number;
  peerId?: { channelId?: unknown };
  entities?: Array<{ className?: string; url?: string }>;
  replyMarkup?: { rows?: Array<{ buttons?: Array<{ url?: string }> }> };
}

function usernameOf(chat: ChatLike): string {
  if (chat.username) return chat.username;
  const active = chat.usernames?.find((entry) => entry.active !== false);
  return active?.username ?? "";
}

/** Only public business-shaped peers: channels, groups and bots with a handle. */
export function stubOf(chat: ChatLike): EntityStub | null {
  const username = usernameOf(chat);
  if (!username || chat.id === undefined) return null;
  const id = String(chat.id);
  const hash =
    chat.accessHash === undefined || chat.accessHash === null
      ? {}
      : { accessHash: String(chat.accessHash) };
  if (chat.className === "Channel") {
    return {
      id,
      kind: chat.broadcast ? "channel" : "group",
      username,
      title: chat.title ?? username,
      participants: chat.participantsCount ?? null,
      ...hash,
    };
  }
  // Ordinary people are never collected; only bots are business entities.
  if (chat.className === "User" && chat.bot) {
    return {
      id,
      kind: "bot",
      username,
      title:
        [chat.firstName, chat.lastName].filter(Boolean).join(" ") || username,
      participants: null,
      ...hash,
    };
  }
  return null;
}

export function postOf(message: MessageLike): PublicPost | null {
  if (message.className !== "Message" || typeof message.id !== "number")
    return null;
  const text = message.message ?? "";
  const links = new Set(extractUrls(text));
  for (const entity of message.entities ?? [])
    if (entity.className === "MessageEntityTextUrl" && entity.url)
      links.add(entity.url);
  for (const row of message.replyMarkup?.rows ?? [])
    for (const button of row.buttons ?? [])
      if (button.url) links.add(button.url);
  return {
    id: message.id,
    date: message.date ?? 0,
    text,
    views: message.views ?? null,
    forwards: message.forwards ?? null,
    links: [...links],
  };
}

/**
 * Telegram refusals that end public-post search for the whole run: the
 * account cannot use it, so every further query would fail the same way.
 */
export function postSearchRefusal(error: unknown): string | null {
  const message =
    typeof error === "object" && error !== null && "errorMessage" in error
      ? (error as { errorMessage: unknown }).errorMessage
      : undefined;
  if (message === "PREMIUM_ACCOUNT_REQUIRED")
    return "public-post search needs Telegram Premium on this account";
  return null;
}

