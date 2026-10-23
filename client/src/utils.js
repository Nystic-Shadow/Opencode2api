/**
 * Format milliseconds into human-readable seconds:
 * e.g. 1200ms -> "1.2s", 10000ms -> "10s", 8119ms -> "8.1s", 500ms -> "0.5s", 71535ms -> "71.5s"
 */
export function formatLatencySec(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '0s';
  const val = Number(ms);
  if (val <= 0) return '0s';
  const sec = val / 1000;
  if (sec >= 100) return `${Math.round(sec)}s`;
  const formatted = sec.toFixed(1).replace(/\.0$/, '');
  return `${formatted}s`;
}

/**
 * Latency classification:
 * - Low / Ultra-Low (< 3.5s): Green (#2fbc5b)
 * - Medium (3.5s - 8.0s): Yellow (#f59e0b)
 * - High (> 8.0s): Red (#ef4444)
 */
export function getLatencyTheme(ms) {
  const val = Number(ms) || 0;
  if (val < 3500) {
    return {
      tier: 'low',
      label: 'Ultra Low',
      color: '#2fbc5b',
      bg: 'rgba(47, 188, 91, 0.12)',
      border: 'rgba(47, 188, 91, 0.3)'
    };
  }
  if (val <= 8000) {
    return {
      tier: 'medium',
      label: 'Medium',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.3)'
    };
  }
  return {
    tier: 'high',
    label: 'High Latency',
    color: '#ef4444',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'rgba(239, 68, 68, 0.3)'
  };
}
