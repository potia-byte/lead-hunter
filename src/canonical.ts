/**
 * Canonical forms for Telegram handles, registrable domains and emails.
 * Extracted from the monorepo's shared package; behaviour is unchanged. The
 * suffix tables are a small hand-kept subset, not the full Public Suffix List.
 */


interface RuntimeUrl {
  hash: string;
  hostname: string;
  pathname: string;
  protocol: string;
  readonly searchParams: { get(name: string): string | null };
  toString(): string;
}

const RuntimeUrl = (
  globalThis as unknown as { URL: new (value: string) => RuntimeUrl }
).URL;

const COUNTRY_CODE_SECOND_LEVEL_SUFFIXES = new Set([
  "ac",
  "asn",
  "co",
  "com",
  "edu",
  "firm",
  "gen",
  "go",
  "gov",
  "id",
  "ind",
  "mil",
  "ne",
  "net",
  "nom",
  "or",
  "org",
  "sch",
]);

// Tenant hosts under these Public Suffix List private domains are separate
// identities. This task cannot add a PSL dependency because dependency manifests
// are outside its allowed paths, so keep the task-relevant hosted suffixes here.
const PRIVATE_TENANT_SUFFIXES = new Set([
  "appspot.com",
  "azurewebsites.net",
  "blogspot.com",
  "carrd.co",
  "cloudfront.net",
  "firebaseapp.com",
  "github.io",
  "gitlab.io",
  "herokuapp.com",
  "netlify.app",
  "notion.site",
  "onrender.com",
  "pages.dev",
  "readthedocs.io",
  "surge.sh",
  "vercel.app",
  "web.app",
  "workers.dev",
  "wordpress.com",
]);

const NON_PUBLIC_HOSTNAME_SUFFIXES = new Set([
  "example",
  "home.arpa",
  "internal",
  "invalid",
  "lan",
  "local",
  "localdomain",
  "localhost",
  "test",
]);

const TELEGRAM_HOSTS = new Set([
  "t.me",
  "telegram.me",
  "telegram.dog",
  "www.t.me",
  "www.telegram.me",
  "www.telegram.dog",
]);


export function normalizeEvidenceUrl(value: string): string {
  const url = new RuntimeUrl(value.trim());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

export function canonicalTelegramHandle(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  let candidate = trimmed.replace(/^@/, "");
  try {
    const url = new RuntimeUrl(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    if (url.protocol === "tg:") {
      if (url.hostname !== "resolve") return null;
      candidate = url.searchParams.get("domain") ?? "";
    } else if (TELEGRAM_HOSTS.has(normalizedHostname(url.hostname))) {
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const parts = url.pathname.split("/").filter(Boolean);
      candidate =
        parts[0]?.toLowerCase() === "s" ? (parts[1] ?? "") : (parts[0] ?? "");
    } else if (trimmed.includes("://") || trimmed.includes("/")) {
      return null;
    }
  } catch {
    return null;
  }

  candidate = candidate.replace(/^@/, "").toLowerCase();
  if (!/^[a-z\d_]{3,64}$/.test(candidate)) return null;
  if (["addstickers", "joinchat", "share"].includes(candidate)) return null;
  return candidate;
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function isPublicHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  if (!normalized || isIpAddress(normalized)) return false;

  const labels = normalized.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    return false;
  }

  return ![...NON_PUBLIC_HOSTNAME_SUFFIXES].some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

/**
 * Resolves a hostname to its registrable domain (the identity two unrelated
 * tenants can never share), taking three-label suffixes into account: a
 * "direct-registration" ccTLD second-level suffix (co.uk, com.au, ...) or a
 * private/hosting suffix (vercel.app, github.io, ...) both mean the
 * *third*-from-last label is what's actually registrable -- treating either
 * as an ordinary two-label suffix would collapse distinct tenants (e.g.
 * alpha.co.za and beta.co.za, or foo.vercel.app and bar.vercel.app) into one
 * false duplicate identity.
 */
export function canonicalRegistrableHostname(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return null;

  let hostname: string;
  try {
    hostname = new RuntimeUrl(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`,
    ).hostname;
  } catch {
    return null;
  }
  // Resolve the suffix before dropping subdomains: www can be a tenant name.
  hostname = normalizedHostname(hostname);
  if (!isPublicHostname(hostname)) {
    return null;
  }

  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  const topLevelLabel = labels.at(-1) ?? "";
  const secondLevelLabel = labels.at(-2) ?? "";
  const lastTwoLabels = labels.slice(-2).join(".");
  const suffixLabelCount =
    PRIVATE_TENANT_SUFFIXES.has(lastTwoLabels) ||
    (topLevelLabel.length === 2 &&
      COUNTRY_CODE_SECOND_LEVEL_SUFFIXES.has(secondLevelLabel))
      ? 2
      : 1;
  const registrableLabelCount = suffixLabelCount + 1;
  return labels.slice(-registrableLabelCount).join(".");
}

export function canonicalBusinessEmail(
  value: string | null | undefined,
): string | null {
  const normalized = value
    ?.trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

export function publicHttpUrl(value: string): boolean {
  try {
    const url = new RuntimeUrl(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isPublicHostname(url.hostname)
    );
  } catch {
    return false;
  }
}
