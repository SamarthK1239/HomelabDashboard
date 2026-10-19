import { Card } from '../Card';
import { Sparkline } from '../Sparkline';
import { useHistory } from '../../hooks/useHistory';
import {
  EM_DASH,
  formatBytes,
  formatNumber,
  formatPercent,
  isFiniteNumber,
  isPlainObject,
  truncate,
} from '../../format';
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

interface GpuView {
  index: number;
  name: string;
  utilization: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  memoryPercent: number | null;
  temperature: number | null;
  powerDraw: number | null;
  powerLimit: number | null;
  fan: number | null;
  clockSm: number | null;
  clockSmMax: number | null;
  throttled: boolean;
  throttleReasons: string[];
  processes: ProcessView[];
}

interface ProcessView {
  key: string;
  pid: number | null;
  name: string | null;
  container: string | null;
  memory: number | null;
}

function toGpuView(entry: unknown, fallbackIndex: number): GpuView {
  const gpu = record(entry);
  const index = num(gpu.index) ?? fallbackIndex;
  const reasons = list(gpu.throttle_reasons)
    .map((reason) => text(reason))
    .filter((reason): reason is string => reason !== null);

  const processes = list(gpu.processes).map((entry, position): ProcessView => {
    const process = record(entry);
    const pid = num(process.pid);
    return {
      key: `${pid ?? 'p'}-${position}`,
      pid,
      name: text(process.name),
      container: text(process.container_name) ?? text(process.container_id),
      memory: num(process.used_memory_bytes),
    };
  });

  return {
    index,
    name: text(gpu.name) ?? `GPU ${index}`,
    utilization: num(gpu.utilization_percent),
    memoryUsed: num(gpu.memory_used_bytes),
    memoryTotal: num(gpu.memory_total_bytes),
    memoryPercent: num(gpu.memory_percent),
    temperature: num(gpu.temperature_c),
    powerDraw: num(gpu.power_draw_watts),
    powerLimit: num(gpu.power_limit_watts),
    fan: num(gpu.fan_percent),
    clockSm: num(gpu.clock_sm_mhz),
    clockSmMax: num(gpu.clock_sm_max_mhz),
    throttled: gpu.throttled === true,
    throttleReasons: reasons,
    processes,
  };
}

function clampPercent(value: number | null): number {
  if (value === null) return 0;
  return Math.max(0, Math.min(100, value));
}

/** Derived VRAM percent, for cards whose driver omits `memory_percent`. */
function vramPercent(gpu: GpuView): number | null {
  if (gpu.memoryPercent !== null) return gpu.memoryPercent;
  if (gpu.memoryUsed !== null && gpu.memoryTotal !== null && gpu.memoryTotal > 0) {
    return (gpu.memoryUsed / gpu.memoryTotal) * 100;
  }
  return null;
}

function watts(value: number | null): string {
  return value === null ? EM_DASH : `${formatNumber(value, value >= 100 ? 0 : 1)} W`;
}

function megahertz(value: number | null): string {
  return value === null ? EM_DASH : `${formatNumber(value, 0)} MHz`;
}

/**
 * One self-contained block per physical GPU.
 *
 * Rendered as its own component because each GPU owns two history series, and
 * hooks cannot be called from a loop in the parent.
 */
function GpuSection({ gpu, refreshSeconds }: { gpu: GpuView; refreshSeconds: number }) {
  const util = useHistory(`gpu.gpu${gpu.index}_util`, { refreshSeconds });
  const temp = useHistory(`gpu.gpu${gpu.index}_temp`, { refreshSeconds });

  const memPercent = vramPercent(gpu);
  const powerPercent =
    gpu.powerDraw !== null && gpu.powerLimit !== null && gpu.powerLimit > 0
      ? (gpu.powerDraw / gpu.powerLimit) * 100
      : null;

  return (
    <section className="ai-gpu" aria-label={`GPU ${gpu.index}, ${gpu.name}`}>
      <header className="ai-gpu__head">
        <span className="ai-gpu__index">GPU {gpu.index}</span>
        <h3 className="ai-gpu__name" title={gpu.name}>
          {truncate(gpu.name, 40)}
        </h3>
        <span className="ai-gpu__util" title="utilisation">
          {formatPercent(gpu.utilization, 0)}
        </span>
      </header>

      {/*
        VRAM bar is intentionally neutral: llama.cpp preallocates its whole KV
        cache at startup, so a near-full card is the healthy steady state here.
        Alarm colouring is left to the status the backend assigns to the card.
      */}
      <div className="ai-gpu__vram">
        <div className="ai-bar" role="img" aria-label={`VRAM ${formatPercent(memPercent)} used`}>
          <span className="ai-bar__fill" style={{ width: `${clampPercent(memPercent)}%` }} />
        </div>
        <div className="ai-gpu__vram-text">
          <span>
            {formatBytes(gpu.memoryUsed)} <span className="ai-sub">/ {formatBytes(gpu.memoryTotal)}</span>
          </span>
          <span className="ai-sub">{formatPercent(memPercent)}</span>
        </div>
      </div>

      <dl className="ai-grid ai-grid--tight">
        <div className="ai-cell">
          <dt className="ai-label">Temp</dt>
          <dd className="ai-value">
            {gpu.temperature === null ? EM_DASH : `${formatNumber(gpu.temperature, 0)}°C`}
          </dd>
        </div>
        <div className="ai-cell">
          <dt className="ai-label">Power</dt>
          <dd
            className="ai-value"
            title={powerPercent === null ? undefined : `${formatPercent(powerPercent, 0)} of limit`}
          >
            {watts(gpu.powerDraw)} <span className="ai-sub">/ {watts(gpu.powerLimit)}</span>
          </dd>
        </div>
        <div className="ai-cell">
          <dt className="ai-label">SM clock</dt>
          <dd className="ai-value">
            {megahertz(gpu.clockSm)} <span className="ai-sub">/ {megahertz(gpu.clockSmMax)}</span>
          </dd>
        </div>
        <div className="ai-cell">
          <dt className="ai-label">Fan</dt>
          {/* Passively cooled datacenter cards report no fan at all — not a fault. */}
          <dd className="ai-value" title={gpu.fan === null ? 'no fan sensor (passively cooled)' : undefined}>
            {formatPercent(gpu.fan, 0)}
          </dd>
        </div>
      </dl>

      {gpu.throttled ? (
        <p className="ai-throttle" role="status">
          <span className="ai-chip ai-chip--warn">Throttled</span>
          <span className="ai-sub">
            {gpu.throttleReasons.length > 0 ? gpu.throttleReasons.join(', ') : 'reason not reported'}
          </span>
        </p>
      ) : null}

      <div className="ai-charts">
        <div className="ai-chart">
          <span className="ai-label">Utilisation</span>
          <Sparkline
            timestamps={util.timestamps}
            values={util.values}
            unit="%"
            min={0}
            max={100}
            height={38}
            label={`GPU ${gpu.index} utilisation history, percent`}
          />
        </div>
        <div className="ai-chart">
          <span className="ai-label">Temperature</span>
          <Sparkline
            timestamps={temp.timestamps}
            values={temp.values}
            unit="°C"
            color="var(--status-warn)"
            height={38}
            label={`GPU ${gpu.index} temperature history, celsius`}
          />
        </div>
      </div>

      <div className="ai-procs">
        <span className="ai-label">Compute processes</span>
        {gpu.processes.length === 0 ? (
          <p className="ai-note ai-note--muted">none</p>
        ) : (
          <ul className="ai-proc-list">
            {gpu.processes.map((process) => {
              // The owning container is the useful identity; the executable
              // name is only worth repeating when it differs.
              const primary = process.container ?? process.name ?? 'unknown';
              const secondary = process.container && process.name !== process.container ? process.name : null;
              return (
                <li className="ai-proc" key={process.key}>
                  <span
                    className="ai-proc__name"
                    title={
                      process.container
                        ? `container ${process.container}${process.name ? ` · ${process.name}` : ''}`
                        : (process.name ?? undefined)
                    }
                  >
                    {truncate(primary, 26)}
                  </span>
                  {process.container ? null : (
                    <span className="ai-chip ai-chip--muted" title="not running in a container">
                      host
                    </span>
                  )}
                  {secondary ? <span className="ai-sub">{truncate(secondary, 18)}</span> : null}
                  <span className="ai-sub" title={process.pid === null ? undefined : `PID ${process.pid}`}>
                    {process.pid === null ? EM_DASH : `pid ${process.pid}`}
                  </span>
                  <span className="ai-proc__mem">{formatBytes(process.memory)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export function GpuCard({ result, refreshSeconds }: CardProps) {
  const data = record(result.data);
  const gpus = list(data.gpus).map(toGpuView);

  const driver = text(data.driver_version);
  const cuda = text(data.cuda_version);
  const source = text(data.source);
  const available = data.available === true;

  const footerParts = [
    driver ? `driver ${driver}` : null,
    cuda ? `CUDA ${cuda}` : null,
    source,
  ].filter((part): part is string => Boolean(part));

  const count = num(data.count) ?? gpus.length;
  const subtitle =
    gpus.length === 1 ? gpus[0].name : gpus.length > 1 ? `${formatNumber(count, 0)} GPUs` : 'no GPU detected';

  return (
    <Card
      title="GPUs"
      result={result}
      subtitle={subtitle}
      footer={footerParts.length > 0 ? footerParts.join(' · ') : null}
    >
      {gpus.length === 0 ? (
        <p className="ai-note ai-note--muted">
          {available ? 'no GPUs reported by the driver' : (text(data.reason) ?? text(data.error) ?? 'GPU telemetry unavailable')}
        </p>
      ) : (
        <div className="ai-gpu-list">
          {gpus.map((gpu) => (
            <GpuSection key={`${gpu.index}-${gpu.name}`} gpu={gpu} refreshSeconds={refreshSeconds} />
          ))}
        </div>
      )}
    </Card>
  );
}

export default GpuCard;
