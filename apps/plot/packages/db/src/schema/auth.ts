import type { ModelBinding } from '@shizue/llm';
import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// The tables of the better-auth library shizue once signed readers in with, kept
// in its shape: `user` holds the one owner (every `user_id` column points at it),
// `session` paired phones' sessions, and `verification` ChatGPT connection
// attempts and pairing codes (ARCHITECTURE §4.1, §5). The ChatGPT connection
// itself is a `credentials` row (`models.ts`).

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  // The app's default model binding (PocketRisu's): the presets a chat runs on
  // where its own `chats.model_binding` leaves a slot open. Null is none.
  modelBinding: jsonb('model_binding').$type<ModelBinding>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
