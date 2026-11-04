import { useEffect, useState, useCallback } from 'react';
import { getHealth, getLearningStats, getTickets, getActivityLog, getConfig, getBrains } from './api';
import type { LearningStats, Ticket, ActivityEntry, DshConfig, RouterConfig, BrainInfo } from './api';

interface HealthStatus {
  agentRunning: boolean;
  activeBrain: string;
  local: boolean;
  cloud: boolean;
  gpu?: boolean;
  nim?: boolean;
  'nim-local'?: boolean;
  runai?: boolean;
  uptime?: string;
}

export default function Overview() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [stats, setStats] = useState<LearningStats | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [config, setConfig] = useState<DshConfig | null>(null);
  const [routerConfig, setRouterConfig] = useState<RouterConfig | null>(null);
  const [brains, setBrains] = useState<BrainInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [h, s, t, a, c, rc, b] = await Promise.all([
        getHealth(),
        getLearningStats(),
        getTickets(5),
        getActivityLog(10),
        getConfig(),
        getRouterConfig(),
        getBrains(),
      ]);
      setHealth(h);
      setStats(s);
      setTickets(t);
      setActivities(a);
      setConfig(c);
      setRouterConfig(rc);
      setBrains(b.brains);
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

  if (loading) return <div className="flex items-center justify-center h-full text-gray-500">Loading...</div>;
  if (error) return <div className="text-danger p-4 bg-danger/10 rounded-lg">⚠ {error}</div>;

  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-200">Dashboard</h2>
          <p className="text-xs text-gray-500 mt-0.5">Auto-refreshes every 10 seconds</p>
        </div>
      </div>

      {/* Agent status + active brain */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label="Agent Status"
          value={health?.agentRunning ? '● Running' : '○ Stopped'}
          color={health?.agentRunning ? 'text-success' : 'text-danger'}
          bg={health?.agentRunning ? 'bg-success/10' : 'bg-danger/10'}
        />
        <StatCard
          label="Active Brain"
          value={health?.activeBrain ? health.activeBrain.toUpperCase() : 'N/A'}
          color="text-accent"
          bg="bg-accent/10"
        />
        <StatCard
          label="Total Tasks"
          value={String(stats?.entries.length ?? 0)}
          color="text-gray-200"
          bg="bg-surface3"
        />
      </div>

      {/* Brains health */}
      <div className="bg-surface2 border border-border rounded-lg p-5">
        <h3 className="text-sm font-medium text-gray-300 mb-4">Brains Health</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {(brains.length > 0 ? brains : [
            { id: 'local', name: 'Local (Ollama)', model: '', enabled: true, online: health?.local ?? false },
            { id: 'cloud', name: 'AI Gateway', model: '', enabled: true, online: health?.cloud ?? false },
            { id: 'gpu', name: 'GPU (Brev)', model: '', enabled: true, online: health?.gpu ?? false },
            { id: 'nim', name: 'NVIDIA NIM', model: '', enabled: true, online: health?.nim ?? false },
            { id: 'nim-local', name: 'Local NIM', model: '', enabled: true, online: health?.['nim-local'] ?? false },
            { id: 'runai', name: 'Run:ai MCP', model: '', enabled: true, online: health?.runai ?? false },
          ] as BrainInfo[]).map(brain => {
            const available = brain.online;
            return (
              <div key={brain.id} className={`rounded-lg p-3 border ${available ? 'border-success/30 bg-success/5' : 'border-border bg-surface2'}`}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${available ? 'bg-success' : 'bg-gray-600'}`} />
                  <span className="text-sm font-medium text-gray-300">{brain.name}</span>
                </div>
                <div className="text-[11px] text-gray-500 mt-1 truncate">{brain.model || brain.id}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {brain.enabled === false ? 'Disabled' : available ? 'Healthy' : 'Offline'}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Router learning stats */}
      {stats && (
        <div className="bg-surface2 border border-border rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-300">Router Learning Stats</h3>
            <span className="text-xs text-gray-500">v{stats.version} · {new Date(stats.lastUpdated).toLocaleString()}</span>
          </div>

          {Object.keys(stats.perBrainPerType).length === 0 ? (
            <p className="text-xs text-gray-500">No learning data yet. The router will accumulate stats as tasks are processed.</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-12 text-xs text-gray-500 pb-2 border-b border-border">
                <span className="col-span-4">Task → Brain</span>
                <span className="col-span-2 text-center">Total</span>
                <span className="col-span-2 text-center">Success</span>
                <span className="col-span-2 text-center">Failure</span>
                <span className="col-span-2 text-center">Rate</span>
              </div>
              {Object.entries(stats.perBrainPerType)
                .sort(([, a], [, b]) => b.total - a.total)
                .map(([key, bucket]) => {
                  const rate = bucket.total > 0 ? bucket.success / bucket.total : 0;
                  return (
                    <div key={key} className="grid grid-cols-12 items-center text-sm gap-2 py-1.5">
                      <span className="col-span-4 text-gray-300 truncate">{key}</span>
                      <span className="col-span-2 text-center text-gray-400">{bucket.total}</span>
                      <span className="col-span-2 text-center text-success">{bucket.success}</span>
                      <span className="col-span-2 text-center text-danger">{bucket.failure}</span>
                      <span className="col-span-2 text-center">
                        <span className={`font-medium ${rate >= 0.8 ? 'text-success' : rate >= 0.5 ? 'text-warn' : 'text-danger'}`}>
                          {(rate * 100).toFixed(0)}%
                        </span>
                      </span>
                    </div>
                  );
                })}
            </div>
          )}

          <div className="flex gap-6 mt-4 pt-3 border-t border-border text-xs text-gray-500">
            <span>Auto-upgrades: <strong className="text-gray-300">{stats.autoUpgrades}</strong></span>
            <span>Manual overrides: <strong className="text-gray-300">{stats.manualOverrides}</strong></span>
            <span>Entries: <strong className="text-gray-300">{stats.entries.length}</strong></span>
          </div>
        </div>
      )}

      {/* Thresholds */}
      {routerConfig && (
        <div className="bg-surface2 border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Complexity Thresholds</h3>
          <div className="grid grid-cols-3 gap-4">
            <ThresholdBar
              label="Low"
              value={routerConfig.thresholds.complexityScore.low}
              max={routerConfig.thresholds.complexityScore.medium}
              color="text-success"
              barColor="bg-success"
            />
            <ThresholdBar
              label="Medium"
              value={routerConfig.thresholds.complexityScore.medium}
              max={routerConfig.thresholds.complexityScore.high}
              color="text-warn"
              barColor="bg-warn"
            />
            <ThresholdBar
              label="High"
              value={routerConfig.thresholds.complexityScore.high}
              max={1}
              color="text-danger"
              barColor="bg-danger"
            />
          </div>
        </div>
      )}

      {/* Recent tickets */}
      {tickets.length > 0 && (
        <div className="bg-surface2 border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Recent Tickets</h3>
          <div className="space-y-2">
            {tickets.map(ticket => (
              <div key={ticket.id} className="flex items-center justify-between text-sm py-1.5 border-b border-border/50 last:border-0">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs text-gray-500 font-mono shrink-0">{ticket.id}</span>
                  <span className="text-gray-300 truncate">{ticket.subject}</span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${brainColor(ticket.brain)}`}>
                    {ticket.brain}
                  </span>
                  <span className="text-xs text-gray-500">
                    {(ticket.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      {activities.length > 0 && (
        <div className="bg-surface2 border border-border rounded-lg p-5">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Recent Activity</h3>
          <div className="space-y-2">
            {activities.map(entry => (
              <div key={entry.id} className="flex items-start gap-3 text-sm">
                <span className="text-xs text-gray-600 font-mono shrink-0 mt-0.5 w-20">{entry.timestamp}</span>
                <span className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${statusDot(entry.status)}`} />
                <span className="text-gray-300">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, bg }: { label: string; value: string; color: string; bg: string }) {
  return (
    <div className={`rounded-lg border border-border p-4 ${bg}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function ThresholdBar({ label, value, max, color, barColor }: { label: string; value: number; max: number; color: string; barColor: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div>
      <div className="text-xs text-gray-400 mb-1.5">{label}: {value}</div>
      <div className="h-2 bg-surface3 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
      </div>
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

function statusDot(status: string): string {
  switch (status) {
    case 'success': return 'bg-success';
    case 'error': return 'bg-danger';
    case 'warning': return 'bg-warn';
    default: return 'bg-accent';
  }
}
