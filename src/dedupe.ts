import { businessDomainOf, extractHandles, telegramTargetOf } from "./text.js";
import type { BusinessLead, Classification, RawEntity } from "./types.js";

/**
 * Groups Telegram entities that belong to one business. Merges only on hard
 * evidence — a shared product website, or two profiles that point at each
 * other — plus a one-way profile link backed by a matching name. A shared
 * contact is deliberately NOT a reason: one ad manager serves many projects.
 * When unsure, entities stay separate.
 */

export interface DedupeInput {
  entity: RawEntity;
  classification: Classification;
  /** Extra domains found during web enrichment. */
  domains?: string[];
}

const STEM_NOISE =
  /(_?(official|bot|app|channel|news|chat|group|ru|en|eng|rus|global|community|tg|io))+$/u;

export function nameStem(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-zа-яё\d]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .replace(STEM_NOISE, "")
    .replace(/_/g, "");
}

function titleTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-zа-яё\d]+/u)
      .filter((token) => token.length >= 3),
  );
}

export function similarNames(left: RawEntity, right: RawEntity): boolean {
  const leftStem = nameStem(left.username);
  const rightStem = nameStem(right.username);
  if (leftStem.length >= 4 && leftStem === rightStem) return true;
  if (
    leftStem.length >= 5 &&
    rightStem.length >= 5 &&
    (leftStem.startsWith(rightStem) || rightStem.startsWith(leftStem))
  )
    return true;
  const a = titleTokens(left.title);
  const b = titleTokens(right.title);
  if (a.size === 0 || b.size === 0) return false;
  const shared = [...a].filter((token) => b.has(token)).length;
  return shared / Math.min(a.size, b.size) >= 0.6;
}

/** Handles an entity's own profile points at (description links and @mentions). */
function profileTargets(entity: RawEntity): Set<string> {
  const targets = new Set<string>();
  for (const link of entity.aboutLinks) {
    const handle = telegramTargetOf(link);
    if (handle) targets.add(handle);
  }
  for (const handle of extractHandles(entity.about)) targets.add(handle);
  targets.delete(entity.username.toLowerCase());
  return targets;
}

function domainsOf(input: DedupeInput): Set<string> {
  const domains = new Set<string>();
  if (input.classification.website) {
    const domain = businessDomainOf(input.classification.website);
    if (domain) domains.add(domain);
  }
  for (const domain of input.domains ?? []) domains.add(domain);
  return domains;
}

const KIND_PRIORITY = { bot: 0, channel: 1, group: 2 } as const;

function primaryOf(members: DedupeInput[]): DedupeInput {
  return [...members].sort((left, right) => {
    const app =
      Number(right.entity.hasMainApp) - Number(left.entity.hasMainApp);
    if (app !== 0) return app;
    const reach =
      (right.entity.participants ?? right.entity.botActiveUsers ?? 0) -
      (left.entity.participants ?? left.entity.botActiveUsers ?? 0);
    if (reach !== 0) return reach;
    return KIND_PRIORITY[left.entity.kind] - KIND_PRIORITY[right.entity.kind];
  })[0] as DedupeInput;
}

export function groupBusinesses(inputs: DedupeInput[]): BusinessLead[] {
  const parent = inputs.map((_, index) => index);
  const reasons = new Map<number, string[]>();
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    parent[index] = root;
    return root;
  };
  const union = (left: number, right: number, reason: string) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    parent[b] = a;
    reasons.set(a, [
      ...(reasons.get(a) ?? []),
      ...(reasons.get(b) ?? []),
      reason,
    ]);
  };

  const byHandle = new Map(
    inputs.map((input, index) => [input.entity.username.toLowerCase(), index]),
  );
  const byDomain = new Map<string, number>();
  inputs.forEach((input, index) => {
    for (const domain of domainsOf(input)) {
      const seen = byDomain.get(domain);
      if (seen === undefined) byDomain.set(domain, index);
      else union(seen, index, `same website ${domain}`);
    }
  });

  inputs.forEach((input, index) => {
    for (const target of profileTargets(input.entity)) {
      const other = byHandle.get(target);
      if (other === undefined || other === index) continue;
      const otherInput = inputs[other] as DedupeInput;
      const mutual = profileTargets(otherInput.entity).has(
        input.entity.username.toLowerCase(),
      );
      if (mutual)
        union(
          index,
          other,
          `@${input.entity.username} and @${otherInput.entity.username} link to each other`,
        );
      else if (similarNames(input.entity, otherInput.entity))
        union(
          index,
          other,
          `@${input.entity.username} links to @${otherInput.entity.username} with a matching name`,
        );
    }
  });

  const groups = new Map<number, DedupeInput[]>();
  inputs.forEach((input, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), input]);
  });

  return [...groups].map(([root, members]) => {
    const primary = primaryOf(members);
    return {
      key: primary.entity.username.toLowerCase(),
      entityIds: members.map((member) => member.entity.id),
      primary: primary.entity.id,
      mergeReasons: [...new Set(reasons.get(root) ?? [])],
    };
  });
}
