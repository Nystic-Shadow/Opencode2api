const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, '..', 'data', 'stats.json');

class MetricsCollector {
  constructor() {
    this.bootTime = Date.now();
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    this.totalTokens = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalReasoningTokens = 0;
    
    this.dailyTokens = {}; // YYYY-MM-DD -> token count
    this.recentRequests = []; // last 50 requests
    this.history = []; // genuine recorded time points for chart
    this.modelUsage = {}; // model -> { requests, tokens, reasoning_tokens }

    // In-memory sliding windows (last 60s)
    this.requestTimestamps = [];
    this.tokenTimestamps = []; // { t, tokens }

    this.load();
    this.startHistoryTicker();
  }

  load() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        const raw = fs.readFileSync(STATS_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.totalRequests = data.totalRequests || 0;
        this.successfulRequests = data.successfulRequests || 0;
        this.failedRequests = data.failedRequests || 0;
        this.totalTokens = data.totalTokens || 0;
        this.totalPromptTokens = data.totalPromptTokens || 0;
        this.totalCompletionTokens = data.totalCompletionTokens || 0;
        this.totalReasoningTokens = data.totalReasoningTokens || 0;
        this.dailyTokens = data.dailyTokens || {};
        this.recentRequests = data.recentRequests || [];
        this.history = data.history || [];
        this.modelUsage = data.modelUsage || {};
      }
    } catch (e) {
      console.warn('[Metrics] Error loading stats:', e.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(STATS_FILE, JSON.stringify({
        totalRequests: this.totalRequests,
        successfulRequests: this.successfulRequests,
        failedRequests: this.failedRequests,
        totalTokens: this.totalTokens,
        totalPromptTokens: this.totalPromptTokens,
        totalCompletionTokens: this.totalCompletionTokens,
        totalReasoningTokens: this.totalReasoningTokens,
        dailyTokens: this.dailyTokens,
        recentRequests: this.recentRequests.slice(0, 50),
        history: this.history.slice(-60),
        modelUsage: this.modelUsage
      }, null, 2), 'utf8');
    } catch (e) {
      console.error('[Metrics] Error saving stats:', e.message);
    }
  }

  startHistoryTicker() {
    // Record real sample point every 60 seconds
    setInterval(() => {
      this.recordSample();
    }, 60000);
  }

  recordSample() {
    const rpm = this.getRPM();
    const tpm = this.getTPM();
    const successRate = this.getSuccessRate();
    const avgLatency = this.getAverageLatency();

    const sample = {
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      rpm,
      tpm,
      latency: avgLatency,
      successRate: parseFloat(successRate.toFixed(1))
    };

    this.history.push(sample);
    if (this.history.length > 60) {
      this.history = this.history.slice(-60);
    }
    this.save();
  }

  recordRequest({ model = 'unknown', status = 200, tokens = {}, latencyMs = 0, stream = false, keyId = '' }) {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    const isSuccess = status >= 200 && status < 300;
    this.totalRequests++;
    if (isSuccess) {
      this.successfulRequests++;
    } else {
      this.failedRequests++;
    }

    const pTokens = tokens.prompt_tokens || 0;
    const cTokens = tokens.completion_tokens || 0;
    const rTokens = tokens.reasoning_tokens || 0;
    const reqTokens = tokens.total_tokens || (pTokens + cTokens);

    this.totalTokens += reqTokens;
    this.totalPromptTokens += pTokens;
    this.totalCompletionTokens += cTokens;
    this.totalReasoningTokens += rTokens;

    this.dailyTokens[today] = (this.dailyTokens[today] || 0) + reqTokens;

    // Per model aggregation
    if (!this.modelUsage[model]) {
      this.modelUsage[model] = { requests: 0, tokens: 0, reasoning_tokens: 0 };
    }
    this.modelUsage[model].requests++;
    this.modelUsage[model].tokens += reqTokens;
    this.modelUsage[model].reasoning_tokens += rTokens;

    // Sliding window tracking
    this.requestTimestamps.push(now);
    if (reqTokens > 0) {
      this.tokenTimestamps.push({ t: now, tokens: reqTokens });
    }

    // Recent requests
    this.recentRequests.unshift({
      id: 'req_' + Math.random().toString(36).slice(2, 9),
      model,
      status,
      tokens: reqTokens,
      prompt_tokens: pTokens,
      completion_tokens: cTokens,
      reasoning_tokens: rTokens,
      latency: latencyMs,
      stream,
      keyId,
      time: new Date().toISOString()
    });

    if (this.recentRequests.length > 50) {
      this.recentRequests = this.recentRequests.slice(0, 50);
    }

    // Record sample if history is empty
    if (this.history.length === 0) {
      this.recordSample();
    } else {
      this.save();
    }
  }

  getRPM() {
    const cutoff = Date.now() - 60000;
    this.requestTimestamps = this.requestTimestamps.filter(t => t > cutoff);
    return this.requestTimestamps.length;
  }

  getTPM() {
    const cutoff = Date.now() - 60000;
    this.tokenTimestamps = this.tokenTimestamps.filter(e => e.t > cutoff);
    return this.tokenTimestamps.reduce((sum, e) => sum + e.tokens, 0);
  }

  getSuccessRate() {
    if (this.totalRequests === 0) return 100.0;
    return (this.successfulRequests / this.totalRequests) * 100.0;
  }

  getAverageLatency() {
    if (this.recentRequests.length === 0) return 0;
    const sum = this.recentRequests.reduce((acc, r) => acc + (r.latency || 0), 0);
    return Math.round(sum / this.recentRequests.length);
  }

  getAverageTPS() {
    const successful = this.recentRequests.filter(r => r.status >= 200 && r.status < 300 && r.latency > 0);
    if (successful.length === 0) return 0;
    const totalCompTokens = successful.reduce((acc, r) => acc + (r.completion_tokens || 0), 0);
    const totalSeconds = successful.reduce((acc, r) => acc + (r.latency / 1000), 0);
    return totalSeconds > 0 ? parseFloat((totalCompTokens / totalSeconds).toFixed(1)) : 0;
  }

  getAverageTokensPerDay() {
    const days = Object.keys(this.dailyTokens);
    if (days.length === 0) return this.totalTokens;
    const totalDaily = days.reduce((sum, d) => sum + this.dailyTokens[d], 0);
    return Math.round(totalDaily / days.length);
  }

  getUptimeSeconds() {
    return Math.floor(process.uptime());
  }

  getStats() {
    const streamCount = this.recentRequests.filter(r => r.stream).length;
    const nonStreamCount = this.recentRequests.length - streamCount;
    const historyList = this.history.length > 0 ? this.history : [{
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      rpm: this.getRPM(),
      tpm: this.getTPM(),
      latency: this.getAverageLatency(),
      successRate: this.getSuccessRate()
    }];

    return {
      uptimeSeconds: this.getUptimeSeconds(),
      uptime_seconds: this.getUptimeSeconds(),
      bootTime: this.bootTime,
      boot_time: this.bootTime,
      rpm: this.getRPM(),
      tpm: this.getTPM(),
      averageLatency: this.getAverageLatency(),
      average_latency: this.getAverageLatency(),
      averageTPS: this.getAverageTPS(),
      average_tps: this.getAverageTPS(),
      totalRequests: this.totalRequests,
      total_requests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      success_requests: this.successfulRequests,
      failedRequests: this.failedRequests,
      failed_requests: this.failedRequests,
      successRate: parseFloat(this.getSuccessRate().toFixed(1)),
      success_rate: parseFloat(this.getSuccessRate().toFixed(1)),
      totalTokens: this.totalTokens,
      total_tokens: this.totalTokens,
      totalPromptTokens: this.totalPromptTokens,
      total_prompt_tokens: this.totalPromptTokens,
      totalCompletionTokens: this.totalCompletionTokens,
      total_completion_tokens: this.totalCompletionTokens,
      totalReasoningTokens: this.totalReasoningTokens,
      total_reasoning_tokens: this.totalReasoningTokens,
      averageTokensPerDay: this.getAverageTokensPerDay(),
      modelUsage: this.modelUsage,
      models: this.modelUsage,
      streamDistribution: {
        stream: streamCount,
        nonStream: nonStreamCount
      },
      recentRequests: this.recentRequests.slice(0, 30),
      recent_requests: this.recentRequests.slice(0, 30),
      history: historyList,
      time_series: historyList
    };
  }
}

module.exports = new MetricsCollector();
