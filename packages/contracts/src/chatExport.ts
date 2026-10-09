/**
 * Chat export — PLATFORM.md — chat export. `GET /api/chats/:id/export`, owner only.
 *
 * A chat belongs to a plot, and the plot's whole roster plus its narrator speak
 * inside it, so the conversation is exported against the plot and the members are
 * named alongside it.
 *
 * Rights boundary: the user's own conversation text plus the assets the plot
 * published. Plot and card internals (description, lorebook, system prompt) never
 * enter this payload — the schema has no field to carry them.
 *
 * Timestamps are left loose in the doc; they are ISO 8601 strings here so both
 * sides parse the same thing over JSON.
 */
import { z } from 'zod';

/**
 * An image the reader attached to their own turn. Same-origin like an asset url,
 * and fetched with the session cookie — but the reader's own picture rather than
 * the creator's, so it is carried on the message and never withdrawn with the
 * plot.
 */
export const ChatExportAttachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  mime: z.string(),
});

export const ChatExportMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: z.string(), // ISO 8601
  /** `component` marks a turn a custom-UI component sent on the user's behalf. */
  source: z.enum(['user', 'component']).optional(),
  /** Absent on every turn that carries no image, which is nearly all of them. */
  attachments: z.array(ChatExportAttachmentSchema).optional(),
});

/** `url` is a same-origin path, so the importer fetches it with the session cookie. */
export const ChatExportAssetSchema = z.object({
  slug: z.string(),
  url: z.string(),
  mime: z.string(),
});

/** Path-derived variable fold at one assistant message; unchanged steps may be omitted. */
export const ChatExportVariableSnapshotSchema = z.object({
  messageId: z.string(),
  variables: z.record(z.string(), z.string()),
});

/**
 * One member of the plot's roster, so an importer can tell whose lines are whose:
 * the name is the speaker prefix the transcript carries. Nothing of the card
 * travels with it — a name and a picture are what a reader already saw.
 */
export const ChatExportCharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});

export const ChatExportSchema = z.object({
  version: z.literal(1),
  chat: z.object({
    id: z.string(),
    plotId: z.string(),
    plotName: z.string(),
    exportedAt: z.string(), // ISO 8601
  }),
  messages: z.array(ChatExportMessageSchema),
  assets: z.array(ChatExportAssetSchema),
  /**
   * The roster, in the creator's order. Empty when the plot is no longer
   * readable — the same revocation the assets take, since both are the creator's
   * contribution rather than the reader's.
   */
  characters: z.array(ChatExportCharacterSchema),
  /** The plot's cover. Null when it has none, and when the plot is withdrawn. */
  coverUrl: z.string().nullable(),
  variableTimeline: z.array(ChatExportVariableSnapshotSchema),
});

export type ChatExportAttachment = z.infer<typeof ChatExportAttachmentSchema>;
export type ChatExportMessage = z.infer<typeof ChatExportMessageSchema>;
export type ChatExportAsset = z.infer<typeof ChatExportAssetSchema>;
export type ChatExportCharacter = z.infer<typeof ChatExportCharacterSchema>;
export type ChatExportVariableSnapshot = z.infer<typeof ChatExportVariableSnapshotSchema>;
export type ChatExport = z.infer<typeof ChatExportSchema>;
