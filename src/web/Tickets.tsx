import { useEffect, useState, useCallback } from 'react';
import { getTickets, getTicketDetails, resolveTicket } from './api';
import type { Ticket } from './api';

export default function Tickets() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved' | 'escalated'>('all');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await getTickets(100);
      setTickets(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tickets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleResolve = async (id: string) => {
    try {
      await resolveTicket(id);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve');
    }
  };

  const handleViewDetail = async (ticket: Ticket) => {
    setSelected(ticket);
    setDetailLoading(true);
    try {
      const details = await getTicketDetails(ticket.id);
      setSelected(details);
    } catch {
      // keep current ticket if detail fetch fails
    } finally {
      setDetailLoading(false);
    }
  };

  const filtered = filter === 'all' ? tickets : tickets.filter(t => t.status === filter);
  const counts = {
    all: tickets.length,
    open: tickets.filter(t => t.status === 'open').length,
    resolved: tickets.filter(t => t.status === 'resolved').length,
    escalated: tickets.filter(t => t.status === 'escalated').length,
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500">Loading tickets...</div>;

  return (
    <div className="space-y-4 fade-in">
      {/* Header + counts */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-200">Tickets</h2>
          <p className="text-xs text-gray-500 mt-0.5">Router-assisted ticket management</p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className={`px-2.5 py-1 rounded-full ${counts.all > 0 ? 'bg-accent/20 text-accent' : 'bg-surface3 text-gray-500'}`}>All {counts.all}</span>
          <span className={`px-2.5 py-1 rounded-full ${counts.open > 0 ? 'bg-warn/20 text-warn' : 'bg-surface3 text-gray-500'}`}>Open {counts.open}</span>
          <span className={`px-2.5 py-1 rounded-full ${counts.escalated > 0 ? 'bg-danger/20 text-danger' : 'bg-surface3 text-gray-500'}`}>Escalated {counts.escalated}</span>
          <span className={`px-2.5 py-1 rounded-full ${counts.resolved > 0 ? 'bg-success/20 text-success' : 'bg-surface3 text-gray-500'}`}>Resolved {counts.resolved}</span>
        </div>
      </div>

      {error && <div className="text-danger text-xs bg-danger/10 p-3 rounded-lg">{error}</div>}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-border">
        {(['all', 'open', 'resolved', 'escalated'] as const).map(f => (
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

      {/* Ticket list */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-500 text-sm">No tickets found</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(ticket => (
            <div
              key={ticket.id}
              className={`bg-surface2 border border-border rounded-lg p-4 hover:border-border/80 transition-colors cursor-pointer
                ${selected?.id === ticket.id ? 'border-accent/50' : ''}`}
              onClick={() => handleViewDetail(ticket)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-gray-500 font-mono">{ticket.id}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${statusStyle(ticket.status)}`}>
                      {ticket.status}
                    </span>
                  </div>
                  <div className="text-sm text-gray-200 font-medium truncate">{ticket.subject}</div>
                  <div className="text-xs text-gray-500 mt-1 line-clamp-1">{ticket.description}</div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${brainColor(ticket.brain)}`}>
                    {ticket.brain}
                  </span>
                  <span className="text-xs text-gray-500">{(ticket.confidence * 100).toFixed(0)}%</span>
                </div>
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50">
                <span className="text-xs text-gray-600">{ticket.timestamp}</span>
                {ticket.status === 'open' && (
                  <button
                    onClick={e => { e.stopPropagation(); handleResolve(ticket.id); }}
                    className="text-xs text-success hover:text-success/80 font-medium"
                  >
                    Resolve
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSelected(null)} />
          <div className="relative bg-surface2 border border-border rounded-xl w-full max-w-lg max-h-[80vh] overflow-auto p-6 shadow-2xl">
            <button onClick={() => setSelected(null)} className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 text-lg">✕</button>
            <h3 className="text-base font-semibold text-gray-200 mb-1">{selected.subject}</h3>
            <div className="flex gap-2 mb-4">
              <span className={`text-xs px-2 py-0.5 rounded-full ${statusStyle(selected.status)}`}>{selected.status}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${brainColor(selected.brain)}`}>{selected.brain}</span>
              <span className="text-xs text-gray-500">{(selected.confidence * 100).toFixed(0)}% confidence</span>
            </div>
            <div className="text-sm text-gray-300 mb-4 whitespace-pre-wrap">{selected.description}</div>
            {detailLoading ? (
              <div className="text-xs text-gray-500">Loading details...</div>
            ) : (
              <div className="space-y-3 text-xs">
                <DetailRow label="Router Output" value={selected.routerOutput} />
                <DetailRow label="Tokens Used" value={selected.tokensUsed ? String(selected.tokensUsed) : '—'} />
                <DetailRow label="Latency" value={selected.latencyMs ? `${selected.latencyMs}ms` : '—'} />
                <DetailRow label="Created" value={selected.timestamp} />
              </div>
            )}
            {selected.status === 'open' && (
              <div className="mt-4 pt-4 border-t border-border">
                <button
                  onClick={() => handleResolve(selected.id)}
                  className="px-4 py-2 bg-success/20 text-success text-xs font-medium rounded-lg hover:bg-success/30 transition-colors"
                >
                  Mark as Resolved
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function statusStyle(status: string): string {
  switch (status) {
    case 'open': return 'bg-warn/20 text-warn';
    case 'resolved': return 'bg-success/20 text-success';
    case 'escalated': return 'bg-danger/20 text-danger';
    case 'in-progress': return 'bg-accent/20 text-accent';
    default: return 'bg-gray-500/20 text-gray-400';
  }
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

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-300">{value}</span>
    </div>
  );
}
