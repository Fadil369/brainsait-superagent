import { useEffect, useState, useCallback } from 'react';
import { getLearningStats, getRouterConfig, setManualOverride } from './api';
import type { LearningStats, RouterConfig } from './api';

type BrainType = 'local' | 'cloud' | 'gpu' | 'nim';

export default function Router() {
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [config, setConfig] = useState<RouterConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overrideBrain, setOverrideBrain] = useState<BrainType | null>(null);
  const [manualEnabled, setManualEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [s, c] = await Promise.all([getLearningStats(), getRouterConfig()]);
      setStats(s);
      setConfig(c);
      if (c?.manualOverride) {
        setOverrideBrain(c.manualOverride.forceBrain as BrainType | null);
        setManualEnabled(c.manualOverride.enabled);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleOverride = async (brain: BrainType | null) => {
    try {
      await setManualOverride(brain ?? null);
      setOverrideBrain(brain);
      setManualEnabled(brain !== null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set override');
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500">Loading router data...</div>;
  if (error) return <div className="text-danger p-4 bg-danger/10 rounded-lg">⚠ {error}</div>;

  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-200">Router Learning</h2>
        <p className="text-xs text-gray-500 mt-0.5">Task-type → brain mapping, success rates, and manual controls</p>
      </div>

      {/* Manual override */}
      <div className="bg-surface2 border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Manual Override</h3>
        <p className="text-xs text-gray-500 mb-3">Force the router to use a specific brain for all tasks.</p>
        <div className="flex flex-wrap gap-2">
          {[null, 'local', 'cloud', 'gpu', 'nim' as BrainType].map(b => (
            <button
              key={b ?? 'none'}
              onClick={() => handleOverride(b)}
              disabled={!config?.manualOverride?.enabled}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors
                ${(b === null ? !manualEnabled : b === overrideBrain) && manualEnabled
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-surface3 text-gray-400 border border-border hover:text-gray-200'}
                ${!config?.manualOverride?.enabled ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {b === null ? 'Auto' : b.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="mt-2 text-xs text-gray-600">
          Overrides recorded: <span className="text-gray-400">{stats?.manualOverrides ?? 0}</span>
        </div>
      </div>

      {/* Auto-upgrades */}
      <div className="bg-surface2 border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Self-Learning Summary</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Total Entries" value={String(stats?.entries.length ?? 0)} />
          <Stat label="Auto-Upgrades" value={String(stats?.autoUpgrades ?? 0)} />
          <Stat label="Overrides" value={String(stats?.manualOverrides ?? 0)} />
          <Stat label="Version" value={`v${stats?.version ?? '?'}`} />
        </div>
      </div>

      {/* Task → Brain mapping table */}
      <div className="bg-surface2 border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Task Type → Brain Mapping</h3>

        {Object.keys(stats?.perBrainPerType ?? {}).length === 0 ? (
          <p className="text-xs text-gray-500 py-4">No data yet. The router accumulates learning stats as it processes tasks.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-border">
                  <th className="text-left py-2 pr-4 font-normal">Task Type</th>
                  <th className="text-center py-2 px-2 font-normal">Local</th>
                  <th className="text-center py-2 px-2 font-normal">Cloud</th>
                  <th className="text-center py-2 px-2 font-normal">Best</th>
                  <th className="text-center py-2 px-2 font-normal">Overall Rate</th>
                  <th className="text-center py-2 px-2 font-normal">Avg Latency</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(stats!.perBrainPerType)
                  .reduce((acc, [key, bucket]) => {
                    const taskType = key.split(':')[0];
                    const existing = acc.find(a => a.taskType === taskType);
                    if (existing) {
                      existing.buckets[key] = bucket;
                      existing.total = bucket.total;
                      existing.success += bucket.success;
                      existing.failure += bucket.failure;
                      existing.latency = bucket.avgLatencyMs;
                    } else {
                      acc.push({ taskType, buckets: { [key]: bucket }, total: bucket.total, success: bucket.success, failure: bucket.failure, latency: bucket.avgLatencyMs });
                    }
                    return acc;
                  }, [] as { taskType: string; buckets: Record<string, { total: number; success: number; failure: number; avgLatencyMs: number }>; total: number; success: number; failure: number; latency: number }[])
                  .sort((a, b) => b.total - a.total)
                  .map(row => {
                    const rate = row.total > 0 ? row.success / row.total : 0;
                    const bestBrain = getBestBrain(row.buckets);
                    return (
                      <tr key={row.taskType} className="border-b border-border/50 hover:bg-surface3/30">
                        <td className="py-2 pr-4 text-gray-300 font-medium">{row.taskType}</td>
                        <td className="py-2 px-2 text-center">
                          {row.buckets['local:'] || row.buckets['local:general'] ? (
                            <RateCell bucket={row.buckets['local:'] || row.buckets['local:general']!} />
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="py-2 px-2 text-center">
                          {row.buckets['cloud:'] || row.buckets['cloud:general'] ? (
                            <RateCell bucket={row.buckets['cloud:'] || row.buckets['cloud:general']!} />
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="py-2 px-2 text-center">
                          {bestBrain ? (
                            <span className={`text-xs font-medium ${brainColorText(bestBrain)}`}>{bestBrain}</span>
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="py-2 px-2 text-center">
                          <span className={`font-medium ${rate >= 0.8 ? 'text-success' : rate >= 0.5 ? 'text-warn' : 'text-danger'}`}>
                            {(rate * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="py-2 px-2 text-center text-gray-500">
                          {row.latency > 0 ? `${Math.round(row.latency)}ms` : '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Threshold adjustments */}
      {config && (
        <div className="bg-surface2 border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Complexity Thresholds</h3>
          <div className="space-y-4">
            <ThresholdBar
              label="Low → Medium"
              value={config.thresholds.complexityScore.low}
              max={config.thresholds.complexityScore.medium}
              color="text-success"
              barColor="bg-success"
              hint={`Tasks scoring below ${(config.thresholds.complexityScore.low * 100).toFixed(0)}% are classified as low complexity`}
            />
            <ThresholdBar
              label="Medium → High"
              value={config.thresholds.complexityScore.medium}
              max={config.thresholds.complexityScore.high}
              color="text-warn"
              barColor="bg-warn"
              hint={`Tasks scoring between ${(config.thresholds.complexityScore.medium * 100).toFixed(0)}%–${(config.thresholds.complexityScore.high * 100).toFixed(0)}% are medium complexity`}
            />
            <ThresholdBar
              label="Local Health"
              value={config.thresholds.localHealthThreshold}
              max={1}
              color="text-accent"
              barColor="bg-accent"
              hint={`Local brain health must stay above ${(config.thresholds.localHealthThreshold * 100).toFixed(0)}%`}
            />
          </div>
        </div>
      )}

      {/* Recent entries */}
      <div className="bg-surface2 border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Recent Learning Entries</h3>
        {(!stats || stats.entries.length === 0) ? (
          <p className="text-xs text-gray-500 py-4">No learning entries recorded yet.</p>
        ) : (
          <div className="space-y-2 max-h-64 overflow-auto">
            {[...stats.entries].reverse().slice(0, 20).map((entry, i) => (
              <div key={i} className="flex items-center gap-3 text-xs py-1.5 border-b border-border/30 last:border-0">
                <span className="text-gray-600 font-mono w-20 shrink-0">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${entry.outcome === 'success' ? 'bg-success' : 'bg-danger'}`} />
                <span className="text-gray-400 shrink-0">{entry.taskType}</span>
                <span className={`px-1.5 py-0.5 rounded font-medium shrink-0 ${brainColor(entry.selectedBrain)}`}>
                  {entry.selectedBrain}
                </span>
                <span className="text-gray-500 truncate">{entry.input.slice(0, 60)}{entry.input.length > 60 ? '…' : ''}</span>
                <span className="text-gray-600 shrink-0">{entry.latencyMs}ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface3 rounded-lg p-3 text-center">
      <div className="text-xs text-gray-500 mb-0.5">{label}</div>
      <div className="text-base font-semibold text-gray-200">{value}</div>
    </div>
  );
}

function RateCell({ bucket }: { bucket: { total: number; success: number; failure: number } }) {
  const rate = bucket.total > 0 ? bucket.success / bucket.total : 0;
  return (
    <span className={`font-medium ${rate >= 0.8 ? 'text-success' : rate >= 0.5 ? 'text-warn' : 'text-danger'}`}>
      {bucket.total > 0 ? `${(rate * 100).toFixed(0)}%` : '—'}
    </span>
  );
}

function getBestBrain(buckets: Record<string, { success: number; failure: number }>): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [key, bucket] of Object.entries(buckets)) {
    const base = key.split(':')[0];
    const score = bucket.total > 0 ? bucket.success / bucket.total : 0;
    if (score > bestScore) {
      bestScore = score;
      best = base;
    }
  }
  return bestScore > 0 ? best : null;
}

function ThresholdBar({ label, value, max, color, barColor, hint }: { label: string; value: number; max: number; color: string; barColor: string; hint: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">{label}</span>
        <span className={`text-xs font-medium ${color}`}>{value}</span>
      </div>
      <div className="h-2 bg-surface3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min((value / max) * 100, 100)}%` }} />
      </div>
      <div className="text-xs text-gray-600 mt-1">{hint}</div>
    </div>
  );
}

function brainColor(brain: string): string {
  switch (brain) {
    case 'local': return 'bg-accent/20 text-accent';
    case 'cloud': return 'bg-success/20 text-success';
    case 'gpu': return 'bg-warn/20 text-warn';
    case 'nim': return 'bg-purple-400/20 text-purple-400';
    default: return 'bg-gray-500/20 text-gray-400';
  }
}

function brainColorText(brain: string): string {
  switch (brain) {
    case 'local': return 'text-accent';
    case 'cloud': return 'text-success';
    case 'gpu': return 'text-warn';
    case 'nim': return 'text-purple-400';
    default: return 'text-gray-400';
  }
}
