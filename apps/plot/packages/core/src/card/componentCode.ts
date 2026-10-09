/**
 * Card interop for the Layer 2 component code.
 *
 * Display scripts had somewhere to go — RisuAI already defines
 * `extensions.risuai.customScripts`, so an exported card lands where an importing
 * client looks. A JSX component has no such prior art: CCv3 defines where a card
 * may *store* code and says nothing about what running it means, and Elyn does not
 * publish a card format at all. So it goes under our own namespace, next to
 * everything else the card carries, and every other extension key is left exactly
 * as it arrived.
 */

import { MAX_COMPONENT_CODE_LENGTH } from '../component.js';
import { COMPONENT_CAPABILITIES, type ComponentCapability } from '../types.js';

/** Extension namespace for the fields only this platform understands. */
export const SHIZUE_EXTENSION = 'shizue';

/**
 * Reads `extensions.shizue.componentCode` off an imported card.
 *
 * The size cap is enforced here rather than only where the editor saves, because
 * a card comes from a stranger and import is the path that does not pass through
 * the editor at all. An oversized field is dropped and the rest of the card is
 * kept — the same shape as the hazardous-pattern rule, which imports a script
 * switched off instead of refusing the card. It matters because the card is jsonb
 * that every reader of a published character downloads and scans.
 */
export function componentCodeFromExtensions(
  extensions: Record<string, unknown>,
): string | undefined {
  const shizue = extensions[SHIZUE_EXTENSION];
  if (shizue === null || typeof shizue !== 'object') return undefined;
  const code = (shizue as Record<string, unknown>)['componentCode'];
  if (typeof code !== 'string' || !code.trim()) return undefined;
  return code.length > MAX_COMPONENT_CODE_LENGTH ? undefined : code;
}

/**
 * Reads `extensions.shizue.componentCapabilities`.
 *
 * An unknown capability is dropped rather than kept: a card names what it wants,
 * and this build either understands the name or does not grant anything for it.
 */
export function componentCapabilitiesFromExtensions(
  extensions: Record<string, unknown>,
): ComponentCapability[] | undefined {
  const shizue = extensions[SHIZUE_EXTENSION];
  if (shizue === null || typeof shizue !== 'object') return undefined;
  const value = (shizue as Record<string, unknown>)['componentCapabilities'];
  if (!Array.isArray(value)) return undefined;
  const capabilities = COMPONENT_CAPABILITIES.filter((capability) => value.includes(capability));
  return capabilities.length > 0 ? capabilities : undefined;
}

/** Writes both back into a copy of the extensions, dropping the keys when unset. */
export function extensionsWithComponentCode(
  extensions: Record<string, unknown>,
  componentCode: string | undefined,
  componentCapabilities?: ComponentCapability[],
): Record<string, unknown> {
  const previous = extensions[SHIZUE_EXTENSION];
  const shizue: Record<string, unknown> =
    previous !== null && typeof previous === 'object'
      ? { ...(previous as Record<string, unknown>) }
      : {};

  if (componentCode && componentCode.trim()) shizue['componentCode'] = componentCode;
  else delete shizue['componentCode'];

  if (componentCapabilities && componentCapabilities.length > 0) {
    shizue['componentCapabilities'] = [...componentCapabilities];
  } else delete shizue['componentCapabilities'];

  const next = { ...extensions };
  if (Object.keys(shizue).length > 0) next[SHIZUE_EXTENSION] = shizue;
  else delete next[SHIZUE_EXTENSION];
  return next;
}
