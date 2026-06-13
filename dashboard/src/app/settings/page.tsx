"use client";

import { useEffect, useState, useCallback } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { IntegrationStatus } from "@/lib/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Badge({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400">
      Connected
    </span>
  ) : (
    <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-zinc-800 text-zinc-500">
      Not connected
    </span>
  );
}

function TestResult({ result }: { result: { ok: boolean; error?: string; [key: string]: unknown } | null }) {
  if (!result) return null;
  if (result.ok) {
    const detail =
      (result.user as { displayName?: string } | undefined)?.displayName
        ? `Authenticated as ${(result.user as { displayName: string }).displayName}`
        : (result.bot as { username?: string } | undefined)?.username
        ? `Bot: @${(result.bot as { username: string }).username}`
        : result.reachable
        ? `Reachable (HTTP ${result.status ?? ""})`
        : "Connection successful";
    return <p className="mt-2 text-xs text-emerald-400">{detail}</p>;
  }
  return <p className="mt-2 text-xs text-red-400">{result.error ?? "Connection failed"}</p>;
}

// ─── Integration Cards ───────────────────────────────────────────────────────

interface JiraCardProps {
  status: IntegrationStatus["jira"] | null;
  onSaved: () => void;
}

function JiraCard({ status, onSaved }: JiraCardProps) {
  const [domain, setDomain] = useState(status?.domain ?? "");
  const [email, setEmail] = useState(status?.email ?? "");
  const [apiToken, setApiToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; [key: string]: unknown } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    setDomain(status?.domain ?? "");
    setEmail(status?.email ?? "");
  }, [status]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await getAPI().testIntegration("jira", { domain, email, apiToken });
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await getAPI().saveIntegration("jira", { domain, email, apiToken });
      setSaveMsg("Saved successfully");
      onSaved();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🔗</span>
          <span className="font-semibold text-white text-sm">Jira</span>
        </div>
        <Badge enabled={status?.enabled ?? false} />
      </div>
      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Domain</label>
          <input
            type="text"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-teal-500"
            placeholder="mycompany.atlassian.net"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Email</label>
          <input
            type="email"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-teal-500"
            placeholder="user@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            API Token {status?.hasToken && <span className="text-emerald-400">(saved)</span>}
          </label>
          <input
            type="password"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-teal-500"
            placeholder={status?.hasToken ? "Leave blank to keep current token" : "Enter API token"}
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
          />
        </div>
      </div>
      <TestResult result={testResult} />
      {saveMsg && (
        <p className={`text-xs ${saveMsg.includes("success") ? "text-emerald-400" : "text-red-400"}`}>
          {saveMsg}
        </p>
      )}
      <div className="flex gap-2 mt-auto">
        <button
          onClick={handleTest}
          disabled={testing || !domain || !email || !apiToken}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {testing ? <Spinner size="sm" /> : "Test connection"}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !domain || !email}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Spinner size="sm" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

interface TelegramCardProps {
  status: IntegrationStatus["telegram"] | null;
  onSaved: () => void;
}

function TelegramCard({ status, onSaved }: TelegramCardProps) {
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState(status?.chatId ?? "");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; [key: string]: unknown } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    setChatId(status?.chatId ?? "");
  }, [status]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await getAPI().testIntegration("telegram", { botToken });
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const payload: Record<string, string> = { botToken };
      if (chatId) payload.chatId = chatId;
      await getAPI().saveIntegration("telegram", payload);
      setSaveMsg("Saved successfully");
      onSaved();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">✈️</span>
          <span className="font-semibold text-white text-sm">Telegram</span>
        </div>
        <Badge enabled={status?.enabled ?? false} />
      </div>
      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">
            Bot Token {status?.hasToken && <span className="text-emerald-400">(saved)</span>}
          </label>
          <input
            type="password"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-teal-500"
            placeholder={status?.hasToken ? "Leave blank to keep current token" : "Enter bot token"}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Chat ID (optional)</label>
          <input
            type="text"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-teal-500"
            placeholder="-100123456789"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
          />
        </div>
      </div>
      <TestResult result={testResult} />
      {saveMsg && (
        <p className={`text-xs ${saveMsg.includes("success") ? "text-emerald-400" : "text-red-400"}`}>
          {saveMsg}
        </p>
      )}
      <div className="flex gap-2 mt-auto">
        <button
          onClick={handleTest}
          disabled={testing || !botToken}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {testing ? <Spinner size="sm" /> : "Test connection"}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !botToken}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Spinner size="sm" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

interface N8NCardProps {
  status: IntegrationStatus["n8n"] | null;
  onSaved: () => void;
}

function N8NCard({ status, onSaved }: N8NCardProps) {
  const [callbackUrl, setCallbackUrl] = useState(status?.callbackUrl ?? "");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; [key: string]: unknown } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    setCallbackUrl(status?.callbackUrl ?? "");
  }, [status]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await getAPI().testIntegration("n8n", { callbackUrl });
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await getAPI().saveIntegration("n8n", { callbackUrl });
      setSaveMsg("Saved successfully");
      onSaved();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">⚡</span>
          <span className="font-semibold text-white text-sm">N8N</span>
        </div>
        <Badge enabled={status?.enabled ?? false} />
      </div>
      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Callback URL</label>
          <input
            type="url"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-teal-500"
            placeholder="https://n8n.example.com/webhook/..."
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
          />
        </div>
      </div>
      <TestResult result={testResult} />
      {saveMsg && (
        <p className={`text-xs ${saveMsg.includes("success") ? "text-emerald-400" : "text-red-400"}`}>
          {saveMsg}
        </p>
      )}
      <div className="flex gap-2 mt-auto">
        <button
          onClick={handleTest}
          disabled={testing || !callbackUrl}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {testing ? <Spinner size="sm" /> : "Test connection"}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !callbackUrl}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Spinner size="sm" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

interface SlackCardProps {
  status: IntegrationStatus["slack"] | null;
  onSaved: () => void;
}

function SlackCard({ status, onSaved }: SlackCardProps) {
  const [webhookUrl, setWebhookUrl] = useState(status?.webhookUrl ?? "");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string; [key: string]: unknown } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    setWebhookUrl(status?.webhookUrl ?? "");
  }, [status]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await getAPI().testIntegration("slack", { webhookUrl });
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await getAPI().saveIntegration("slack", { webhookUrl });
      setSaveMsg("Saved successfully");
      onSaved();
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">💬</span>
          <span className="font-semibold text-white text-sm">Slack</span>
        </div>
        <Badge enabled={status?.enabled ?? false} />
      </div>
      <div className="flex flex-col gap-3">
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Incoming Webhook URL</label>
          <input
            type="url"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-teal-500"
            placeholder="https://hooks.slack.com/services/..."
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </div>
      </div>
      <TestResult result={testResult} />
      {saveMsg && (
        <p className={`text-xs ${saveMsg.includes("success") ? "text-emerald-400" : "text-red-400"}`}>
          {saveMsg}
        </p>
      )}
      <div className="flex gap-2 mt-auto">
        <button
          onClick={handleTest}
          disabled={testing || !webhookUrl}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {testing ? <Spinner size="sm" /> : "Test connection"}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !webhookUrl}
          className="flex-1 px-3 py-2 rounded-lg text-xs font-medium bg-teal-600 text-white hover:bg-teal-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? <Spinner size="sm" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function SettingsPage() {
  const [integrations, setIntegrations] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getAPI()
      .getIntegrations()
      .then(setIntegrations)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load integrations"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return <div className="flex justify-center py-20"><Spinner size="lg" /></div>;
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-sm">Failed to load settings: {error}</p>
        <p className="text-zinc-500 text-xs mt-2">Is the runner reachable?</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white">Settings</h2>
        <p className="text-sm text-zinc-500 mt-1">Configure integrations and connections for this Meshwork deployment.</p>
      </div>

      <section>
        <h3 className="text-base font-semibold text-zinc-200 mb-4">Integrations</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <JiraCard status={integrations?.jira ?? null} onSaved={load} />
          <TelegramCard status={integrations?.telegram ?? null} onSaved={load} />
          <N8NCard status={integrations?.n8n ?? null} onSaved={load} />
          <SlackCard status={integrations?.slack ?? null} onSaved={load} />
        </div>
      </section>
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
            <main className="flex-1 p-2 sm:p-4 md:p-6 pb-20 md:pb-6">
              <SettingsPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
