import type { ComponentType } from 'react';

import { CpuCard } from './CpuCard';
import { DiskCard } from './DiskCard';
import { DockerCard } from './DockerCard';
import { GpuCard } from './GpuCard';
import { LlamaCard } from './LlamaCard';
import { MemoryCard } from './MemoryCard';
import { UpdatesCard } from './UpdatesCard';
import { UptimeCard } from './UptimeCard';
import type { CardProps } from './types';

export type { CardProps } from './types';

/**
 * Bespoke cards, keyed by the collector's `name` (the same key used in
 * `/api/snapshot`'s `collectors` object and in `/api/meta`'s `intervals`).
 *
 * ---------------------------------------------------------------------------
 * ADDING A CARD
 * ---------------------------------------------------------------------------
 * 1. Create `src/components/cards/<Name>Card.tsx` exporting a component typed
 *    as `({ result, meta, refreshSeconds }: CardProps) => ReactNode`.
 * 2. Wrap the body in the shared `<Card>` chrome from `src/components/Card.tsx`
 *    so the title, status accent, age counter, error state and stale treatment
 *    stay consistent:
 *
 *      import { Card } from '../Card';
 *      import { formatPercent } from '../../format';
 *      import type { CardProps } from './types';
 *
 *      export function CpuCard({ result }: CardProps) {
 *        const data = result.data as { percent?: number | null };
 *        return (
 *          <Card title="CPU" result={result}>
 *            {formatPercent(data.percent)}
 *          </Card>
 *        );
 *      }
 *
 *    Passing `result` gives the chrome the status accent, the age counter, the
 *    error banner and the stale treatment for free.
 *
 * 3. Add one line below. That import plus this map is the ONLY wiring needed —
 *    `App.tsx` reads the registry and falls back to `GenericCard` for anything
 *    missing, so a brand new backend collector is visible with real data before
 *    anyone writes a card for it.
 *
 * Keep keys lowercase and exactly equal to the backend collector name:
 * cpu, memory, disk, docker, gpu, llama, updates, uptime.
 */
export const CARD_REGISTRY: Record<string, ComponentType<CardProps>> = {
  llama: LlamaCard,
  gpu: GpuCard,
  cpu: CpuCard,
  memory: MemoryCard,
  disk: DiskCard,
  docker: DockerCard,
  uptime: UptimeCard,
  updates: UpdatesCard,
};

/**
 * Preferred left-to-right / top-to-bottom ordering of cards in the grid.
 * Collectors not listed here are appended alphabetically, so new backend
 * collectors still appear without editing this file.
 */
export const COLLECTOR_ORDER: readonly string[] = [
  'llama',
  'gpu',
  'cpu',
  'memory',
  'disk',
  'docker',
  'uptime',
  'updates',
];

/** The bespoke card for a collector, or `undefined` to use `GenericCard`. */
export function cardFor(name: string): ComponentType<CardProps> | undefined {
  return CARD_REGISTRY[name];
}

/** Sort collector names by `COLLECTOR_ORDER`, unknown names alphabetically last. */
export function orderCollectors(names: readonly string[]): string[] {
  const rank = (name: string) => {
    const index = COLLECTOR_ORDER.indexOf(name);
    return index === -1 ? COLLECTOR_ORDER.length : index;
  };
  return [...names].sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
}
