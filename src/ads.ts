import {
  adMarkerOf,
  businessDomainOf,
  clip,
  extractHandles,
  telegramTargetOf,
} from "./text.js";
import type { AdSighting, RawEntity } from "./types.js";
import { advertiserMarkOf } from "./webpreview.js";

/**
 * Finds paid posts on a channel and what they promote. An entity that shows
 * up as the target of someone else's ad has, by definition, spent money on
 * acquisition — the strongest signal Lead Hunter has, and it needs no model.
 */
export function adSightingsIn(
  host: Pick<RawEntity, "username" | "posts">,
): AdSighting[] {
  const sightings: AdSighting[] = [];
  const own = host.username.toLowerCase();
  for (const post of host.posts) {
    const marker = adMarkerOf(post.text);
    if (!marker) continue;
    const targets = new Set<string>();
    for (const link of post.links) {
      const handle = telegramTargetOf(link);
      if (handle) {
        if (handle !== own) targets.add(handle);
        continue;
      }
      const domain = businessDomainOf(link);
      if (domain) targets.add(domain);
    }
    for (const handle of extractHandles(post.text))
      if (handle !== own) targets.add(handle);
    const mark = advertiserMarkOf(post.text);
    for (const target of targets) {
      sightings.push({
        postUrl: `https://t.me/${host.username}/${post.id}`,
        hostUsername: host.username,
        marker,
        date: post.date,
        target,
        excerpt: clip(post.text.replace(/\s+/g, " "), 240),
        ...(mark ? { advertiser: mark.name } : {}),
        ...(mark?.inn ? { inn: mark.inn } : {}),
      });
    }
  }
  return sightings;
}

/** True for a web domain target rather than a Telegram handle. */
export function isDomainTarget(target: string): boolean {
  return target.includes(".");
}
