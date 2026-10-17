/**
 * Images one message may carry. Mirrors MAX_ATTACHMENTS_PER_MESSAGE in the API;
 * a SillyTavern import brings no more than this onto a message
 * (`lib/sillytavern/import`). The composer attaches none (2026-10-17).
 */
export const MAX_ATTACHMENTS = 4;
