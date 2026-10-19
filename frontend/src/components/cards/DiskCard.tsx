import { Card } from '../Card';
import {
  EM_DASH,
  formatBytes,
  formatBytesPerSecond,
  formatNumber,
  formatPercent,
  isFiniteNumber,
  isPlainObject,
  truncate,
} from '../../format';
import type { CardProps } from './types';
import './system-cards.css';

interface Mount {
  device: string | null;
  mountpoint: string;
  fstype: string | null;
  total: number | null;
  used: number | null;
  free: number | null;
  percent: number | null;
  inodePercent: number | null;
  inodeUsed: number | null;
  inodeTotal: number | null;
}

interface DiskIo {
  name: string;
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
  readIops: number | null;
  writeIops: number | null;
}

type Level = 'ok' | 'warn' | 'critical' | 'unknown';

function num(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function levelFor(percent: number | null, warn: number, critical: number): Level {
  if (percent === null) return 'unknown';
  if (percent >= critical) return 'critical';
  if (percent >= warn) return 'warn';
  return 'ok';
}

function UsageBar({ percent, level, label }: { percent: number | null; level: Level; label: string }) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      className="sys-bar sys-bar--thin"
      role="img"
      aria-label={`${label}: ${formatPercent(percent)}`}
      title={`${label}: ${formatPercent(percent)}`}
    >
      <span className="sys-bar__fill" data-level={level} style={{ width: `${width}%` }} />
    </div>
  );
}

function readMounts(value: unknown): Mount[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((entry) => {
    const inodes = isPlainObject(entry.inodes) ? entry.inodes : {};
    return {
      device: str(entry.device),
      mountpoint: str(entry.mountpoint) ?? EM_DASH,
      fstype: str(entry.fstype),
      total: num(entry.total),
      used: num(entry.used),
      free: num(entry.free),
      percent: num(entry.percent),
      // Inodes are a count of filesystem objects, never a size in bytes.
      inodePercent: num(inodes.percent),
      inodeUsed: num(inodes.used),
      inodeTotal: num(inodes.total),
    };
  });
}

function readDisks(value: unknown): DiskIo[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((entry) => ({
    name: str(entry.name) ?? EM_DASH,
    readBytesPerSec: num(entry.read_bytes_per_sec),
    writeBytesPerSec: num(entry.write_bytes_per_sec),
    readIops: num(entry.read_iops),
    writeIops: num(entry.write_iops),
  }));
}

function formatIops(value: number | null): string {
  return value === null ? EM_DASH : `${formatNumber(value, 0)} IOPS`;
}

export function DiskCard({ result, meta }: CardProps) {
  const data = result.data ?? {};

  const mounts = readMounts(data.mounts);
  const disks = readDisks(data.disks);
  const maxPercent = num(data.max_percent);

  const smartAvailable = data.smart_available === true;
  const smartReason = str(data.smart_reason) ?? str(meta?.smart_reason);

  // First-sample throughput is null because rates are deltas between samples.
  const ratesPending =
    disks.length > 0 && disks.every((disk) => disk.readBytesPerSec === null && disk.writeBytesPerSec === null);

  return (
    <Card
      title="Disks"
      result={result}
      subtitle={
        mounts.length > 0
          ? `${mounts.length} mount${mounts.length === 1 ? '' : 's'} · fullest ${formatPercent(maxPercent)}`
          : undefined
      }
      footer={
        smartAvailable
          ? 'SMART available'
          : smartReason
            ? `SMART: ${truncate(smartReason, 70)}`
            : undefined
      }
    >
      <div className="sys-stack">
        <section className="sys-section">
          <h3 className="sys-section__title">Filesystems</h3>
          {mounts.length === 0 ? (
            <p className="sys-note">No filesystems reported.</p>
          ) : (
            <div className="sys-rows">
              {mounts.map((mount) => {
                const level = levelFor(mount.percent, 80, 90);
                const inodeLevel = levelFor(mount.inodePercent, 80, 90);
                return (
                  <div className="sys-row" key={mount.mountpoint}>
                    <div className="sys-row__head">
                      <span className="sys-row__name" title={mount.mountpoint}>
                        {mount.mountpoint}
                      </span>
                      <span className="sys-row__percent" data-level={level}>
                        {formatPercent(mount.percent)}
                      </span>
                    </div>
                    <UsageBar
                      percent={mount.percent}
                      level={level}
                      label={`${mount.mountpoint} capacity used`}
                    />
                    <div className="sys-row__meta">
                      <span>
                        <b>{formatBytes(mount.used)}</b> / {formatBytes(mount.total)}
                      </span>
                      <span>
                        <b>{formatBytes(mount.free)}</b> free
                      </span>
                    </div>
                    <div className="sys-row__meta">
                      <span className="sys-muted">
                        {mount.device ?? EM_DASH}
                        {mount.fstype ? ` · ${mount.fstype}` : ''}
                      </span>
                      <span
                        data-level={inodeLevel}
                        title={
                          mount.inodeTotal !== null && mount.inodeTotal > 0
                            ? `${formatNumber(mount.inodeUsed, 0)} of ${formatNumber(
                                mount.inodeTotal,
                                0,
                              )} inodes used`
                            : 'this filesystem does not report inodes'
                        }
                      >
                        inodes <b>{formatPercent(mount.inodePercent)}</b>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="sys-section">
          <h3 className="sys-section__title">
            <span>Disk I/O</span>
            {ratesPending ? (
              <span className="sys-section__title-note">measuring…</span>
            ) : null}
          </h3>
          {disks.length === 0 ? (
            <p className="sys-note">No physical disks reported.</p>
          ) : (
            <div className="sys-rows">
              {disks.map((disk) => (
                <div className="sys-row" key={disk.name}>
                  <div className="sys-row__head">
                    <span className="sys-row__name">{disk.name}</span>
                  </div>
                  <div className="sys-row__meta">
                    <span title={`${disk.name} read throughput`}>
                      read <b>{formatBytesPerSecond(disk.readBytesPerSec)}</b>
                      <span className="sys-muted"> · {formatIops(disk.readIops)}</span>
                    </span>
                  </div>
                  <div className="sys-row__meta">
                    <span title={`${disk.name} write throughput`}>
                      write <b>{formatBytesPerSecond(disk.writeBytesPerSec)}</b>
                      <span className="sys-muted"> · {formatIops(disk.writeIops)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {ratesPending ? (
            <p className="sys-note">
              Throughput is a delta between samples; rates appear after the next collection.
            </p>
          ) : null}
        </section>

        {!smartAvailable && smartReason ? (
          <p className="sys-note" title={smartReason}>
            SMART health is not collected — {smartReason}.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

export default DiskCard;
