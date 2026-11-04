import { useState, useEffect, useCallback } from 'react';
import Overview from './Overview';
import Tickets from './Tickets';
import Router from './Router';
import Activity from './Activity';

type Page = 'overview' | 'tickets' | 'router' | 'activity';

const navItems: { id: Page; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: '◉' },
  { id: 'tickets', label: 'Tickets', icon: '▤' },
  { id: 'router', label: 'Router', icon: '⊞' },
  { id: 'activity', label: 'Activity', icon: '◷' },
];

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  const goTo = useCallback((p: Page) => { setPage(p); setMobileOpen(false); }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:relative z-50 h-full flex flex-col border-r border-border
        bg-surface2 transition-all duration-300
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        ${sidebarOpen ? 'w-56' : 'w-[56px]'}
      `}>
        {/* Logo */}
        <div className={`flex items-center h-14 border-b border-border px-4 ${!sidebarOpen && 'justify-center'}`}>
          <span className="text-accent text-lg font-bold tracking-tight">🧠 SuperAgent</span>
          {sidebarOpen && <span className="ml-2 text-xs text-gray-500">Monitor</span>}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 space-y-1">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => goTo(item.id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors
                ${page === item.id ? 'bg-surface3 text-accent' : 'text-gray-400 hover:text-gray-200 hover:bg-surface3/50'}`}
            >
              <span className="text-base w-5 text-center">{item.icon}</span>
              {sidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>

        {/* Collapse toggle */}
        <div className="border-t border-border p-3">
          <button
            onClick={() => setSidebarOpen(s => !s)}
            className="w-full flex items-center justify-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            <span className={`transition-transform ${sidebarOpen ? '' : 'rotate-180'}`}>◀</span>
            {sidebarOpen && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 border-b border-border bg-surface2 flex items-center justify-between px-4 lg:px-6">
          <button onClick={() => setMobileOpen(true)} className="lg:hidden text-gray-400 hover:text-white">☰</button>
          <h1 className="text-sm font-semibold text-gray-300">{navItems.find(n => n.id === page)?.label}</h1>
          <StatusBadge />
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 lg:p-6">
          {page === 'overview' && <Overview />}
          {page === 'tickets' && <Tickets />}
          {page === 'router' && <Router />}
          {page === 'activity' && <Activity />}
        </div>
      </main>
    </div>
  );
}

function StatusBadge() {
  const [status, setStatus] = useState<'connected' | 'disconnected'>('disconnected');
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/health');
        setStatus(res.ok ? 'connected' : 'disconnected');
      } catch { setStatus('disconnected'); }
      setLastUpdate(new Date());
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      <span className={`inline-block w-2 h-2 rounded-full ${status === 'connected' ? 'bg-success pulse' : 'bg-danger'}`} />
      {lastUpdate && `Updated ${lastUpdate.toLocaleTimeString()}`}
    </div>
  );
}
