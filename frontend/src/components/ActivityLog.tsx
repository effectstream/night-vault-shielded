export function ActivityLog({ logs }: { logs: string[] }) {
  return (
    <div className="card">
      <h2>Activity</h2>
      <div className="log mono">
        {logs.length === 0 ? <div className="muted">Nothing yet.</div> : logs.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
