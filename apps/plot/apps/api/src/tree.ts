import type { Message } from '@shizue/db';

export interface SiblingInfo {
  /** 0-based position among the messages sharing this parent. */
  index: number;
  total: number;
  /** The sibling group's ids, in the order `index` refers to. */
  ids: string[];
}

/** Oldest first; ties broken by id so ordering is stable. */
function byCreation(a: Message, b: Message): number {
  const delta = a.createdAt.getTime() - b.createdAt.getTime();
  return delta !== 0 ? delta : a.id.localeCompare(b.id);
}

/** Messages grouped by parent id ('' for roots), each group oldest first. */
function groupByParent(all: Message[]): Map<string, Message[]> {
  const groups = new Map<string, Message[]>();
  for (const message of all) {
    const key = message.parentId ?? '';
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }
  for (const group of groups.values()) group.sort(byCreation);
  return groups;
}

/** Walks head → root through the parent chain and returns the path oldest first. */
export function buildPath(all: Message[], headId: string | null): Message[] {
  if (!headId) return [];
  const byId = new Map(all.map((message) => [message.id, message]));
  const path: Message[] = [];
  let current = byId.get(headId);
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

/** Position/count among siblings for every message on the path. */
export function siblingInfo(all: Message[], path: Message[]): Record<string, SiblingInfo> {
  const groups = groupByParent(all);
  const info: Record<string, SiblingInfo> = {};
  for (const message of path) {
    const group = groups.get(message.parentId ?? '') ?? [message];
    const ids = group.map((sibling) => sibling.id);
    info[message.id] = { index: ids.indexOf(message.id), total: ids.length, ids };
  }
  return info;
}

/** Deepest leaf under `messageId`, following the newest child at each level. */
export function deepestLeaf(all: Message[], messageId: string): string {
  const groups = groupByParent(all);
  let current = messageId;
  for (;;) {
    const children = groups.get(current);
    if (!children || children.length === 0) return current;
    current = children[children.length - 1]!.id;
  }
}
