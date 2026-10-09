export interface Target { origin: string; loopbackPort: number }
export const CALLBACK_PATH: string;
export const DEFAULT_TARGETS: Target[];
export const KEY: string;
export function buildFiles(targets: Target[]): {
  manifest: {
    host_permissions: string[];
    externally_connectable: { matches: string[] };
    [key: string]: unknown;
  };
  rules: {
    id: number;
    condition: { urlFilter: string; resourceTypes: string[] };
    action: { type: 'redirect'; redirect: { transform: { scheme: string; host: string; port: string; path: string } } };
  }[];
};
export function writeVariant(out: string, targets: Target[]): Promise<void>;
