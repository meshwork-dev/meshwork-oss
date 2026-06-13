"use client";

import { useEffect, useState } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { Card, CardTitle } from "@/components/ui/Card";
import { getAPI } from "@/lib/api";
import type { Conversation } from "@/lib/types";

function ConversationsPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAPI()?.listConversations()
      .then(setConversations)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load conversations"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    getAPI()?.getConversation(selected)
      .then((data) => setMessages(data.messages || []))
      .catch(() => setMessages([]));
  }, [selected]);

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-sm">Failed to load conversations: {error}</p>
        <p className="text-zinc-500 text-xs mt-2">Is the runner reachable?</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Conversations</h2>
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-1 space-y-2">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              className={`w-full text-left p-3 rounded-lg text-sm transition-colors ${
                selected === c.id ? "bg-teal-500/10 border border-teal-500/30" : "bg-zinc-900 border border-zinc-800 hover:border-zinc-700"
              }`}
            >
              <p className="text-zinc-300 font-mono text-xs truncate">{c.channelId || c.id}</p>
              <p className="text-zinc-500 text-xs mt-1">{c.messageCount} messages</p>
            </button>
          ))}
          {conversations.length === 0 && (
            <p className="text-sm text-zinc-600 text-center py-4">No conversations</p>
          )}
        </div>
        <div className="col-span-2">
          {selected ? (
            <Card>
              <CardTitle>Messages</CardTitle>
              <div className="mt-3 space-y-2 max-h-[600px] overflow-y-auto">
                {messages.map((msg, i) => (
                  <pre key={i} className="text-xs text-zinc-400 bg-zinc-800 rounded p-2 whitespace-pre-wrap">
                    {JSON.stringify(msg, null, 2)}
                  </pre>
                ))}
              </div>
            </Card>
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-600 text-sm">
              Select a conversation
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      {({ baseUrl }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-6">
              <ConversationsPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
