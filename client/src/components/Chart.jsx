import React, { useState } from 'react';

export default function Chart({ data = [], metric = 'rpm', label = 'Requests Per Minute' }) {
  const [hoverIndex, setHoverIndex] = useState(null);

  if (!data || data.length < 2) {
    return (
      <div style={{ height: '180px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted-foreground)', fontSize: '0.85rem' }}>
        Awaiting telemetry samples...
      </div>
    );
  }

  const values = data.map(d => {
    const raw = d[metric] !== undefined ? d[metric] : 0;
    return metric === 'latency' ? Number((raw / 1000).toFixed(1)) : raw;
  });
  const maxVal = Math.max(...values, 5);
  const minVal = 0;

  const width = 600;
  const height = 160;
  const paddingX = 20;
  const paddingY = 20;

  const chartW = width - paddingX * 2;
  const chartH = height - paddingY * 2;

  const points = values.map((val, i) => {
    const x = paddingX + (i / (values.length - 1)) * chartW;
    const y = paddingY + chartH - ((val - minVal) / (maxVal - minVal)) * chartH;
    return { x, y, val, timestamp: data[i].timestamp };
  });

  const pathD = points.reduce((acc, pt, i) => {
    return i === 0 ? `M ${pt.x},${pt.y}` : `${acc} L ${pt.x},${pt.y}`;
  }, '');

  // Fill area under path
  const areaD = `${pathD} L ${points[points.length - 1].x},${height - paddingY} L ${points[0].x},${height - paddingY} Z`;

  return (
    <div style={{ position: 'relative', width: '100%', height: '180px' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: '100%', overflow: 'visible' }}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Horizontal reference grid lines */}
        {[0, 0.5, 1].map((ratio, i) => {
          const y = paddingY + chartH * ratio;
          return (
            <line
              key={i}
              x1={paddingX}
              y1={y}
              x2={width - paddingX}
              y2={y}
              stroke="var(--border)"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
          );
        })}

        {/* Fill Area */}
        <path d={areaD} fill="url(#chartGradient)" />

        {/* Stroke Line */}
        <path
          d={pathD}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Points & Hover Target */}
        {points.map((pt, i) => (
          <g key={i} onMouseEnter={() => setHoverIndex(i)} onMouseLeave={() => setHoverIndex(null)}>
            <circle
              cx={pt.x}
              cy={pt.y}
              r={hoverIndex === i ? 5 : 2}
              fill="var(--card)"
              stroke="var(--primary)"
              strokeWidth={hoverIndex === i ? 2.5 : 1.5}
              style={{ cursor: 'pointer', transition: 'r 0.1s ease' }}
            />
          </g>
        ))}
      </svg>

      {/* Tooltip */}
      {hoverIndex !== null && points[hoverIndex] && (
        <div style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          backgroundColor: 'var(--popover)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '0.4rem 0.65rem',
          fontSize: '0.75rem',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          pointerEvents: 'none'
        }}>
          <div style={{ color: 'var(--muted-foreground)' }}>{points[hoverIndex].timestamp}</div>
          <div style={{ fontWeight: '700', color: 'var(--primary)' }}>
            {metric === 'latency' ? `${points[hoverIndex].val}s` : `${points[hoverIndex].val} ${label}`}
          </div>
        </div>
      )}
    </div>
  );
}
