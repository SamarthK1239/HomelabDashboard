import {
  Activity,
  Boxes,
  CircleCheck,
  CircleHelp,
  Clock,
  Container,
  Cpu,
  HardDrive,
  MemoryStick,
  Microchip,
  OctagonAlert,
  PackageCheck,
  Sparkles,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type { Status } from '../types';

/**
 * Collector identity icons.
 *
 * An icon is the fastest identifier a human can resolve at distance — faster
 * than a word, and language independent. Every card carries one so the grid
 * can be scanned by shape before it is read.
 *
 * Unknown collectors fall back to `Activity` rather than rendering nothing, so
 * a brand new backend collector still looks deliberate before anyone writes a
 * bespoke card for it.
 */
const COLLECTOR_ICONS: Record<string, LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  disk: HardDrive,
  docker: Container,
  gpu: Microchip,
  llama: Sparkles,
  power: Zap,
  uptime: Clock,
  updates: PackageCheck,
  containers: Boxes,
};

export function iconForCollector(name: string): LucideIcon {
  return COLLECTOR_ICONS[name] ?? Activity;
}

/**
 * Status glyphs.
 *
 * Status must never be carried by colour alone: roughly 1 in 12 men cannot
 * reliably separate the green and the amber, and a wall display is often read
 * at an angle or through a glare that flattens hue further. Each severity
 * therefore gets a distinct *silhouette* — circle, triangle, octagon, hollow
 * circle — which survives both colour blindness and a bad viewing angle.
 */
const STATUS_ICONS: Record<Status, LucideIcon> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  critical: OctagonAlert,
  unknown: CircleHelp,
};

export function iconForStatus(status: Status): LucideIcon {
  return STATUS_ICONS[status];
}

export type { LucideIcon };

/* -------------------------------------------------------------------------- */
/*                              Rendering helpers                             */
/* -------------------------------------------------------------------------- */

export interface GlyphProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/**
 * Renders a collector's identity glyph.
 *
 * Call sites could resolve the icon and render it themselves, but assigning a
 * component to a local during render trips static-analysis rules that cannot
 * tell a lookup in a frozen registry from a component defined inline. Wrapping
 * the lookup keeps the call sites declarative and the linting honest.
 */
export function CollectorIcon({
  name,
  size = 16,
  strokeWidth = 2,
  className,
}: GlyphProps & { name: string }) {
  const Icon = COLLECTOR_ICONS[name] ?? Activity;
  return <Icon size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />;
}

/** Renders the glyph for a severity. See `STATUS_ICONS` for why shape matters. */
export function StatusGlyph({
  status,
  size = 16,
  strokeWidth = 2,
  className,
}: GlyphProps & { status: Status }) {
  const Icon = STATUS_ICONS[status];
  return <Icon size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />;
}
