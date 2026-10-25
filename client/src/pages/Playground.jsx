import React, { useState, useRef, useEffect } from 'react';
import {
  FiPlay,
  FiSend,
  FiStopCircle,
  FiImage,
  FiTrash2,
  FiCopy,
  FiCheck,
  FiSliders,
  FiCpu,
  FiChevronDown,
  FiChevronRight,
  FiX,
  FiZap,
  FiEye,
  FiAlertCircle
} from '../components/Icons';

import MarkdownRenderer from '../components/MarkdownRenderer';
import CustomSelect from '../components/CustomSelect';
import { formatLatencySec, getLatencyTheme } from '../utils';

export default function Playground({ models = [], token }) {
  const [selectedModel, setSelectedModel] = useState(models[0]?.id || '');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachedImage, setAttachedImage] = useState(null); // { base64, mimeType, name }
  const [isStreaming, setIsStreaming] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState('auto'); // auto, off, low, medium, high, max
  const [temperature, setTemperature] = useState(0.6);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [openThoughts, setOpenThoughts] = useState({}); // messageIndex -> boolean

  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Sync selected model if list loads later
  useEffect(() => {
    if (models.length > 0 && !models.find(m => m.id === selectedModel)) {
      setSelectedModel(models[0].id);
    }
  }, [models]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const currentModelMeta = models.find(m => m.id === selectedModel);
  const supportsVision = currentModelMeta?.supports_vision === true;

  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (PNG, JPEG, WebP, etc.)');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64Data = dataUrl.split(',')[1];
      setAttachedImage({
        dataUrl,
        base64: base64Data,
        mimeType: file.type,
        name: file.name
      });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleCopy = (text, index) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const toggleThought = (index) => {
    setOpenThoughts(prev => ({ ...prev, [index]: !prev[index] }));
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsStreaming(false);
    }
  };

  const handleClear = () => {
    if (isStreaming) handleStop();
    setMessages([]);
    setAttachedImage(null);
  };

  const handleModelChange = (newModelId) => {
    setSelectedModel(newModelId);
    if (messages.length > 0) {
      handleClear();
    }
  };

  const handleSend = async (overridePrompt = null) => {
    const textToSend = overridePrompt || input.trim();
    if (!textToSend && !attachedImage) return;

    const userMessage = {
      role: 'user',
      content: textToSend,
      image: attachedImage ? { ...attachedImage } : null,
      timestamp: new Date().toLocaleTimeString()
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    const sentImage = attachedImage;
    setAttachedImage(null);

    // Prepare assistant placeholder message
    const assistantIndex = newMessages.length;
    const placeholderAssistant = {
      role: 'assistant',
      content: '',
      reasoning: '',
      isGenerating: true,
      latencyMs: null,
      model: selectedModel,
      timestamp: new Date().toLocaleTimeString()
    };
    setMessages([...newMessages, placeholderAssistant]);
    setOpenThoughts(prev => ({ ...prev, [assistantIndex]: true }));
    setIsStreaming(true);

    const startTime = Date.now();
    abortControllerRef.current = new AbortController();

    try {
      // Build API payload
      const apiMessages = [];
      if (systemPrompt && systemPrompt.trim()) {
        apiMessages.push({ role: 'system', content: systemPrompt.trim() });
      }

      for (const m of newMessages) {
        if (m.image) {
          apiMessages.push({
            role: m.role,
            content: [
              { type: 'text', text: m.content || 'Describe this image' },
              {
                type: 'image_url',
                image_url: { url: `data:${m.image.mimeType};base64,${m.image.base64}` }
              }
            ]
          });
        } else {
          apiMessages.push({ role: m.role, content: m.content });
        }
      }

      const res = await fetch('/api/playground/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: apiMessages,
          temperature: parseFloat(temperature),
          max_tokens: parseInt(maxTokens, 10),
          thinking_level: thinkingLevel !== 'auto' ? thinkingLevel : undefined,
          stream: true
        }),
        signal: abortControllerRef.current.signal
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}: Failed to generate response`;
        try {
          const errText = await res.text();
          try {
            const errJson = JSON.parse(errText);
            errMsg = errJson.error?.message || errJson.message || errText || errMsg;
          } catch (e) {
            errMsg = errText || errMsg;
          }
        } catch (e) {}
        throw new Error(errMsg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let accumulatedContent = '';
      let accumulatedReasoning = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta) {
              if (delta.reasoning_content) {
                accumulatedReasoning += delta.reasoning_content;
              }
              if (delta.content) {
                accumulatedContent += delta.content;
              }

              // Update the assistant message in real time
              setMessages(prev => {
                const copy = [...prev];
                if (copy[assistantIndex]) {
                  copy[assistantIndex] = {
                    ...copy[assistantIndex],
                    content: accumulatedContent,
                    reasoning: accumulatedReasoning,
                    isGenerating: true
                  };
                }
                return copy;
              });
            }
          } catch (e) {}
        }
      }

      const totalLatency = Date.now() - startTime;
      if (accumulatedReasoning && !accumulatedContent) {
        setOpenThoughts(prev => ({ ...prev, [assistantIndex]: true }));
      }
      setMessages(prev => {
        const copy = [...prev];
        if (copy[assistantIndex]) {
          copy[assistantIndex] = {
            ...copy[assistantIndex],
            content: accumulatedContent || (accumulatedReasoning ? '' : '(No content generated)'),
            reasoning: accumulatedReasoning,
            isGenerating: false,
            latencyMs: totalLatency
          };
        }
        return copy;
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages(prev => {
          const copy = [...prev];
          if (copy[assistantIndex]) {
            copy[assistantIndex].isGenerating = false;
            copy[assistantIndex].content += ' [Generation halted]';
          }
          return copy;
        });
      } else {
        setMessages(prev => {
          const copy = [...prev];
          if (copy[assistantIndex]) {
            copy[assistantIndex] = {
              role: 'assistant',
              content: `Error: ${err.message}`,
              isGenerating: false,
              isError: true,
              timestamp: new Date().toLocaleTimeString()
            };
          }
          return copy;
        });
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
  };

  return (
    <div className="playground-container">
      {/* Top Controls Bar */}
      <div className="glass-card" style={{ padding: '0.85rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', position: 'relative', zIndex: 60 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          {/* Model Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: '240px' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--muted-foreground)' }}>Model:</span>
            <CustomSelect
              value={selectedModel}
              onChange={handleModelChange}
              options={models.map(m => ({
                value: m.id,
                label: m.name || m.id,
                badge: m.is_free ? (m.supports_vision ? 'Free • Vision' : 'Free') : 'Paid',
                description: m.description,
                icon: FiCpu
              }))}
              placeholder="Select model..."
              style={{ minWidth: '220px', flex: 1 }}
            />
          </div>

          {/* Model Capability Badges */}
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            {currentModelMeta?.is_free ? (
              <span className="badge badge-success">Free Tier</span>
            ) : (
              <span className="badge" style={{ backgroundColor: 'rgba(234, 179, 8, 0.15)', color: '#eab308', border: '1px solid rgba(234, 179, 8, 0.3)' }}>
                Paid / Zen Key
              </span>
            )}
            {supportsVision ? (
              <span className="badge badge-success" title="Multimodal vision supported">
                <FiEye size={12} style={{ marginRight: '4px' }} /> Vision Ready
              </span>
            ) : (
              <span className="badge badge-muted" title="Text-only model">Text Only</span>
            )}
            <span className="badge badge-info font-mono">
              {currentModelMeta?.context_window ? `${Math.round(currentModelMeta.context_window / 1024)}k Context` : 'Zen'}
            </span>
          </div>

          {/* Thinking Level Selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: '180px' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--muted-foreground)' }}>Thinking:</span>
            <CustomSelect
              value={thinkingLevel}
              onChange={setThinkingLevel}
              options={[
                { value: 'auto', label: 'Auto (Default)' },
                { value: 'off', label: 'Off (Fast / No Think)' },
                { value: 'low', label: 'Low (4k Budget)' },
                { value: 'medium', label: 'Medium (16k Budget)' },
                { value: 'high', label: 'High (32k Budget)' },
                { value: 'max', label: 'Max (64k Extended)' }
              ]}
              searchable={false}
              style={{ minWidth: '160px', flex: 1 }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            className="btn-secondary"
            style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
            onClick={() => setShowSystemPrompt(!showSystemPrompt)}
          >
            <FiSliders size={14} />
            <span>Parameters & System</span>
          </button>

          {messages.length > 0 && (
            <button
              className="btn-secondary"
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
              onClick={handleClear}
              disabled={isStreaming}
            >
              <FiTrash2 size={14} />
              <span>Clear Chat</span>
            </button>
          )}
        </div>
      </div>

      {/* System Prompt & Parameter Drawer */}
      {showSystemPrompt && (
        <div className="glass-card" style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', position: 'relative', zIndex: 40 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: '700' }}>System Instructions & Inference Hyperparameters</span>
            <button
              onClick={() => setShowSystemPrompt(false)}
              style={{ background: 'transparent', border: 'none', color: 'var(--muted-foreground)', cursor: 'pointer' }}
            >
              <FiX size={16} />
            </button>
          </div>
          <textarea
            className="input-field"
            rows={2}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="Set model behavior or persona..."
            style={{ width: '100%', resize: 'vertical', fontSize: '0.85rem' }}
          />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.25rem', marginTop: '0.25rem' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--muted-foreground)', marginBottom: '0.35rem' }}>
                <span>Temperature</span>
                <span className="font-mono">{temperature}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: 'var(--muted-foreground)', marginBottom: '0.35rem' }}>
                <span>Max Output Tokens</span>
                <span className="font-mono">{maxTokens}</span>
              </div>
              <input
                type="range"
                min="256"
                max="16384"
                step="256"
                value={maxTokens}
                onChange={(e) => setMaxTokens(parseInt(e.target.value, 10))}
              />
            </div>
          </div>
        </div>
      )}

      {/* Message Feed */}
      <div className="glass-card messages-stream" style={{ position: 'relative', zIndex: 10 }}>
        {messages.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', maxWidth: '480px', padding: '2rem 1rem' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '16px', background: 'rgba(47, 188, 91, 0.12)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem auto' }}>
              <FiPlay size={28} />
            </div>
            <h3 style={{ fontSize: '1.2rem', fontWeight: '700', marginBottom: '0.5rem' }}>Interactive Test Playground</h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--muted-foreground)', marginBottom: '1.5rem', lineHeight: '1.5' }}>
              Directly talk with discovered OpenCode Zen models. Inspect live thinking tokens, stream responses, and upload vision assets.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button
                className="btn-secondary"
                style={{ textAlign: 'left', padding: '0.6rem 1rem', fontSize: '0.82rem' }}
                onClick={() => handleSend("Explain quantum superposition and why it differs from classical probability in 3 concise bullet points.")}
              >
                <FiZap size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                <span>Test Deep Thinking & Reasoning</span>
              </button>

              <button
                className="btn-secondary"
                style={{ textAlign: 'left', padding: '0.6rem 1rem', fontSize: '0.82rem' }}
                onClick={() => handleSend("Write a high-performance Python generator that implements an LRU cache with TTL expiration.")}
              >
                <FiCpu size={14} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                <span>Test Code Architecture Generation</span>
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <div key={idx} className={`message-bubble ${msg.role}`}>
              {/* User Attached Image Thumbnail */}
              {msg.image && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <img
                    src={msg.image.dataUrl}
                    alt={msg.image.name}
                    style={{ maxHeight: '180px', maxWidth: '100%', borderRadius: 'calc(var(--radius) - 2px)', border: '1px solid var(--border)' }}
                  />
                  <div style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)', marginTop: '0.2rem' }}>
                    {msg.image.name}
                  </div>
                </div>
              )}

              {/* Collapsible Reasoning Trace (Thinking Process) */}
              {msg.role === 'assistant' && msg.reasoning && (
                <div className="thought-box">
                  <div className="thought-header" onClick={() => toggleThought(idx)}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <FiZap size={13} style={{ color: 'var(--primary)' }} />
                      <span>Thinking Trace ({Math.ceil(msg.reasoning.length / 4)} tokens)</span>
                      {msg.isGenerating && (
                        <span className="thinking-pulse badge badge-success" style={{ fontSize: '0.68rem', padding: '0.1rem 0.4rem' }}>
                          Reasoning...
                        </span>
                      )}
                    </div>
                    {openThoughts[idx] ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                  </div>
                  {openThoughts[idx] && (
                    <div className="thought-content">
                      {msg.reasoning}
                    </div>
                  )}
                </div>
              )}

              {/* Message Content */}
              {msg.role === 'assistant' ? (
                <div>
                  <MarkdownRenderer content={msg.content} />
                  {msg.isGenerating && !msg.content && !msg.reasoning && (
                    <span className="thinking-pulse" style={{ color: 'var(--muted-foreground)', fontSize: '0.85rem' }}>
                      Connecting to OpenCode Zen inference node...
                    </span>
                  )}
                  {msg.isGenerating && msg.content && (
                    <span style={{ display: 'inline-block', width: '6px', height: '14px', background: 'var(--primary)', marginLeft: '4px', verticalAlign: 'middle' }} />
                  )}
                </div>
              ) : (
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.9rem' }}>
                  {msg.content}
                </div>
              )}

              {/* Assistant Message Footer Metadata */}
              {msg.role === 'assistant' && !msg.isGenerating && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)', fontSize: '0.72rem', color: 'var(--muted-foreground)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span className="font-mono">{msg.model || selectedModel}</span>
                    {msg.latencyMs && (() => {
                      const theme = getLatencyTheme(msg.latencyMs);
                      return (
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          color: theme.color,
                          fontWeight: '600'
                        }}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: theme.color }} />
                          {formatLatencySec(msg.latencyMs)}
                        </span>
                      );
                    })()}
                    {msg.content && <span>~{Math.ceil(msg.content.length / 4)} tokens</span>}
                  </div>
                  <button
                    onClick={() => handleCopy(msg.content, idx)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--muted-foreground)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                    title="Copy response"
                  >
                    {copiedIndex === idx ? <FiCheck size={13} style={{ color: 'var(--primary)' }} /> : <FiCopy size={13} />}
                    <span>{copiedIndex === idx ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Image Preview Thumbnail before sending */}
      {attachedImage && (
        <div className="glass-card" style={{ padding: '0.5rem 0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <img
              src={attachedImage.dataUrl}
              alt="attachment"
              style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '6px', border: '1px solid var(--border)' }}
            />
            <div>
              <div style={{ fontSize: '0.8rem', fontWeight: '600' }}>{attachedImage.name}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--muted-foreground)' }}>
                {(attachedImage.base64.length * 0.75 / 1024).toFixed(1)} KB (Base64 ready)
              </div>
            </div>
          </div>
          <button
            onClick={() => setAttachedImage(null)}
            style={{ background: 'transparent', border: 'none', color: 'var(--destructive)', cursor: 'pointer', padding: '0.25rem' }}
            title="Remove image"
          >
            <FiX size={16} />
          </button>
        </div>
      )}

      {/* Input Box Area */}
      <div className="glass-card" style={{ padding: '0.85rem 1.25rem', display: 'flex', alignItems: 'flex-end', gap: '0.75rem', position: 'relative', zIndex: 10 }}>
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleImageSelect}
          style={{ display: 'none' }}
          accept="image/*"
        />

        <button
          className="btn-secondary"
          onClick={() => fileInputRef.current?.click()}
          disabled={!supportsVision}
          title={supportsVision ? "Upload image for vision analysis" : "Vision not supported by current model"}
          style={{ padding: '0.6rem', borderRadius: 'var(--radius)', opacity: supportsVision ? 1 : 0.4, cursor: supportsVision ? 'pointer' : 'not-allowed' }}
        >
          <FiImage size={18} />
        </button>

        <textarea
          className="input-field"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={supportsVision ? "Type a prompt or attach an image (Enter to send, Shift+Enter for newline)..." : "Type a prompt (Enter to send)..."}
          rows={1}
          style={{
            flex: 1,
            minHeight: '44px',
            maxHeight: '140px',
            resize: 'none',
            fontSize: '0.9rem',
            paddingTop: '0.65rem'
          }}
          disabled={isStreaming}
        />

        {isStreaming ? (
          <button className="btn-danger" onClick={handleStop} style={{ padding: '0.6rem 1rem' }}>
            <FiStopCircle size={18} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="btn-primary"
            onClick={() => handleSend()}
            disabled={!input.trim() && !attachedImage}
            style={{ padding: '0.6rem 1.1rem' }}
          >
            <FiSend size={16} />
            <span>Send</span>
          </button>
        )}
      </div>
    </div>
  );
}
