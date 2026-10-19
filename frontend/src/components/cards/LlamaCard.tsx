import type { ReactNode } from 'react';

import { Card } from '../Card';
import { Sparkline } from '../Sparkline';
import { useHistory } from '../../hooks/useHistory';
import {
  EM_DASH,
  formatBytes,
  formatDuration,
  formatMilliseconds,
  formatNumber,
  formatPercent,
  isFiniteNumber,
  isPlainObject,
  truncate,
} from '../../format';
import type { Status } from '../../types';
import type { CardProps } from './types';
import './ai-cards.css';

/* ------------------------------ narrowing -------------------------------- */

type Dict = Record<string, unknown>;

function record(value: unknown): Dict {
  return isPlainObject(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* ------------------------------ formatting ------------------------------- */

/** 262144 -> "256K"; keeps the exact count for the tooltip. */
function contextLabel(value: unknown): { short: string; full: string } | null {
  const size = num(value);
  if (size === null || size <= 0) return null;
  const full = `${formatNumber(size, 0)} tokens`;
  if (size % (1024 * 1024) === 0) return { short: `${size / (1024 * 1024)}M`, full };
  if (size % 1024 === 0) return { short: `${size / 1024}K`, full };
  return { short: formatNumber(size, 0), full };
}

/** 27320697856 -> "27.3B". Used for parameter and token counters. */
function compactCount(value: unknown): string {
  const amount = num(value);
  if (amount === null) return EM_DASH;
  const abs = Math.abs(amount);
  if (abs >= 1e12) return `${(amount / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(amount / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(amount / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(amount / 1e3).toFixed(1)}K`;
  return formatNumber(amount, 0);
}

/* --------------------------------- state --------------------------------- */

/**
 * llama.cpp is two independent layers and they fail differently.
 *
 * "container running but HTTP silent" is the normal transitional state while a
 * large model is mapped into VRAM (minutes for a 27B at 256K context), so it is
 * reported as `loading` — a waiting state, not a failure.
 */
type Phase = 'serving' | 'loading' | 'http-error' | 'container-down' | 'unknown';

const PHASE_LABEL: Record<Phase, string> = {
  serving: 'Serving',
  loading: 'Loading model…',
  'http-error': 'HTTP not healthy',
  'container-down': 'Container stopped',
  unknown: 'Unknown',
};

const PHASE_STATUS: Record<Phase, Status> = {
  serving: 'ok',
  loading: 'warn',
  'http-error': 'critical',
  'container-down': 'critical',
  unknown: 'unknown',
};

interface Cell {
  label: string;
  value: ReactNode;
  title?: string;
}

function MetricGrid({ cells }: { cells: readonly Cell[] }) {
  if (cells.length === 0) return null;
  return (
    <dl className="ai-grid">
      {cells.map((cell) => (
        <div className="ai-cell" key={cell.label}>
          <dt className="ai-label">{cell.label}</dt>
          <dd className="ai-value" title={cell.title}>
            {cell.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function LlamaCard({ result, refreshSeconds }: CardProps) {
  const data = record(result.data);

  const health = record(data.health);
  const model = record(data.model);
  const slots = record(data.slots);
  const metrics = record(data.metrics);
  const container = record(data.container);
  const models = list(record(data.models).models);
  const firstModel = record(models[0]);

  const latency = useHistory('llama.health_latency_ms', { refreshSeconds });

  const healthy = data.healthy === true;
  const reachable = data.reachable === true;
  const containerKnown = container.available === true && container.exists === true;
  const containerRunning = container.running === true;
  const containerState = text(container.state);

  let phase: Phase;
  if (healthy) phase = 'serving';
  else if (containerKnown && containerRunning) phase = reachable ? 'http-error' : 'loading';
  else if (containerKnown) phase = 'container-down';
  else if (reachable || containerRunning) phase = 'http-error';
  else phase = 'unknown';

  const generating = data.generating === true;
  const busySlots = num(data.busy_slots) ?? num(slots.busy);
  const totalSlots = num(data.total_slots) ?? num(slots.total);
  const slotList = list(slots.slots);

  // Prefer the real slot list; fall back to synthesising pips from the counts
  // so the activity row still works on a server with /slots disabled.
  const pips: { id: number; busy: boolean; state: string }[] =
    slotList.length > 0
      ? slotList.map((entry, index) => {
          const slot = record(entry);
          const state = text(slot.state) ?? (slot.processing === true ? 'processing' : 'idle');
          return { id: num(slot.id) ?? index, busy: slot.processing === true || state === 'processing', state };
        })
      : Array.from({ length: Math.max(0, Math.round(totalSlots ?? 0)) }, (_, index) => ({
          id: index,
          busy: index < Math.round(busySlots ?? 0),
          state: index < Math.round(busySlots ?? 0) ? 'processing' : 'idle',
        }));

  const ctx = contextLabel(model.context_size ?? firstModel.n_ctx);
  const modelName = text(model.name) ?? text(firstModel.name);
  const ftype = text(model.ftype) ?? text(firstModel.ftype);
  const ggufFile = text(model.file) ?? (text(model.path)?.split('/').pop() ?? null);

  const statusCode = num(health.status_code);
  const httpLabel = healthy
    ? `ok${statusCode !== null ? ` · ${statusCode}` : ''}`
    : reachable
      ? `${text(health.status) ?? 'error'}${statusCode !== null ? ` · ${statusCode}` : ''}`
      : 'no answer';

  const metricsAvailable = metrics.available === true;
  const metricValues = record(metrics.values);

  const subtitleParts = [modelName, ftype, ctx ? `${ctx.short} ctx` : null].filter(
    (part): part is string => Boolean(part),
  );

  const footerParts = [text(data.build_info), text(data.url)?.replace(/^https?:\/\//, '')].filter(
    (part): part is string => Boolean(part),
  );

  return (
    <Card
      title="LLM Server"
      result={result}
      subtitle={subtitleParts.length > 0 ? subtitleParts.join(' · ') : 'no model loaded'}
      footer={footerParts.length > 0 ? footerParts.join(' · ') : null}
    >
      <div className="ai-stack">
        <div className="ai-llm-state" data-phase={phase} data-status={PHASE_STATUS[phase]}>
          <span
            className={generating ? 'ai-dot ai-dot--pulse' : 'ai-dot'}
            data-status={PHASE_STATUS[phase]}
            aria-hidden="true"
          />
          <div className="ai-llm-state__body">
            <strong className="ai-llm-state__label">{PHASE_LABEL[phase]}</strong>
            {phase === 'loading' ? (
              <p className="ai-note">
                container is up but HTTP is not answering yet — a large model can take minutes to load
              </p>
            ) : null}
            {phase === 'http-error' && text(health.status) ? (
              <p className="ai-note">server answered “{truncate(text(health.status) ?? '', 60)}”</p>
            ) : null}
            {phase === 'container-down' ? (
              <p className="ai-note">container state is {containerState ?? EM_DASH}</p>
            ) : null}
            {data.is_sleeping === true ? <p className="ai-note">model is sleeping (weights offloaded)</p> : null}
          </div>
        </div>

        <div className="ai-llm-layers">
          <div className="ai-layer" data-status={containerRunning ? 'ok' : containerKnown ? 'critical' : 'unknown'}>
            <span className="ai-label">Container</span>
            <span className="ai-layer__value">
              {containerState ?? EM_DASH}
              {text(container.health) ? <span className="ai-sub"> · {text(container.health)}</span> : null}
            </span>
          </div>
          <div className="ai-layer" data-status={healthy ? 'ok' : reachable ? 'critical' : 'warn'}>
            <span className="ai-label">HTTP health</span>
            <span className="ai-layer__value">{httpLabel}</span>
          </div>
        </div>

        <div className="ai-slots">
          <div className="ai-slots__head">
            <span className="ai-label">Slots</span>
            <span className="ai-slots__count">
              <strong>{busySlots === null ? EM_DASH : formatNumber(busySlots, 0)}</strong>
              <span className="ai-sub"> busy / {totalSlots === null ? EM_DASH : formatNumber(totalSlots, 0)}</span>
            </span>
            {generating ? (
              <span className="ai-chip ai-chip--live">
                <span className="ai-dot ai-dot--pulse ai-dot--sm" data-status="ok" aria-hidden="true" />
                Generating
              </span>
            ) : (
              <span className="ai-chip ai-chip--muted">Idle</span>
            )}
          </div>
          {pips.length > 0 ? (
            <ul className="ai-pips" aria-label={`${pips.filter((p) => p.busy).length} of ${pips.length} slots busy`}>
              {pips.map((pip) => (
                <li
                  key={pip.id}
                  className={pip.busy ? 'ai-pip ai-pip--busy' : 'ai-pip'}
                  title={`slot ${pip.id}: ${pip.state}`}
                />
              ))}
            </ul>
          ) : null}
        </div>

        <div className="ai-llm-latency">
          <div className="ai-llm-latency__head">
            <span className="ai-label">Health latency</span>
            <span className="ai-value">{formatMilliseconds(health.latency_ms)}</span>
          </div>
          <Sparkline
            timestamps={latency.timestamps}
            values={latency.values}
            unit=" ms"
            height={40}
            min={0}
            label="health latency history, milliseconds"
          />
        </div>

        <MetricGrid
          cells={[
            {
              label: 'Context',
              value: ctx ? ctx.short : EM_DASH,
              title: ctx?.full,
            },
            { label: 'Quant', value: ftype ?? EM_DASH },
            { label: 'Params', value: compactCount(firstModel.n_params) },
            { label: 'Weights', value: formatBytes(firstModel.size_bytes) },
            { label: 'Uptime', value: formatDuration(container.uptime_seconds) },
            {
              label: 'Restarts',
              value: (
                <span className={(num(container.restart_count) ?? 0) > 0 ? 'ai-value--warn' : undefined}>
                  {formatNumber(container.restart_count, 0)}
                </span>
              ),
            },
          ]}
        />

        {ggufFile ? (
          <p className="ai-file" title={text(model.path) ?? ggufFile}>
            {truncate(ggufFile, 64)}
          </p>
        ) : null}

        {metricsAvailable ? (
          <MetricGrid
            cells={[
              { label: 'Prompt tok', value: compactCount(metricValues['llamacpp:prompt_tokens_total']) },
              { label: 'Gen tok', value: compactCount(metricValues['llamacpp:tokens_predicted_total']) },
              { label: 'Decodes', value: compactCount(metricValues['llamacpp:n_decode_total']) },
              {
                label: 'KV cache',
                value: (() => {
                  const ratio = num(metricValues['llamacpp:kv_cache_usage_ratio']);
                  return ratio === null ? EM_DASH : formatPercent(ratio * 100);
                })(),
              },
              { label: 'Processing', value: formatNumber(metricValues['llamacpp:requests_processing'], 0) },
              { label: 'Deferred', value: formatNumber(metricValues['llamacpp:requests_deferred'], 0) },
            ]}
          />
        ) : (
          // Opt-in endpoint, not a fault: keep it quiet and explain how to enable it.
          <p className="ai-note ai-note--muted">
            throughput metrics off
            {text(metrics.reason) ? ` — ${truncate(text(metrics.reason) ?? '', 90)}` : ''}
            {text(metrics.hint) ? <span className="ai-hint">{truncate(text(metrics.hint) ?? '', 90)}</span> : null}
          </p>
        )}
      </div>
    </Card>
  );
}

export default LlamaCard;
