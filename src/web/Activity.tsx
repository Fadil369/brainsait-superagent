import { useEffect, useState, useCallback, useRef } from 'react';
import { getActivityLog } from './api';
import type { ActivityEntry } from './api';

export default function Activity() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'success' | 'error' | 'warning'>('all');
  const [wsConnected, setWsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const fetchEntries = useCallback(async () => {
    try {
      setError(null);
      const data = await getActivityLog(200);
      setEntries(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntries();
    const id = setInterval(fetchEntries, 10000);
    return () => clearInterval(id);
  }, [fetchEntries]);

  // WebSocket for real-time updates
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws/activity`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    ws.onerror = () => setWsConnected(false);

    ws.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data) as ActivityEntry;
        setEntries(prev => [entry, ...prev].slice(0, 500));
      } catch {
        // ignore malformed messages
      }
    };

    return () => { ws.close(); };
  }, []);

  const filtered = filter === 'all' ? entries : entries.filter(e => e.status === filter);
  const counts = {
    all: entries.length,
    success: entries.filter(e => e.status === 'success').length,
    error: entries.filter(e => e.status === 'error').length,
    warning: entries.filter(e => e.status === 'warning').length,
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500">Loading activity...</div>;

  return (
    <div className="space-y-4 fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-200">Activity Log</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {wsConnected ? '● Live updates active' : '○ Polling every 10s'}
            {' · '}{counts.all.toLocaleString()} entries
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className={`px-2.5 py-1 rounded-full ${counts.all > 0 ? 'bg-accent/20 text-accent' : 'bg-surface3 text-gray-500'}`}>All {counts.all}</span>
          <span className={`px-2.5 py-1 rounded-full ${counts.success > 0 ? 'bg-success/20 text-success' : 'bg-surface3 text-gray-500'}`}>OK {counts.success}</span>
          <span className={`px-2.5 py-1 rounded-full ${counts.warning > 0 ? 'bg-warn/20 text-warn' : 'bg-surface3 text-gray-500'}`}>Warn {counts.warning}</span>
          <span className={`px-2.5 py-1 rounded-full ${counts.error > 0 ? 'bg-danger/20 text-danger' : 'bg-surface3 text-gray-500'}`}>Error {counts.error}</span>
        </div>
      </div>

      {error && <div className="text-danger text-xs bg-danger/10 p-3 rounded-lg">{error}</div>}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['all', 'success', 'warning', 'error'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors capitalize
              ${filter === f ? 'border-accent text-accent' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Log */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-500 text-sm">No activity found</div>
      ) : (
        <div className="bg-surface2 border border-border rounded-lg overflow-hidden">
          <div className="max-h-[calc(100vh-280px)] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface2 z-10">
                <tr className="text-xs text-gray-500 border-b border-border">
                  <th className="text-left py-2 px-4 font-normal w-28">Timestamp</th>
                  <th className="text-left py-2 px-4 font-normal w-20">Status</th>
                  <th className="text-left py-2 px-4 font-normal w-16">Type</th>
                  <th className="text-left py-2 px-4 font-normal">Message</th>
                </tr>
              </thead>
              <tbody>
                {[...filtered].reverse().map(entry => (
                  <tr key={entry.id} className="border-b border-border/30 hover:bg-surface3/30 transition-colors">
                    <td className="py-2 px-4 text-gray-500 font-mono text-xs whitespace-nowrap">{entry.timestamp}</td>
                    <td className="py-2 px-4">
                      <span className={`inline-block w-2 h-2 rounded-full ${statusDot(entry.status)}`} />
                    </td>
                    <td className="py-2 px-4">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${statusStyle(entry.status)}`}>
                        {entry.type}
                      </span>
                    </td>
                    <td className="py-2 px-4 text-gray-300 text-xs leading-relaxed">{entry.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function statusDot(status: string): string {
  switch (status) {
    case 'success': return 'bg-success';
    case 'error': return 'bg-danger';
    case 'warning': return 'bg-warn';
    default: return 'bg-accent';
  }
}

function statusStyle(status: string): string {
  switch (status) {
    case 'success': return 'bg-success/20 text-success';
    case 'error': return 'bg-danger/20 text-danger';
    case 'warning': return 'bg-warn/20 text-warn';
    default: return 'bg-accent/20 text-accent';
  }
}
