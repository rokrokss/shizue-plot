/** Client-side helpers for the relationship gauges. */

import { RELATIONSHIP_AXES, type ChatRelationship, type RelationshipAxis } from './types';

interface RelationshipRow {
  axis: RelationshipAxis;
  /** 0-100, used both as the label and as the gauge width. */
  value: number;
}

/**
 * The API clamps what the model returns, but a gauge must never overflow its
 * track, so whatever arrives is clamped again here.
 */
export function gaugeValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** One row per axis in display order, or none while no extraction has landed. */
export function relationshipRows(relationship: ChatRelationship | null): RelationshipRow[] {
  const axes = relationship?.axes;
  if (!axes) return [];
  return RELATIONSHIP_AXES.map((axis) => ({ axis, value: gaugeValue(axes[axis]) }));
}
