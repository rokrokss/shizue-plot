import type { ModelCapabilities, ModelParams } from '@shizue/llm';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * What a credential is: an API key (`api_key`), the owner's ChatGPT connection
 * (`chatgpt`), and the kinds RisuAI's other formats take — AWS keys, a Google
 * service account, a bare token.
 */
export type CredentialKind = 'api_key' | 'chatgpt' | 'aws' | 'gcp_service_account' | 'token';

/**
 * The ChatGPT connection's facts that are not secret: the account's `sub`, the
 * registration OpenAI issued for it (reused on the next connection, and kept
 * through a disconnect), and the scope its tokens carry.
 */
export interface CredentialMeta {
  subject?: string;
  clientId?: string;
  scope?: string;
}

// A secret the owner gave for model calls: an API key, or the ChatGPT
// connection's tokens. `secrets` holds each secret field sealed on its own with
// the install's token cipher (`tokenCipher` in the API, `v1.iv.body.tag`) —
// `{apiKey}` for a key, `{accessToken, refreshToken, idToken}` for ChatGPT — and
// never leaves the server; `hint` is what the page shows of it. A key goes only
// to `base_url`, or its provider's own address when that is null. One ChatGPT
// connection per owner. Written from this computer only (`requireLocal`).
export const credentials = pgTable(
  'credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<CredentialKind>().notNull(),
    // `@shizue/llm` `PROVIDERS`: openai, anthropic, google, openrouter, …, custom; `chatgpt` for the connection.
    provider: text('provider').notNull(),
    label: text('label').notNull().default(''),
    baseUrl: text('base_url'),
    secrets: jsonb('secrets').$type<Record<string, string>>().notNull().default({}),
    meta: jsonb('meta').$type<CredentialMeta>().notNull().default({}),
    hint: text('hint').notNull().default(''),
    // When the stored access token stops being good (the ChatGPT connection's); null for a key.
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credentials_user_id_idx').on(t.userId),
    uniqueIndex('credentials_one_chatgpt_idx').on(t.userId).where(sql`${t.kind} = 'chatgpt'`),
  ],
);

// A model preset, PocketRisu's: a request format (`@shizue/llm` `FORMATS`, RisuAI's
// `LLMFormat` by string ids), the model it names, the credential it authenticates
// with (null: a keyless server at `endpoint`), and the values every request on it
// carries. Separate from the prompt presets; a chat binds one as its main model
// and one as its sub (`chats.model_binding`), the owner's default binding
// (`user.model_binding`) standing in for a slot a chat leaves open.
export const modelPresets = pgTable(
  'model_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    format: text('format').notNull(),
    // A keyless preset's address (LM Studio, Ollama's `/v1`); a keyed one goes to its credential's.
    endpoint: text('endpoint'),
    // The provider's own model id.
    model: text('model').notNull().default(''),
    credentialId: uuid('credential_id').references(() => credentials.id, { onDelete: 'set null' }),
    params: jsonb('params').$type<ModelParams>().notNull().default({}),
    capabilities: jsonb('capabilities').$type<ModelCapabilities>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('model_presets_user_id_idx').on(t.userId, t.createdAt)],
);

export type Credential = typeof credentials.$inferSelect;
export type ModelPreset = typeof modelPresets.$inferSelect;
