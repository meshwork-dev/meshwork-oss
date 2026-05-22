"use client";

import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { Conversation } from "@/lib/types";
import { useEffect, useState, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTS = [
  { value: "", label: "Auto" },
  { value: "engineer-planner", label: "Planner" },
  { value: "engineer-implementer", label: "Implementer" },
  { value: "engineer-reviewer", label: "Reviewer" },
  { value: "product-manager", label: "PM" },
  { value: "ui-engineer", label: "UI Engineer" },
  { value: "architect", label: "Architect" },
  { value: "security-agent", label: "Security" },
  { value: "qa-agent", label: "QA" },
  { value: "ask-dave-agent", label: "Ask Tom" },
];

const MODEL_COLORS: Record<string, string> = {
  "claude-opus": "bg-purple-500/20 text-purple-300",
  "claude-sonnet": "bg-teal-500/20 text-teal-300",
  "claude-haiku": "bg-blue-500/20 text-blue-300",
};

function modelBadgeClass(model?: string): string {
  if (!model) return "bg-zinc-700 text-zinc-400";
  for (const key of Object.keys(MODEL_COLORS)) {
    if (model.includes(key.replace("claude-", ""))) return MODEL_COLORS[key];
  }
  return "bg-zinc-700 text-zinc-400";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  agent?: string;
  model?: string;
  timestamp: string;
  jobId?: string;
  isStreaming?: boolean;
}

interface MeetingTurn {
  agent: string;
  content: string;
  timestamp: string;
}

interface ActiveMeeting {
  id: string;
  topic: string;
  agents: string[];
  status: "active" | "ended";
  turns: MeetingTurn[];
}

// ---------------------------------------------------------------------------
// Simple Markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Split on fenced code blocks first
  const codeBlockRe = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <span key={`text-${lastIndex}`}>
          {renderInline(text.slice(lastIndex, match.index))}
        </span>
      );
    }
    const lang = match[1] || "text";
    const code = match[2];
    nodes.push(
      <pre
        key={`code-${match.index}`}
        className="bg-zinc-800 rounded-md p-3 my-2 overflow-x-auto text-xs font-mono text-zinc-200 border border-zinc-700"
      >
        <div className="text-zinc-500 text-[10px] mb-1">{lang}</div>
        <code>{code}</code>
      </pre>
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      <span key={`text-tail`}>
        {renderInline(text.slice(lastIndex))}
      </span>
    );
  }

  return nodes;
}

function renderInline(text: string): React.ReactNode[] {
  // Split on double newlines as paragraph breaks, then render each para
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((para, pi) => {
    const lines = para.split("\n");
    const isList = lines.every((l) => /^[-*]\s/.test(l.trim()) || l.trim() === "");
    if (isList) {
      const items = lines.filter((l) => /^[-*]\s/.test(l.trim()));
      return (
        <ul key={pi} className="list-disc list-inside my-1 space-y-0.5 text-zinc-200">
          {items.map((item, ii) => (
            <li key={ii}>{renderSpans(item.replace(/^[-*]\s/, ""))}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={pi} className="my-1">
        {renderSpans(para)}
      </p>
    );
  });
}

function renderSpans(text: string): React.ReactNode[] {
  // Handle bold, inline code, links
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\(([^)]+)\))/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      parts.push(
        <code key={m.index} className="bg-zinc-800 text-teal-300 px-1 py-0.5 rounded text-[0.85em] font-mono">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      parts.push(<strong key={m.index} className="text-white font-semibold">{token.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <a key={m.index} href={m[3]} target="_blank" rel="noopener noreferrer" className="text-teal-400 underline hover:text-teal-300">
          {m[2]}
        </a>
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ---------------------------------------------------------------------------
// TypingIndicator
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-3 py-2">
      <span className="w-2 h-2 bg-teal-400 rounded-full animate-bounce [animation-delay:0ms]" />
      <span className="w-2 h-2 bg-teal-400 rounded-full animate-bounce [animation-delay:150ms]" />
      <span className="w-2 h-2 bg-teal-400 rounded-full animate-bounce [animation-delay:300ms]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConversationList
// ---------------------------------------------------------------------------

function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  loading,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  loading: boolean;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-zinc-800">
        <button
          onClick={onNew}
          className="w-full py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          + New Conversation
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading ? (
          <div className="flex justify-center py-8"><Spinner size="sm" /></div>
        ) : conversations.length === 0 ? (
          <p className="text-zinc-500 text-xs text-center py-6">No conversations yet</p>
        ) : (
          conversations.map((conv) => {
            const isActive = conv.id === activeId;
            const name = conv.channelId || conv.id;
            const time = conv.lastUpdated
              ? new Date(conv.lastUpdated).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : "";
            return (
              <button
                key={conv.id}
                onClick={() => onSelect(conv.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                  isActive
                    ? "bg-teal-500/10 border border-teal-500/30"
                    : "hover:bg-zinc-800/60 border border-transparent"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-medium truncate ${isActive ? "text-teal-400" : "text-zinc-200"}`}>
                    {name}
                  </span>
                  <span className="text-xs text-zinc-500 shrink-0">{time}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-zinc-500">{conv.messageCount} msgs</span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%]">
          <div className="bg-zinc-800 text-zinc-100 rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed">
            {message.content}
          </div>
          <p className="text-xs text-zinc-600 mt-1 text-right">{time}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[80%]">
        <div className="flex items-center gap-2 mb-1">
          {message.agent && (
            <span className="text-xs font-semibold text-teal-400 bg-teal-500/10 px-2 py-0.5 rounded-full">
              {message.agent}
            </span>
          )}
          {message.model && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${modelBadgeClass(message.model)}`}>
              {message.model.split("-").slice(-2).join("-")}
            </span>
          )}
        </div>
        <div className="bg-zinc-900 border border-zinc-800 text-zinc-200 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed">
          {message.isStreaming && !message.content ? (
            <TypingIndicator />
          ) : (
            <div className="prose-sm">{renderMarkdown(message.content)}</div>
          )}
        </div>
        <p className="text-xs text-zinc-600 mt-1">{time}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MeetingPanel
// ---------------------------------------------------------------------------

function MeetingPanel({ meeting }: { meeting: ActiveMeeting }) {
  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`w-2 h-2 rounded-full ${
            meeting.status === "active" ? "bg-teal-400 animate-pulse" : "bg-zinc-500"
          }`}
        />
        <span className="text-xs font-semibold text-zinc-300">
          Meeting: {meeting.topic}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
            meeting.status === "active"
              ? "bg-teal-500/20 text-teal-400"
              : "bg-zinc-700 text-zinc-400"
          }`}
        >
          {meeting.status}
        </span>
        <span className="text-xs text-zinc-500 ml-auto">
          {meeting.agents.join(", ")}
        </span>
      </div>
      <div className="max-h-32 overflow-y-auto space-y-1.5 pr-1">
        {meeting.turns.map((turn, i) => (
          <div key={i} className="flex gap-2 text-xs">
            <span className="text-teal-400 font-semibold shrink-0">{turn.agent}:</span>
            <span className="text-zinc-300 leading-relaxed line-clamp-2">{turn.content}</span>
          </div>
        ))}
        {meeting.turns.length === 0 && (
          <p className="text-zinc-600 text-xs">Waiting for agents to respond...</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageInput
// ---------------------------------------------------------------------------

function MessageInput({
  onSend,
  disabled,
  selectedAgent,
  onAgentChange,
}: {
  onSend: (text: string, agent: string) => void;
  disabled: boolean;
  selectedAgent: string;
  onAgentChange: (agent: string) => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Detect slash commands for display hints
  const slashHint = (() => {
    const trimmed = text.trim();
    if (trimmed.startsWith("/agent ")) return "Route to specific agent: /agent <name> <task>";
    if (trimmed.startsWith("/meeting ")) return "Start a meeting: /meeting start <topic> @agent1 @agent2";
    return null;
  })();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!text.trim() || disabled) return;
        onSend(text.trim(), selectedAgent);
        setText("");
      }
    },
    [text, disabled, selectedAgent, onSend]
  );

  // Auto-grow textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      const scrollH = textareaRef.current.scrollHeight;
      const lineH = 24;
      const maxH = lineH * 4 + 20;
      textareaRef.current.style.height = `${Math.min(scrollH, maxH)}px`;
    }
  }, [text]);

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-3">
      {slashHint && (
        <div className="text-xs text-teal-400 bg-teal-500/10 px-3 py-1.5 rounded-lg mb-2 border border-teal-500/20">
          {slashHint}
        </div>
      )}
      <div className="flex gap-2 items-end">
        {/* Agent selector */}
        <select
          value={selectedAgent}
          onChange={(e) => onAgentChange(e.target.value)}
          className="shrink-0 bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs rounded-lg px-2 py-2 focus:outline-none focus:border-teal-500 h-9"
        >
          {AGENTS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>

        {/* Text area */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message... (Enter to send, Shift+Enter for newline)"
          disabled={disabled}
          rows={1}
          className="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 resize-none disabled:opacity-50 min-h-[36px]"
        />

        {/* Send button */}
        <button
          onClick={() => {
            if (!text.trim() || disabled) return;
            onSend(text.trim(), selectedAgent);
            setText("");
          }}
          disabled={disabled || !text.trim()}
          className="shrink-0 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors h-9"
        >
          {disabled ? <Spinner size="sm" /> : "Send"}
        </button>
      </div>
      <p className="text-[10px] text-zinc-600 mt-1.5 pl-1">
        Shift+Enter for newline · /agent name task · /meeting start topic @agents
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageThread
// ---------------------------------------------------------------------------

function MessageThread({
  messages,
  isStreaming,
  meeting,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
  meeting: ActiveMeeting | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-center py-16">
          <div className="w-12 h-12 bg-teal-500/10 rounded-full flex items-center justify-center mb-4">
            <span className="text-teal-400 text-xl font-bold">C</span>
          </div>
          <h3 className="text-zinc-300 font-semibold mb-1">Start a conversation</h3>
          <p className="text-zinc-500 text-sm max-w-xs">
            Ask anything, pick an agent from the dropdown, or type /agent to route to a specific specialist.
          </p>
        </div>
      ) : (
        messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
      )}
      {isStreaming && (
        <div className="flex justify-start">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl rounded-tl-sm px-4 py-2">
            <TypingIndicator />
          </div>
        </div>
      )}
      {meeting && <MeetingPanel meeting={meeting} />}
      <div ref={bottomRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatPage inner component
// ---------------------------------------------------------------------------

function ChatPage({ baseUrl, secret }: { baseUrl: string; secret: string }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convsLoading, setConvsLoading] = useState(true);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [activeMeeting, setActiveMeeting] = useState<ActiveMeeting | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);

  // Load conversations on mount
  useEffect(() => {
    const api = getAPI();
    if (!api) return;
    api
      .listConversations()
      .then(setConversations)
      .catch(() => {})
      .finally(() => setConvsLoading(false));
  }, []);

  // Load a conversation by id
  const loadConversation = useCallback(
    async (convId: string) => {
      const api = getAPI();
      if (!api) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await api.getConversation(convId) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawMessages: any[] = res?.messages || [];
        const mapped: ChatMessage[] = rawMessages.map((m, i) => ({
          id: `hist-${convId}-${i}`,
          role: m.role === "user" ? "user" : "agent",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          agent: m.agent,
          model: m.model,
          timestamp: m.timestamp || new Date().toISOString(),
        }));
        setMessages(mapped);
      } catch {
        setMessages([]);
      }
    },
    []
  );

  const handleSelectConv = useCallback(
    (convId: string) => {
      setActiveChannelId(convId);
      setMessages([]);
      loadConversation(convId);
    },
    [loadConversation]
  );

  const handleNewConv = useCallback(() => {
    const newId = `chat-${Date.now()}`;
    setActiveChannelId(newId);
    setMessages([]);
    setActiveMeeting(null);
  }, []);

  // Stream SSE log events for a job
  const streamJobLogs = useCallback(
    async (jobId: string, agentMsgId: string) => {
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;

      const url = `${baseUrl}/jobs/${jobId}/log/stream?secret=${encodeURIComponent(secret)}`;

      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let accumulated = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw);
              // Collect text from assistant stream events
              if (evt.type === "assistant" && evt.text) {
                accumulated += evt.text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === agentMsgId
                      ? { ...m, content: accumulated, isStreaming: true }
                      : m
                  )
                );
              }
              // Handle meeting turn events
              if (evt.type === "meeting_turn" && evt.agent && evt.text) {
                setActiveMeeting((prev) => {
                  if (!prev) return prev;
                  return {
                    ...prev,
                    turns: [
                      ...prev.turns,
                      {
                        agent: evt.agent,
                        content: evt.text,
                        timestamp: new Date().toISOString(),
                      },
                    ],
                  };
                });
              }
              if (evt.type === "meeting_ended") {
                setActiveMeeting((prev) => prev ? { ...prev, status: "ended" } : null);
              }
            } catch {
              // Ignore parse errors on individual SSE lines
            }
          }
        }

        // Mark streaming done
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMsgId ? { ...m, isStreaming: false } : m
          )
        );
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === agentMsgId
                ? { ...m, content: m.content || "(No response received)", isStreaming: false }
                : m
            )
          );
        }
      } finally {
        setIsStreaming(false);
      }
    },
    [baseUrl, secret]
  );

  const handleSend = useCallback(
    async (text: string, agent: string) => {
      if (!text.trim()) return;

      // Abort any in-progress stream
      streamAbortRef.current?.abort();

      const channelId = activeChannelId || `chat-${Date.now()}`;
      if (!activeChannelId) setActiveChannelId(channelId);

      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };

      const agentMsgId = `agent-${Date.now()}`;
      const agentMsg: ChatMessage = {
        id: agentMsgId,
        role: "agent",
        content: "",
        agent: agent || "auto",
        timestamp: new Date().toISOString(),
        isStreaming: true,
      };

      setMessages((prev) => [...prev, userMsg, agentMsg]);
      setIsStreaming(true);

      // Detect /meeting command
      const meetingMatch = text.match(/^\/meeting\s+start\s+(.+?)(\s+@\S+)*/i);
      if (meetingMatch) {
        const topic = meetingMatch[1];
        const agentMatches = [...text.matchAll(/@(\S+)/g)].map((m) => m[1]);
        setActiveMeeting({
          id: `meeting-${Date.now()}`,
          topic,
          agents: agentMatches,
          status: "active",
          turns: [],
        });
      }

      try {
        const res = await fetch(`${baseUrl}/api/chat/send`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-runner-secret": secret,
          },
          body: JSON.stringify({
            message: text,
            agent: agent || undefined,
            channelId,
          }),
        });

        if (!res.ok) {
          throw new Error(`Send failed: ${res.status}`);
        }

        const data = await res.json();
        const jobId: string = data.jobId;

        if (!jobId) {
          throw new Error("No jobId in response");
        }

        // Tag the agent message with jobId
        setMessages((prev) =>
          prev.map((m) => (m.id === agentMsgId ? { ...m, jobId } : m))
        );

        // Refresh conversations list
        const api = getAPI();
        if (api) {
          api.listConversations().then(setConversations).catch(() => {});
        }

        // Start streaming logs
        await streamJobLogs(jobId, agentMsgId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMsgId
              ? { ...m, content: `Error: ${errMsg}`, isStreaming: false }
              : m
          )
        );
        setIsStreaming(false);
      }
    },
    [activeChannelId, baseUrl, secret, streamJobLogs]
  );

  // Layout: split panel
  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Left panel: conversation list */}
      <aside className="hidden md:flex flex-col w-64 bg-zinc-950 border-r border-zinc-800 shrink-0">
        <div className="px-3 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-300">Chat</h2>
        </div>
        <div className="flex-1 overflow-hidden">
          <ConversationList
            conversations={conversations}
            activeId={activeChannelId}
            onSelect={handleSelectConv}
            onNew={handleNewConv}
            loading={convsLoading}
          />
        </div>
      </aside>

      {/* Right panel: message thread + input */}
      <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
        {/* Thread header */}
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
          {/* Mobile: new conversation button */}
          <button
            onClick={handleNewConv}
            className="md:hidden text-xs text-teal-400 hover:text-teal-300 transition-colors"
          >
            + New
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-sm font-medium text-zinc-300 truncate">
              {activeChannelId || "Select or start a conversation"}
            </span>
            {isStreaming && (
              <span className="text-xs text-teal-400 animate-pulse shrink-0">
                Streaming...
              </span>
            )}
          </div>
          {activeMeeting && (
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
                activeMeeting.status === "active"
                  ? "bg-teal-500/20 text-teal-400"
                  : "bg-zinc-700 text-zinc-400"
              }`}
            >
              Meeting {activeMeeting.status}
            </span>
          )}
        </div>

        {/* Messages */}
        <MessageThread
          messages={messages}
          isStreaming={false}
          meeting={activeMeeting}
        />

        {/* Input */}
        <MessageInput
          onSend={handleSend}
          disabled={isStreaming}
          selectedAgent={selectedAgent}
          onAgentChange={setSelectedAgent}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page export (AuthGate wrapper)
// ---------------------------------------------------------------------------

export default function Page() {
  return (
    <AuthGate>
      {({ baseUrl, secret }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <ChatPage baseUrl={baseUrl} secret={secret} />
          </div>
        </div>
      )}
    </AuthGate>
  );
}
