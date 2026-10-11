import {
  canonicalBusinessEmail,
  canonicalRegistrableHostname,
  canonicalTelegramHandle,
} from "./canonical.js";

/**
 * Deterministic text helpers. Links, handles and emails are pulled out here by
 * pattern, never by a model, so everything downstream can check an LLM's
 * answer against a list that is known to be real.
 */

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'«»()[\]{}]+/giu;
const BARE_TME = /(?<![\w/@.])(?:t\.me|telegram\.me)\/[^\s<>"'«»()[\]{}]+/giu;
const HANDLE_PATTERN = /(?<![\w@.])@([a-z][a-z\d_]{3,31})\b/giu;
const EMAIL_PATTERN = /[a-z\d._%+-]+@[a-z\d.-]+\.[a-z]{2,24}/giu;

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?…]+$/u, "");
}

export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN))
    found.add(trimTrailingPunctuation(match[0]));
  for (const match of text.matchAll(BARE_TME))
    found.add(`https://${trimTrailingPunctuation(match[0])}`);
  return [...found];
}

export function extractHandles(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(HANDLE_PATTERN)) {
    const handle = canonicalTelegramHandle(match[1] ?? "");
    if (handle) found.add(handle);
  }
  return [...found];
}

export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const email = canonicalBusinessEmail(trimTrailingPunctuation(match[0]));
    // Image names like logo@2x.png match the pattern but are not addresses.
    if (email && !/\.(png|jpe?g|gif|webp|svg)$/.test(email)) found.add(email);
  }
  return [...found];
}

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);

/** The Telegram handle a t.me link points at, ignoring invite links. */
export function telegramTargetOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!TELEGRAM_HOSTS.has(parsed.hostname.replace(/^www\./, ""))) return null;
    if (parsed.pathname.startsWith("/+")) return null;
  } catch {
    return null;
  }
  return canonicalTelegramHandle(url);
}

/**
 * Hosts that never identify a business on their own: link-in-bio pages,
 * social networks, app stores and URL shorteners. A shared one of these is
 * not a reason to merge two leads, and not an official website.
 */
const GENERIC_DOMAINS = new Set([
  "t.me",
  "telegram.me",
  "telegram.org",
  "telegra.ph",
  "linktr.ee",
  "taplink.cc",
  "taplink.ws",
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "facebook.com",
  "vk.com",
  "vk.cc",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "discord.gg",
  "discord.com",
  "medium.com",
  "github.com",
  "google.com",
  "goo.gl",
  "bit.ly",
  "clck.ru",
  "tinyurl.com",
  "apple.com",
  "apps.apple.com",
  "play.google.com",
  "dzen.ru",
  "ok.ru",
  "rutube.ru",
  "wikipedia.org",
  "reddit.com",
  "linkedin.com",
  "notion.so",
  "notion.site",
  "forms.gle",
  "tgstat.ru",
  "tgstat.com",
  "telemetr.io",
  "wa.me",
  "whatsapp.com",
]);

export function businessDomainOf(url: string): string | null {
  const domain = canonicalRegistrableHostname(url);
  if (!domain || GENERIC_DOMAINS.has(domain)) return null;
  return domain;
}

/**
 * Russian law requires paid posts to carry an "erid" token and the word
 * "Реклама"; many other channels tag ads by hand. Any one marker is enough.
 */
const AD_MARKERS: Array<{ label: string; pattern: RegExp }> = [
  { label: "erid", pattern: /\berid[:\s]*[a-z\d]{6,}/iu },
  { label: "#реклама", pattern: /#реклама/iu },
  { label: "Реклама.", pattern: /(^|\n)\s*реклама[.:]/iu },
  { label: "#ad", pattern: /#(ad|ads|sponsored|promo)\b/iu },
  { label: "#партнерский", pattern: /#партн[её]рск/iu },
];

export function adMarkerOf(text: string): string | null {
  for (const marker of AD_MARKERS)
    if (marker.pattern.test(text)) return marker.label;
  return null;
}

/** Whitespace- and case-insensitive containment, for verifying quotes. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[ \s]+/gu, " ")
    .replace(/[«»"“”„'’`]/gu, "")
    .trim();
}

export function containsQuote(haystack: string, quote: string): boolean {
  const needle = normalizeForMatch(quote);
  if (needle.length < 4) return false;
  return normalizeForMatch(haystack).includes(needle);
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function daysAgo(unixSeconds: number, now: Date): number {
  return (now.getTime() / 1000 - unixSeconds) / 86_400;
}
