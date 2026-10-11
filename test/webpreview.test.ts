import { describe, expect, it } from "vitest";
import { UsageLedger } from "../src/llm.js";
import { adMarkerOf } from "../src/text.js";
import {
  advertiserMarkOf,
  createWebPreview,
  parseChannelPage,
  parseCount,
  parseProfilePage,
} from "../src/webpreview.js";

// Hand-written HTML in the shape of Telegram's public preview pages. It is
// synthetic: it mirrors the class names the parser relies on, nothing more.
const profileHtml = (title: string, extra: string, about: string, action: string) =>
  `<div class="tgme_page"><div class="tgme_page_title"><span>${title}</span></div>` +
  `<div class="tgme_page_extra">${extra}</div>` +
  `<div class="tgme_page_description">${about}</div>` +
  `<a class="tgme_action_button_new">${action}</a></div>`;

const channelPage = (before: number) =>
  `<section data-before="${before}">` +
  [3, 2, 1]
    .map(
      (id) =>
        `<div class="tgme_widget_message_wrap js-widget_message_wrap">` +
        `<div class="tgme_widget_message" data-post="demo_host/${id + before}">` +
        `<div class="tgme_widget_message_text js-message_text">Post ${id}<br/>` +
        (id === 3
          ? "Реклама. Рекламодатель: ООО «Ромашка». ИНН 7700000000. erid: 2VtzqDEMO999 <a href=\"https://t.me/promo_demo_bot?start=x\">бот</a>"
          : "plain text") +
        `</div><div class="tgme_widget_message_views">1.2K</div>` +
        `<time datetime="2026-09-30T10:00:00+00:00"></time></div></div>`,
    )
    .join("") +
  `</section>`;

describe("Telegram web preview parsing", () => {
  it("reads compact and spaced counts", () => {
    expect(parseCount("2.05M")).toBe(2_050_000);
    expect(parseCount("63.3K")).toBe(63_300);
    expect(parseCount("51 047")).toBe(51_047);
    expect(parseCount("n/a")).toBeNull();
  });

  it("parses a channel, a bot and refuses a person", () => {
    const channel = parseProfilePage(
      profileHtml("Demo Channel", "51 047 subscribers", "About https://demo-site.test", "View in Telegram"),
      "demo_channel",
    );
    expect(channel).toMatchObject({
      kind: "channel",
      title: "Demo Channel",
      participants: 51_047,
    });
    expect(channel?.about).toContain("https://demo-site.test");
    expect(
      parseProfilePage(
        profileHtml("Demo Bot", "@demo_bot", "A bot", "Start Bot"),
        "demo_bot",
      ),
    ).toMatchObject({ kind: "bot", participants: null });
    expect(
      parseProfilePage(
        profileHtml("Some Person", "@person", "", "Send Message"),
        "person",
      ),
    ).toBeNull();
  });

  it("parses posts, the ad marker and the pagination cursor", () => {
    const page = parseChannelPage(channelPage(100));
    expect(page.posts).toHaveLength(3);
    expect(page.before).toBe(100);
    const ad = page.posts.find((post) => /erid/i.test(post.text));
    expect(ad && adMarkerOf(ad.text)).toBe("erid");
    expect(ad?.links).toContain("https://t.me/promo_demo_bot?start=x");
    expect(ad && advertiserMarkOf(ad.text)).toEqual({
      name: "ООО «Ромашка»",
      inn: "7700000000",
    });
    expect(ad?.views).toBe(1200);
  });

  it("reads the legal advertiser line in its common shapes", () => {
    expect(
      advertiserMarkOf(
        "Реклама. Рекламодатель: ИП Иванов И.И., ИНН 123456789012",
      ),
    ).toEqual({ name: "ИП Иванов И.И", inn: "123456789012" });
    expect(
      advertiserMarkOf(
        "Реклама ООО «Ромашка»\nРекламодатель ООО «Ромашка»\nerid: 2Vtzq",
      ),
    ).toEqual({ name: "ООО «Ромашка»", inn: null });
    expect(advertiserMarkOf("просто пост без рекламы")).toBeNull();
  });

  it("follows pages, counts requests and survives fetch errors", async () => {
    const urls: string[] = [];
    const ledger = new UsageLedger();
    const preview = createWebPreview(
      async (url) => {
        urls.push(url);
        if (url.endsWith("/missing")) throw new Error("HTTP 404");
        return { html: channelPage(urls.length * 10), finalUrl: url };
      },
      ledger,
      0,
    );
    const posts = await preview.channelPosts("demo_host", 2);
    expect(posts).toHaveLength(6);
    expect(urls[1]).toMatch(/\/s\/demo_host\?before=\d+$/u);
    expect(await preview.profile("missing")).toBeNull();
    expect(ledger.webRequests).toBe(3);
  });

  it("keeps the channel behind forwarded and post links", () => {
    const html = `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="host/5"><a class="tgme_widget_message_forwarded_from_name" href="https://t.me/some_channel/23659">Old</a><div class="tgme_widget_message_text js-message_text">See <a href="https://t.me/otherchan/77">post</a></div><time datetime="2026-09-24T10:00:00+00:00"></time></div></div>`;
    const [post] = parseChannelPage(html).posts;
    expect(post?.links).toEqual(
      expect.arrayContaining([
        "https://t.me/some_channel",
        "https://t.me/otherchan",
      ]),
    );
  });
});
