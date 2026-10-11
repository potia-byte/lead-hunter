import type { FetchPage } from "./enrich.js";
import type { UsageLedger } from "./llm.js";
import { extractUrls } from "./text.js";
import type { EntityKind, PublicPost } from "./types.js";

/**
 * Telegram's public web preview (t.me/<name>, t.me/s/<channel>). It needs no
 * account, so it costs none of the QA session's limits — in particular not
 * contacts.ResolveUsername, which Telegram caps at about 200 calls a day.
 */

export interface WebProfile {
  username: string;
  kind: EntityKind;
  title: string;
  about: string;
  /** Subscribers for channels, members for groups; null for bots. */
  participants: number | null;
}

export interface WebChannelPage {
  posts: PublicPost[];
  /** Pass as `before` to read the next, older page; null on the last page. */
  before: number | null;
}

/** Legal advertiser line Russian ad law requires on every paid post. */
export interface AdvertiserMark {
  name: string;
  inn: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

function decode(text: string): string {
  return text
    .replace(
      /&(amp|lt|gt|quot|#39|nbsp);/g,
      (_, name: string) => ENTITIES[name] ?? "",
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

/** Visible text of an HTML fragment, keeping line breaks. */
function textOf(html: string): string {
  return decode(
    html
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n"),
  ).trim();
}

/** "2.05M", "63.3K", "51 047" → number. */
export function parseCount(raw: string): number | null {
  const compact = raw.replace(/[\s ,]/g, "");
  const match = /^([\d.]+)([KM]?)$/iu.exec(compact);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const scale =
    match[2]?.toUpperCase() === "M"
      ? 1_000_000
      : match[2]?.toUpperCase() === "K"
        ? 1_000
        : 1;
  return Math.round(value * scale);
}

function blockOf(html: string, className: string): string | null {
  const start = html.search(new RegExp(`class="${className}"`, "u"));
  if (start < 0) return null;
  const open = html.indexOf(">", start);
  const close = html.indexOf("</div>", open);
  if (open < 0 || close < 0) return null;
  return html.slice(open + 1, close);
}

/** Parses t.me/<username>. Returns null for people and missing names. */
export function parseProfilePage(
  html: string,
  username: string,
): WebProfile | null {
  const title = textOf(blockOf(html, "tgme_page_title") ?? "");
  if (!title) return null;
  const extra = textOf(blockOf(html, "tgme_page_extra") ?? "");
  const about = textOf(blockOf(html, "tgme_page_description") ?? "");
  let kind: EntityKind;
  if (/>\s*Start Bot\s*</u.test(html)) kind = "bot";
  else if (/\bsubscribers?\b/u.test(extra)) kind = "channel";
  else if (/\bmembers?\b/u.test(extra)) kind = "group";
  // "Send Message" and anything else is a person: never collected.
  else return null;
  const count = /^([\d\s .,KM]+?)\s+(subscribers?|members?)/iu.exec(extra);
  return {
    username,
    kind,
    title,
    about,
    participants: kind === "bot" ? null : parseCount(count?.[1] ?? ""),
  };
}

/** Parses t.me/s/<channel>: posts newest-last, as Telegram renders them. */
export function parseChannelPage(html: string): WebChannelPage {
  const posts: PublicPost[] = [];
  const chunks = html.split('<div class="tgme_widget_message_wrap').slice(1);
  for (const chunk of chunks) {
    const id = Number(/data-post="[^"/]+\/(\d+)"/u.exec(chunk)?.[1]);
    if (!Number.isSafeInteger(id)) continue;
    const datetime = /<time datetime="([^"]+)"/u.exec(chunk)?.[1];
    const date = datetime ? Math.floor(Date.parse(datetime) / 1000) : 0;
    const textHtml =
      /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/u.exec(
        chunk,
      )?.[1] ?? "";
    const text = textOf(textHtml);
    const links = new Set<string>(extractUrls(text));
    // Hidden text links and inline URL buttons carry most ad targets.
    for (const match of chunk.matchAll(/href="(https?:\/\/[^"]+)"/gu)) {
      const url = decode(match[1] ?? "");
      // Forwarded-from and post links name another channel: keep the channel.
      const postLink =
        /^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z][\w]{3,31})\/\d+/u.exec(
          url,
        );
      links.add(postLink ? `https://t.me/${postLink[1]}` : url);
    }
    const views = /class="tgme_widget_message_views">([^<]+)</u.exec(chunk);
    posts.push({
      id,
      date,
      text,
      views: views?.[1] ? parseCount(views[1]) : null,
      forwards: null,
      links: [...links],
    });
  }
  const before = /data-before="(\d+)"/u.exec(html)?.[1];
  return { posts, before: before ? Number(before) : null };
}

/** "Реклама. Рекламодатель: ООО «Ромашка». ИНН 7700000000. erid: …" */
export function advertiserMarkOf(text: string): AdvertiserMark | null {
  const match =
    /рекламодатель\s*[:\-–]?\s*([^\n]{2,120}?)(?:[.,;]?\s*(?:ИНН|инн)\s*[:\s]*(\d{10}|\d{12}))?(?=[.,;]?\s*(?:erid|ИНН|инн|$|\n))/iu.exec(
      text,
    );
  if (!match?.[1]) return null;
  const name = match[1].replace(/[.,;\s]+$/u, "").trim();
  if (name.length < 2) return null;
  const inn =
    match[2] ??
    /(?:ИНН|инн)\s*[:\s]*(\d{10}|\d{12})\b/u.exec(text)?.[1] ??
    null;
  return { name, inn };
}

export interface WebPreview {
  profile(username: string): Promise<WebProfile | null>;
  channelPosts(username: string, pages: number): Promise<PublicPost[]>;
}

export function createWebPreview(
  fetchPage: FetchPage,
  ledger: UsageLedger,
  minDelayMs = 1_000,
): WebPreview {
  let last = 0;
  async function get(url: string): Promise<string> {
    // Politeness towards t.me: one request a second is plenty for a nightly run.
    const wait = last + minDelayMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    last = Date.now();
    ledger.webRequests += 1;
    return (await fetchPage(url)).html;
  }
  return {
    async profile(username) {
      try {
        return parseProfilePage(
          await get(`https://t.me/${username}`),
          username,
        );
      } catch {
        return null;
      }
    },
    async channelPosts(username, pages) {
      const posts: PublicPost[] = [];
      let before: number | null = null;
      for (let page = 0; page < pages; page += 1) {
        let parsed: WebChannelPage;
        try {
          parsed = parseChannelPage(
            await get(
              `https://t.me/s/${username}${before ? `?before=${before}` : ""}`,
            ),
          );
        } catch {
          break;
        }
        posts.push(...parsed.posts);
        if (!parsed.before || parsed.posts.length === 0) break;
        before = parsed.before;
      }
      return posts;
    },
  };
}
