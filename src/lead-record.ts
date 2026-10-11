import { z } from "zod";
import {
  canonicalTelegramHandle,
  normalizeEvidenceUrl,
  publicHttpUrl,
} from "./canonical.js";

/**
 * The exported lead: an evidence-first record in which every fact, contact and
 * claim must cite a source URL that is itself listed in `sources`. A lead that
 * fails these checks is not emitted; it is reported as a lead error instead.
 */

const publicUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine(publicHttpUrl, "Evidence URLs must be public HTTP(S) URLs");

const sourceSchema = z
  .object({
    url: publicUrlSchema,
    label: z.string().trim().min(1).max(200),
    retrievedAt: z.string().datetime(),
  })
  .strict();

const claimSchema = z
  .object({
    value: z.string().trim().min(1).max(1000),
    sourceUrl: publicUrlSchema,
    confidence: z.number().int().min(0).max(100),
  })
  .strict();

const factSchema = claimSchema.extend({
  key: z.string().trim().min(1).max(80),
});

const contactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("email"),
      value: z.string().trim().email().max(320),
      sourceUrl: publicUrlSchema,
      contactName: z.string().trim().min(1).max(160).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("telegram"),
      value: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .refine(
          (value) => canonicalTelegramHandle(value) !== null,
          "Telegram contact must be an @handle or public t.me URL",
        ),
      sourceUrl: publicUrlSchema,
      contactName: z.string().trim().min(1).max(160).optional(),
    })
    .strict(),
]);

const optionalPublicUrl = z.union([publicUrlSchema, z.literal("")]).optional();

export const leadRecordSchema = z
  .object({
    type: z.string().trim().min(1).max(40).default("advertiser"),
    project: z.string().trim().min(1).max(160),
    segment: z.string().trim().min(1).max(100),
    website: optionalPublicUrl,
    telegramUrl: optionalPublicUrl,
    publicContacts: z.array(contactSchema).max(10).default([]),
    sources: z.array(sourceSchema).min(1).max(20),
    verifiedFacts: z.array(factSchema).min(1).max(26),
    audienceDescription: claimSchema,
    likelyAcquisitionNeed: claimSchema,
    whyProductFits: claimSchema,
    confidence: z.number().int().min(0).max(100),
    language: z.string().trim().min(2).max(12).default("en"),
    country: z.string().trim().max(80).optional().default(""),
    estimatedSize: z.string().trim().max(100).optional().default(""),
    notes: z.string().trim().max(1500).optional().default(""),
  })
  .strict()
  .superRefine((lead, context) => {
    if (lead.sources.some((source) => !publicHttpUrl(source.url))) return;
    const sourceUrls = new Set(
      lead.sources.map((source) => normalizeEvidenceUrl(source.url)),
    );
    if (sourceUrls.size !== lead.sources.length)
      context.addIssue({
        code: "custom",
        path: ["sources"],
        message: "Source URLs must be unique",
      });

    const references: Array<{ path: Array<string | number>; url: string }> = [
      ...lead.verifiedFacts.map((fact, index) => ({
        path: ["verifiedFacts", index, "sourceUrl"],
        url: fact.sourceUrl,
      })),
      ...lead.publicContacts.map((contact, index) => ({
        path: ["publicContacts", index, "sourceUrl"],
        url: contact.sourceUrl,
      })),
      {
        path: ["audienceDescription", "sourceUrl"],
        url: lead.audienceDescription.sourceUrl,
      },
      {
        path: ["likelyAcquisitionNeed", "sourceUrl"],
        url: lead.likelyAcquisitionNeed.sourceUrl,
      },
      {
        path: ["whyProductFits", "sourceUrl"],
        url: lead.whyProductFits.sourceUrl,
      },
    ];
    if (lead.website) references.push({ path: ["website"], url: lead.website });
    if (lead.telegramUrl)
      references.push({ path: ["telegramUrl"], url: lead.telegramUrl });

    for (const reference of references) {
      if (!publicHttpUrl(reference.url)) continue;
      if (!sourceUrls.has(normalizeEvidenceUrl(reference.url)))
        context.addIssue({
          code: "custom",
          path: reference.path,
          message:
            "Every material fact and public contact must reference a listed source URL",
        });
    }

    if (!lead.website && !lead.telegramUrl && lead.publicContacts.length === 0)
      context.addIssue({
        code: "custom",
        path: ["publicContacts"],
        message:
          "Lead must have a public website, Telegram URL, or sourced public contact",
      });
  });

export const leadBatchSchema = z
  .object({
    version: z.literal(1),
    batchId: z.string().trim().min(1).max(100),
    researchedAt: z.string().datetime(),
    leads: z.array(leadRecordSchema).min(1).max(500),
  })
  .strict();

export type LeadRecord = z.infer<typeof leadRecordSchema>;
export type LeadBatch = z.infer<typeof leadBatchSchema>;
