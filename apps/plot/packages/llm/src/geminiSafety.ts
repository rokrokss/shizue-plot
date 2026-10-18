/**
 * RisuAI's `uncensoredCatagory` (`src/ts/process/request/google.ts`): every
 * category the Gemini API filters on, at BLOCK_NONE, as RisuAI sends for every
 * current Gemini model. The `google` format sends it on custom presets, and a
 * new profile preset whose profile has a `safetySettings` field starts with it
 * (`withSafetyDefault`) — PocketRisu sends none, and the owner chose RisuAI's
 * (2026-10-19).
 */
export const GEMINI_SAFETY = [
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));
