import { canonicalRegistrableHostname } from "./canonical.js";
import type { UsageLedger } from "./llm.js";
import { clip, extractEmails, telegramTargetOf } from "./text.js";
import type { ContactFinding, Enrichment, WebPage } from "./types.js";

/**
 * Bounded website enrichment for the candidates worth it: the home page plus
 * at most a few same-site pages whose link text or path looks like contacts,
 * advertising or partnerships. Plain HTTP first; a headless browser only for
 * a page that is clearly a JS shell, and only when the caller allows it.
 */

export type FetchPage = (
  url: string,
) => Promise<{ html: string; finalUrl: string }>;

export interface EnrichOptions {
  fetchPage: FetchPage;
  ledger: UsageLedger;
  maxPages: number;
  /** Renders a JS-only page; undefined disables the browser fallback. */
  renderPage?: FetchPage;
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; LeadHunter/1.0; public business contact lookup)";
const MAX_BYTES = 1_500_000;

export function createHttpFetcher(timeoutMs = 12_000): FetchPage {
  return async (url) => {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html")) throw new Error(`not HTML (${type})`);
    const html = (await response.text()).slice(0, MAX_BYTES);
    return { html, finalUrl: response.url || url };
  };
}

const INTERESTING =
  /(contact|about|advert|partner|media-?kit|press|business|cooperat|реклам|сотруднич|контакт|партн|о-нас|о_нас)/iu;

export function parseHtml(html: string, baseUrl: string): WebPage {
  const title =
    /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.trim() ?? "";
  const links: string[] = [];
  for (const match of html.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu,
  )) {
    const href = match[1] ?? "";
    if (href.startsWith("mailto:")) {
      links.push(href);
      continue;
    }
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") {
        url.hash = "";
        // Keep the anchor text in the fragment-free URL's company for ranking.
        links.push(
          `${url.toString()}#${(match[2] ?? "")
            .replace(/<[^>]+>/g, " ")
            .trim()
            .slice(0, 60)}`,
        );
      }
    } catch {
      // ignore unparsable hrefs
    }
  }
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#64;|&commat;/g, "@")
    .replace(/\s+/g, " ")
    .trim();
  const mailto = links
    .filter((link) => link.startsWith("mailto:"))
    .map((link) => link.slice(7).split("?")[0] ?? "");
  return {
    url: baseUrl,
    title: clip(title, 200),
    text: clip(text, 20_000),
    links: links.filter((link) => !link.startsWith("mailto:")),
    emails: [
      ...new Set([...extractEmails(text), ...extractEmails(mailto.join(" "))]),
    ],
  };
}

function stripAnchor(link: string): { url: string; label: string } {
  const index = link.indexOf("#");
  return index < 0
    ? { url: link, label: "" }
    : { url: link.slice(0, index), label: link.slice(index + 1) };
}

function emailRole(email: string): ContactFinding["role"] {
  const local = email.split("@")[0] ?? "";
  if (/(ads?|adv|advert|marketing|promo|media|reklam)/.test(local))
    return "advertising";
  if (/(partner|bd|business|biz|collab|cooperation|sales)/.test(local))
    return "partnership";
  if (/(support|help|care|service)/.test(local)) return "support";
  return "general";
}

/** A page with almost no text but a script bundle is a client-rendered shell. */
export function looksLikeJsShell(html: string, page: WebPage): boolean {
  return page.text.length < 200 && /<script\b[^>]*src=/iu.test(html);
}

export async function enrichWebsite(
  website: string,
  options: EnrichOptions,
): Promise<Enrichment> {
  const pages: WebPage[] = [];
  const site = canonicalRegistrableHostname(website);
  let error: string | null = null;

  const load = async (url: string): Promise<WebPage | null> => {
    try {
      options.ledger.webRequests += 1;
      const { html, finalUrl } = await options.fetchPage(url);
      let page = parseHtml(html, finalUrl);
      if (options.renderPage && looksLikeJsShell(html, page)) {
        options.ledger.browserSessions += 1;
        const rendered = await options.renderPage(finalUrl);
        page = parseHtml(rendered.html, rendered.finalUrl);
      }
      pages.push(page);
      return page;
    } catch (failure) {
      error ??= `${url}: ${(failure as Error).message}`;
      return null;
    }
  };

  const home = await load(website);
  if (home) {
    const subpages = home.links
      .map(stripAnchor)
      .filter(({ url, label }) => {
        if (canonicalRegistrableHostname(url) !== site) return false;
        if (url.replace(/\/$/, "") === home.url.replace(/\/$/, ""))
          return false;
        return INTERESTING.test(url) || INTERESTING.test(label);
      })
      .map(({ url }) => url);
    for (const url of [...new Set(subpages)].slice(
      0,
      Math.max(0, options.maxPages - 1),
    ))
      await load(url);
  }

  const contacts: ContactFinding[] = [];
  const seen = new Set<string>();
  let adPageUrl: string | null = null;
  for (const page of pages) {
    const pagePath = page.url.toLowerCase();
    const isAdPage = /(advert|реклам|media-?kit|partner|сотруднич)/iu.test(
      pagePath,
    );
    if (isAdPage) adPageUrl ??= page.url;
    for (const email of page.emails) {
      if (seen.has(email)) continue;
      seen.add(email);
      contacts.push({
        kind: "email",
        value: email,
        role: emailRole(email),
        sourceUrl: page.url,
      });
    }
    for (const link of page.links) {
      const handle = telegramTargetOf(stripAnchor(link).url);
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      contacts.push({
        kind: "telegram",
        value: `@${handle}`,
        role: isAdPage ? "advertising" : "general",
        sourceUrl: page.url,
      });
    }
  }
  return {
    website,
    pages: pages.map((page) => ({
      ...page,
      text: clip(page.text, 4_000),
      links: page.links.slice(0, 80),
    })),
    contacts: contacts.slice(0, 12),
    adPageUrl,
    error,
  };
}

/** Lazily starts one headless Chromium for the whole run. */
export function createBrowserRenderer(): FetchPage & {
  close(): Promise<void>;
} {
  let browser: { newPage(): Promise<unknown>; close(): Promise<void> } | null =
    null;
  const render = (async (url: string) => {
    if (!browser) {
      // Optional dependency, resolved at runtime so the package builds without it.
      const specifier = "playwright";
      const { chromium } = (await import(specifier)) as {
        chromium: { launch(options: object): Promise<unknown> };
      };
      browser = (await chromium.launch({ headless: true })) as never;
    }
    const page = (await (
      browser as { newPage(): Promise<unknown> }
    ).newPage()) as {
      goto(url: string, options: object): Promise<unknown>;
      content(): Promise<string>;
      url(): string;
      close(): Promise<void>;
    };
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
      return { html: await page.content(), finalUrl: page.url() };
    } finally {
      await page.close();
    }
  }) as FetchPage & { close(): Promise<void> };
  render.close = async () => {
    await browser?.close();
    browser = null;
  };
  return render;
}
