"use client";

import { useEffect, useState, useCallback } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { IntegrationStatus, LLMProvider } from "@/lib/types";

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

// ─── LLM Providers Section ────────────────────────────────────────────────────

const PROVIDER_TYPE_LABELS: Record<string, string> = {
  "claude-cli": "Claude CLI",
  "openai": "OpenAI",
  "gemini": "Gemini",
  "anthropic-direct": "Anthropic API",
  "github": "GitHub",
};

const PROVIDER_TYPE_COLORS: Record<string, string> = {
  "claude-cli": "text-orange-400 bg-orange-500/10",
  "openai": "text-green-400 bg-green-500/10",
  "gemini": "text-blue-400 bg-blue-500/10",
  "anthropic-direct": "text-purple-400 bg-purple-500/10",
  "github": "text-zinc-300 bg-zinc-700/50",
};

function ProviderTypeBadge({ type }: { type: string }) {
  const label = PROVIDER_TYPE_LABELS[type] || type;
  const color = PROVIDER_TYPE_COLORS[type] || "text-zinc-400 bg-zinc-700/30";
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>{label}</span>;
}

interface ProviderCardProps {
  provider: LLMProvider;
  onRefresh: () => void;
}

function ProviderCard({ provider, onRefresh }: ProviderCardProps) {
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; response?: string; error?: string } | null>(null);
  const [keyMsg, setKeyMsg] = useState<string | null>(null);

  // Edit state
  const [editing, setEditing] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState(provider.displayName ?? "");
  const [editType, setEditType] = useState(provider.type);
  const [editBaseUrl, setEditBaseUrl] = useState(provider.baseUrl ?? "");
  const [editDefaultModel, setEditDefaultModel] = useState(
    provider.modelMapping?.default ?? Object.values(provider.modelMapping ?? {}).find(Boolean) ?? ""
  );
  const [savingEdit, setSavingEdit] = useState(false);
  const [editMsg, setEditMsg] = useState<string | null>(null);

  // Delete state
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);

  async function handleSaveKey() {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    setKeyMsg(null);
    try {
      await getAPI().setProviderKey(provider.id, keyInput.trim());
      setKeyInput("");
      setKeyMsg("API key saved");
      onRefresh();
    } catch (e) {
      setKeyMsg(e instanceof Error ? e.message : "Failed to save key");
    } finally {
      setSavingKey(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await getAPI().testProvider(provider.id);
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveEdit() {
    setSavingEdit(true);
    setEditMsg(null);
    try {
      const modelMapping = editDefaultModel.trim() ? { default: editDefaultModel.trim() } : undefined;
      await getAPI().upsertProvider({
        id: provider.id,
        type: editType,
        displayName: editDisplayName || undefined,
        baseUrl: editBaseUrl || undefined,
        modelMapping,
      });
      setEditing(false);
      setEditMsg(null);
      onRefresh();
    } catch (e) {
      setEditMsg(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setDeleteMsg(null);
    try {
      await getAPI().deleteProvider(provider.id);
      onRefresh();
    } catch (e) {
      setDeleteMsg(e instanceof Error ? e.message : "Failed to delete");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const modelMapping = provider.modelMapping;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-white">{provider.displayName || provider.id}</h4>
            <ProviderTypeBadge type={provider.type} />
            {provider.source === "config" && (
              <span className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 bg-zinc-800">config.json</span>
            )}
          </div>
          {provider.baseUrl && !editing && (
            <p className="text-xs text-zinc-500 mt-0.5 truncate max-w-xs">{provider.baseUrl}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
            provider.apiKeySet
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-zinc-800 text-zinc-500"
          }`}>
            {provider.apiKeySet ? "Key set" : "No key"}
          </span>
          <button
            onClick={() => { setEditing((e) => !e); setEditMsg(null); setConfirmDelete(false); }}
            className="px-2 py-1 text-[11px] text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 rounded-md transition-colors"
          >
            {editing ? "Cancel" : "Edit"}
          </button>
          {!confirmDelete ? (
            <button
              onClick={() => { setConfirmDelete(true); setEditing(false); }}
              className="px-2 py-1 text-[11px] text-zinc-400 hover:text-red-400 border border-zinc-700 hover:border-red-800 rounded-md transition-colors"
            >
              Delete
            </button>
          ) : (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-2 py-1 text-[11px] text-red-400 border border-red-800 rounded-md hover:bg-red-900/30 transition-colors disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Confirm"}
            </button>
          )}
        </div>
      </div>

      {confirmDelete && (
        <div className="flex items-center justify-between bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">
          <p className="text-xs text-red-300">
            {provider.source === "config"
              ? "This removes the DB override — the provider will still appear from config.json."
              : "This will permanently delete the provider and its stored API key."}
          </p>
          <button
            onClick={() => setConfirmDelete(false)}
            className="text-xs text-zinc-500 hover:text-white ml-3 flex-shrink-0"
          >
            Cancel
          </button>
        </div>
      )}
      {deleteMsg && <p className="text-xs text-red-400">{deleteMsg}</p>}

      {editing && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Display name</label>
              <input
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                placeholder={provider.id}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-zinc-500"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Type</label>
              <select
                value={editType}
                onChange={(e) => setEditType(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-zinc-500"
              >
                <option value="claude-cli">Claude CLI</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Gemini</option>
                <option value="anthropic-direct">Anthropic API (direct)</option>
                <option value="github">GitHub</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-zinc-400 mb-1 block">Base URL (optional)</label>
              <input
                value={editBaseUrl}
                onChange={(e) => setEditBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1 or full endpoint URL"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-zinc-500"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Default model ID</label>
            <input
              value={editDefaultModel}
              onChange={(e) => setEditDefaultModel(e.target.value)}
              placeholder="e.g. gpt-4o, claude-3-7-sonnet-20250219, llama3.3:70b"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-zinc-500"
            />
          </div>
          {editMsg && <p className="text-xs text-red-400">{editMsg}</p>}
          <div className="flex justify-end">
            <button
              onClick={handleSaveEdit}
              disabled={savingEdit}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs rounded-lg font-medium transition-colors"
            >
              {savingEdit ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {modelMapping && !editing && (() => {
        const defaultModel = modelMapping.default || Object.values(modelMapping).find(Boolean);
        return defaultModel ? (
          <div className="text-xs bg-zinc-800 rounded px-2 py-1 flex gap-1">
            <span className="text-zinc-500">Model:</span>
            <span className="text-zinc-300 font-mono truncate">{defaultModel}</span>
          </div>
        ) : null;
      })()}

      {provider.type !== "claude-cli" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="password"
              placeholder={provider.apiKeySet ? "Replace API key…" : "Enter API key…"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
            />
            <button
              onClick={handleSaveKey}
              disabled={savingKey || !keyInput.trim()}
              className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 text-white text-xs rounded-lg font-medium transition-colors"
            >
              {savingKey ? "Saving…" : "Save"}
            </button>
          </div>
          {keyMsg && (
            <p className={`text-xs ${keyMsg.startsWith("API key") ? "text-emerald-400" : "text-red-400"}`}>{keyMsg}</p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={handleTest}
          disabled={testing}
          className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white text-xs rounded-lg font-medium transition-colors disabled:opacity-40"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        {testResult && (
          <span className={`text-xs ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}>
            {testResult.ok
              ? `OK${testResult.latencyMs ? ` (${testResult.latencyMs}ms)` : ""}`
              : testResult.error || "Failed"}
          </span>
        )}
      </div>
    </div>
  );
}

function AddProviderForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [type, setType] = useState("openai");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    if (!id.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await getAPI().upsertProvider({
        id: id.trim(),
        type,
        displayName: displayName || undefined,
        baseUrl: baseUrl || undefined,
        modelMapping: defaultModel.trim() ? { default: defaultModel.trim() } : undefined,
      });
      setOpen(false);
      setId(""); setType("openai"); setDisplayName(""); setBaseUrl(""); setDefaultModel("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add provider");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full border-2 border-dashed border-zinc-700 hover:border-zinc-500 rounded-xl py-6 text-zinc-500 hover:text-zinc-300 text-sm transition-colors"
      >
        + Add provider
      </button>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
      <h4 className="text-sm font-semibold text-white">Add LLM Provider</h4>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Provider ID</label>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. zai"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-zinc-500" />
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-zinc-500">
            <option value="claude-cli">Claude CLI</option>
            <option value="openai">OpenAI / Compatible</option>
            <option value="gemini">Gemini</option>
            <option value="anthropic-direct">Anthropic API (direct)</option>
            <option value="github">GitHub</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Display name (optional)</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Z.AI"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-zinc-500" />
        </div>
        <div>
          <label className="text-xs text-zinc-400 mb-1 block">Base URL (optional)</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.z.ai/api/coding/paas/v4"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-zinc-500" />
        </div>
      </div>
      <div>
        <label className="text-xs text-zinc-400 mb-1 block">Default model ID (optional)</label>
        <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="e.g. gpt-4o, claude-3-7-sonnet-20250219, llama3.3:70b"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:ring-1 focus:ring-zinc-500" />
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white transition-colors">Cancel</button>
        <button onClick={handleAdd} disabled={saving || !id.trim()}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs rounded-lg font-medium transition-colors">
          {saving ? "Adding…" : "Add provider"}
        </button>
      </div>
    </div>
  );
}

function ProvidersSection() {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getAPI().getProviders()
      .then(setProviders)
      .catch(() => setProviders([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <section>
      <h3 className="text-base font-semibold text-zinc-200 mb-1">LLM Providers</h3>
      <p className="text-xs text-zinc-500 mb-4">Configure API keys and model mappings for each provider. Keys are stored encrypted.</p>
      {loading ? (
        <div className="flex justify-center py-6"><Spinner size="sm" /></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} onRefresh={load} />
          ))}
          <AddProviderForm onAdded={load} />
        </div>
      )}
    </section>
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

      <ProvidersSection />
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
