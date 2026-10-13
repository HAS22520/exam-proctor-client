import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiagnosticEntry } from '../../types/status';
import { diagnosticLine } from '../lib/status-view';

export function ConsolePage() {
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [query, setQuery] = useState(''), [level, setLevel] = useState(''), [follow, setFollow] = useState(true);
  const [status, setStatus] = useState('正在读取启动记录…'), [file, setFile] = useState<string | null>(null);
  const logs = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let active = true, cursor = 0, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await window.debugAPI.logs(cursor);
        if (!active) return;
        cursor = result.latest;
        setEntries((old) => [...old, ...result.entries].slice(-1000));
        setFile(result.file);
        setStatus(`实时连接 · ${new Date().toLocaleTimeString()}`);
      } catch { if (active) setStatus('控制台连接失败或管理员身份已失效'); }
      if (active) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const visible = useMemo(() => entries.filter((entry) =>
    (!level || entry.level === 'error' || (level === 'warn' && entry.level === 'warn')) && diagnosticLine(entry).toLowerCase().includes(query.toLowerCase())), [entries, query, level]);
  useEffect(() => { if (follow && logs.current) logs.current.scrollTop = logs.current.scrollHeight; }, [visible, follow]);
  return <div className="console-page">
    <header><div><h1>调试控制台</h1><p>主进程运行记录 · 最近 1,000 条 · 仅已验证的 root 管理员可用</p></div>
      <button onClick={() => window.debugAPI.devtools().catch(() => setStatus('管理员身份已失效'))}>打开页面开发工具</button></header>
    <nav><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="筛选阶段或错误" aria-label="筛选日志"/>
      <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="日志级别"><option value="">所有级别</option><option value="error">错误</option><option value="warn">警告与错误</option></select>
      <label><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)}/>自动滚动</label>
      <button onClick={() => navigator.clipboard.writeText(visible.map(diagnosticLine).join('\n')).then(() => setStatus('已复制当前显示的日志'), () => setStatus('复制失败，可直接选中日志复制'))}>复制当前日志</button></nav>
    <p role="status">{status} · {entries.length} 条记录</p>
    <pre ref={logs} id="logs" aria-label="运行日志">{visible.map((entry) => <div key={entry.id} className={entry.level}>{diagnosticLine(entry)}</div>)}</pre>
    <footer>{file ? `诊断文件：${file}（每次启动最多 4 MiB，保留最近 3 次）` : '本次未写入诊断文件'}</footer>
  </div>;
}
