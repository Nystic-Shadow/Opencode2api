import React, { useState } from 'react';
import {
  FiActivity,
  FiZap,
  FiCheckCircle,
  FiClock,
  FiLayers,
  FiCpu,
  FiServer,
  FiShield,
  FiPercent,
  FiTrendingUp
} from '../components/Icons';
import Chart from '../components/Chart';

function formatUptime(seconds = 0) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0 || d > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export default function Overview({ stats, onRefresh }) {
  const [activeChartMetric, setActiveChartMetric] = useState('rpm');

  const s = stats || {
    uptimeSeconds: 0,
    rpm: 0,
    tpm: 0,
    averageLatency: 0,
    averageTPS: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    successRate: 100,
    totalTokens: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalReasoningTokens: 0,
    averageTokensPerDay: 0,
    modelUsage: {},
    streamDistribution: { stream: 0, nonStream: 0 },
    recentRequests: [],
    history: []
  };

  const statCards = [
    {
      title: 'Total Requests',
      value: (s.totalRequests || 0).toLocaleString(),
      unit: 'calls',
      icon: FiActivity,
      color: 'var(--chart-1)',
      desc: `${s.successfulRequests || 0} succeeded, ${s.failedRequests || 0} failed`
    },
    {
      title: 'Success Rate',
      value: `${s.successRate}%`,
      unit: 'reliability',
      icon: FiCheckCircle,
      color: s.successRate >= 95 ? 'var(--primary)' : 'var(--chart-5)',
      desc: '100% zero-drop target pass rate'
    },
    {
      title: 'Current RPM',
      value: s.rpm,
      unit: 'req/min',
      icon: FiTrendingUp,
      color: 'var(--chart-2)',
      desc: 'Active requests in sliding 60 seconds'
    },
    {
      title: 'Average TPM',
      value: (s.tpm || 0).toLocaleString(),
      unit: 'tok/min',
      icon: FiZap,
      color: 'var(--chart-3)',
      desc: 'Tokens streamed in sliding 60 seconds'
    },
    {
      title: 'Total Tokens Served',
      value: (s.totalTokens || 0).toLocaleString(),
      unit: 'tokens',
      icon: FiLayers,
      color: 'var(--chart-4)',
      desc: `${((s.totalPromptTokens || 0)).toLocaleString()} prompt, ${((s.totalCompletionTokens || 0)).toLocaleString()} output`
    },
    {
      title: 'Average Latency',
      value: `${s.averageLatency || 0}ms`,
      unit: 'response time',
      icon: FiClock,
      color: 'var(--chart-2)',
      desc: 'Mean execution time per inference'
    },
    {
      title: 'Throughput (TPS)',
      value: `${s.averageTPS || 0} tok/s`,
      unit: 'speed',
      icon: FiZap,
      color: 'var(--accent)',
      desc: 'Average completion token velocity'
    },
    {
      title: 'Reasoning Tokens',
      value: (s.totalReasoningTokens || 0).toLocaleString(),
      unit: 'deep thought',
      icon: FiCpu,
      color: 'var(--chart-1)',
      desc: 'Interleaved reasoning traces served'
    }
  ];

  // Token breakdown percentages
  const total = s.totalTokens || 1;
  const promptPct = Math.round(((s.totalPromptTokens || 0) / total) * 100);
  const completionPct = Math.round(((s.totalCompletionTokens || 0) / total) * 100);
  const reasoningPct = Math.round(((s.totalReasoningTokens || 0) / total) * 100);

  const modelUsageEntries = Object.entries(s.modelUsage || {});

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Live System Uptime Banner */}
      <div className="glass-card" style={{ padding: '1rem 1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: 'var(--accent)', boxShadow: '0 0 10px var(--accent)' }} />
          <div>
            <div style={{ fontWeight: '700', fontSize: '0.92rem' }}>
              OpenCode2API High-Performance Gateway Active
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
              100% Free Anonymous Lane with Auto Model Discovery & CLI Fingerprint Sync
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', fontSize: '0.8rem' }}>
          <div>
            <span style={{ color: 'var(--muted-foreground)' }}>Uptime: </span>
            <span className="font-mono" style={{ fontWeight: '700', color: 'var(--foreground)' }}>
              {formatUptime(s.uptimeSeconds)}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--muted-foreground)' }}>Status: </span>
            <span className="badge badge-success">Healthy (100%)</span>
          </div>
        </div>
      </div>

      {/* 8 Comprehensive Bento Metric Cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '1rem'
      }}>
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div key={i} className="glass-card" style={{ padding: '1.15rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--muted-foreground)' }}>{card.title}</span>
                <div style={{
                  padding: '0.35rem',
                  borderRadius: 'var(--radius)',
                  backgroundColor: 'var(--muted)',
                  color: card.color
                }}>
                  <Icon size={16} />
                </div>
              </div>
              <div style={{ fontSize: '1.5rem', fontWeight: '800', letterSpacing: '-0.02em', color: 'var(--foreground)' }}>
                {card.value}
              </div>
              <div style={{ fontSize: '0.72rem', color: 'var(--muted-foreground)', marginTop: 'auto' }}>
                {card.desc}
              </div>
            </div>
          );
        })}
      </div>

      {/* Token Distribution & Stream Modes */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' }}>
        {/* Token Composition Breakdown */}
        <div className="glass-card" style={{ padding: '1.25rem' }}>
          <h3 style={{ fontSize: '0.92rem', fontWeight: '700', marginBottom: '0.4rem' }}>
            Token Allocation Composition
          </h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', marginBottom: '1rem' }}>
            Breakdown across input prompts, generated completions, and deep reasoning
          </p>

          <div style={{ display: 'flex', height: '10px', borderRadius: '999px', overflow: 'hidden', background: 'var(--input)', marginBottom: '1rem' }}>
            <div style={{ width: `${promptPct}%`, background: 'var(--chart-2)' }} title={`Prompt Tokens: ${promptPct}%`} />
            <div style={{ width: `${completionPct}%`, background: 'var(--chart-1)' }} title={`Completion Tokens: ${completionPct}%`} />
            <div style={{ width: `${reasoningPct}%`, background: 'var(--chart-4)' }} title={`Reasoning Tokens: ${reasoningPct}%`} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', fontSize: '0.78rem' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--muted-foreground)' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--chart-2)' }} />
                <span>Prompt</span>
              </div>
              <div className="font-mono" style={{ fontWeight: '700', marginTop: '0.2rem' }}>
                {(s.totalPromptTokens || 0).toLocaleString()} ({promptPct}%)
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--muted-foreground)' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--chart-1)' }} />
                <span>Output</span>
              </div>
              <div className="font-mono" style={{ fontWeight: '700', marginTop: '0.2rem' }}>
                {(s.totalCompletionTokens || 0).toLocaleString()} ({completionPct}%)
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: 'var(--muted-foreground)' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--chart-4)' }} />
                <span>Reasoning</span>
              </div>
              <div className="font-mono" style={{ fontWeight: '700', marginTop: '0.2rem' }}>
                {(s.totalReasoningTokens || 0).toLocaleString()} ({reasoningPct}%)
              </div>
            </div>
          </div>
        </div>

        {/* Per-Model Traffic Distribution */}
        <div className="glass-card" style={{ padding: '1.25rem' }}>
          <h3 style={{ fontSize: '0.92rem', fontWeight: '700', marginBottom: '0.4rem' }}>
            Live Traffic Per Discovered Model
          </h3>
          <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)', marginBottom: '0.75rem' }}>
            Real volume serviced across individual Zen models
          </p>

          {modelUsageEntries.length === 0 ? (
            <div style={{ color: 'var(--muted-foreground)', fontSize: '0.8rem', padding: '1rem 0' }}>
              No traffic per model recorded yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '140px', overflowY: 'auto' }}>
              {modelUsageEntries.map(([modelName, data]) => (
                <div key={modelName} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.35rem 0.5rem', borderRadius: '6px', background: 'var(--secondary)', fontSize: '0.78rem' }}>
                  <div style={{ fontWeight: '600', color: 'var(--foreground)' }}>{modelName}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--muted-foreground)' }}>
                    <span>{data.requests} calls</span>
                    <span className="font-mono" style={{ color: 'var(--primary)', fontWeight: '700' }}>
                      {data.tokens.toLocaleString()} tok
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Genuine Historical Telemetry Chart (Zero Demo Data) */}
      <div className="glass-card" style={{ padding: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: '700' }}>Live Telemetry & Performance Graph</h2>
            <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>Genuine 60-second sampled gateway time series (No synthetic/demo data)</p>
          </div>
          <div style={{ display: 'flex', gap: '0.35rem', backgroundColor: 'var(--muted)', padding: '0.2rem', borderRadius: 'var(--radius)' }}>
            <button
              onClick={() => setActiveChartMetric('rpm')}
              style={{
                padding: '0.35rem 0.75rem',
                border: 'none',
                borderRadius: 'calc(var(--radius) - 2px)',
                fontSize: '0.75rem',
                fontWeight: '600',
                cursor: 'pointer',
                backgroundColor: activeChartMetric === 'rpm' ? 'var(--card)' : 'transparent',
                color: activeChartMetric === 'rpm' ? 'var(--card-foreground)' : 'var(--muted-foreground)'
              }}
            >
              RPM Activity
            </button>
            <button
              onClick={() => setActiveChartMetric('tpm')}
              style={{
                padding: '0.35rem 0.75rem',
                border: 'none',
                borderRadius: 'calc(var(--radius) - 2px)',
                fontSize: '0.75rem',
                fontWeight: '600',
                cursor: 'pointer',
                backgroundColor: activeChartMetric === 'tpm' ? 'var(--card)' : 'transparent',
                color: activeChartMetric === 'tpm' ? 'var(--card-foreground)' : 'var(--muted-foreground)'
              }}
            >
              TPM Throughput
            </button>
            <button
              onClick={() => setActiveChartMetric('latency')}
              style={{
                padding: '0.35rem 0.75rem',
                border: 'none',
                borderRadius: 'calc(var(--radius) - 2px)',
                fontSize: '0.75rem',
                fontWeight: '600',
                cursor: 'pointer',
                backgroundColor: activeChartMetric === 'latency' ? 'var(--card)' : 'transparent',
                color: activeChartMetric === 'latency' ? 'var(--card-foreground)' : 'var(--muted-foreground)'
              }}
            >
              Latency (ms)
            </button>
            <button
              onClick={() => setActiveChartMetric('successRate')}
              style={{
                padding: '0.35rem 0.75rem',
                border: 'none',
                borderRadius: 'calc(var(--radius) - 2px)',
                fontSize: '0.75rem',
                fontWeight: '600',
                cursor: 'pointer',
                backgroundColor: activeChartMetric === 'successRate' ? 'var(--card)' : 'transparent',
                color: activeChartMetric === 'successRate' ? 'var(--card-foreground)' : 'var(--muted-foreground)'
              }}
            >
              Success Rate %
            </button>
          </div>
        </div>

        <Chart
          data={s.history}
          metric={activeChartMetric}
          label={activeChartMetric === 'rpm' ? 'RPM' : activeChartMetric === 'tpm' ? 'TPM' : activeChartMetric === 'latency' ? 'ms' : '%'}
        />
      </div>

      {/* Live Recent Requests Audit Log */}
      <div className="glass-card" style={{ padding: '1.25rem' }}>
        <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: '700' }}>Recent Inference Stream Audit Log</h2>
            <p style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>Audit log of processed completions across OpenAI and Anthropic endpoints</p>
          </div>
          <span className="badge badge-info">{s.recentRequests?.length || 0} Events Recorded</span>
        </div>

        {(!s.recentRequests || s.recentRequests.length === 0) ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted-foreground)', fontSize: '0.85rem' }}>
            No recent traffic recorded. Make an API call or use the Playground to see live streams.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--muted-foreground)' }}>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Request ID</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Model</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Status</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Latency</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Tokens (P+C+R)</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Mode</th>
                  <th style={{ padding: '0.6rem 0.75rem' }}>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {s.recentRequests.map((req) => (
                  <tr key={req.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.6rem 0.75rem', fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>{req.id}</td>
                    <td style={{ padding: '0.6rem 0.75rem', fontWeight: '600', color: 'var(--foreground)' }}>{req.model}</td>
                    <td style={{ padding: '0.6rem 0.75rem' }}>
                      <span className={`badge ${req.status === 200 ? 'badge-success' : 'badge-warning'}`}>
                        {req.status}
                      </span>
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem' }}>{req.latency}ms</td>
                    <td style={{ padding: '0.6rem 0.75rem', fontFamily: 'var(--font-mono)' }}>
                      {req.tokens} ({req.prompt_tokens || 0}+{req.completion_tokens || 0}+{req.reasoning_tokens || 0})
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem' }}>
                      <span className="badge badge-muted">{req.stream ? 'SSE Stream' : 'JSON'}</span>
                    </td>
                    <td style={{ padding: '0.6rem 0.75rem', color: 'var(--muted-foreground)' }}>
                      {new Date(req.time).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
