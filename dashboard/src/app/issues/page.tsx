"use client";

import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { Issue, IssueComment, IssueLink, Product } from "@/lib/types";
import { useEffect, useState, useCallback } from "react";

// ---- Helpers ----

const TYPE_COLORS: Record<string, string> = {
  epic: "bg-purple-500/20 text-purple-400 border border-purple-500/30",
  story: "bg-green-500/20 text-green-400 border border-green-500/30",
  task: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  bug: "bg-red-500/20 text-red-400 border border-red-500/30",
  subtask: "bg-zinc-500/20 text-zinc-400 border border-zinc-500/30",
};

const PRIORITY_COLORS: Record<string, string> = {
  highest: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-blue-500",
  lowest: "bg-zinc-500",
};

const STATUS_COLUMNS = [
  { key: "todo", label: "To Do" },
  { key: "in_progress", label: "In Progress" },
  { key: "done", label: "Done" },
] as const;

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
  } catch {
    return iso;
  }
}

function fmtDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// ---- IssueCard ----

function IssueCard({ issue, onClick }: { issue: Issue; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-zinc-900 border border-zinc-800 rounded-lg p-3 hover:border-zinc-600 hover:bg-zinc-800/60 transition-colors group"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${TYPE_COLORS[issue.type] ?? TYPE_COLORS.task}`}>
          {issue.type}
        </span>
        <span className="text-[10px] text-zinc-500 font-mono">{issue.key}</span>
      </div>
      <p className="text-sm text-zinc-200 font-medium leading-snug mb-2 line-clamp-2 group-hover:text-white transition-colors">
        {issue.summary}
      </p>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_COLORS[issue.priority] ?? "bg-zinc-500"}`}
            title={issue.priority}
          />
          {issue.labels.slice(0, 2).map((l) => (
            <span key={l} className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
              {l}
            </span>
          ))}
          {issue.labels.length > 2 && (
            <span className="text-[10px] text-zinc-500">+{issue.labels.length - 2}</span>
          )}
        </div>
        {issue.assignee && (
          <span className="text-[10px] text-zinc-500 truncate max-w-[80px]">{issue.assignee}</span>
        )}
      </div>
      {issue.storyPoints != null && (
        <div className="mt-1.5 text-[10px] text-zinc-600">
          {issue.storyPoints} pt{issue.storyPoints !== 1 ? "s" : ""}
        </div>
      )}
    </button>
  );
}

// ---- KanbanBoard ----

function KanbanBoard({ issues, onSelect }: { issues: Issue[]; onSelect: (issue: Issue) => void }) {
  const grouped = STATUS_COLUMNS.reduce<Record<string, Issue[]>>((acc, col) => {
    acc[col.key] = issues.filter((i) => i.status === col.key);
    return acc;
  }, {});

  const colHeaderColors: Record<string, string> = {
    todo: "text-zinc-400",
    in_progress: "text-teal-400",
    done: "text-green-400",
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {STATUS_COLUMNS.map((col) => {
        const colIssues = grouped[col.key] ?? [];
        return (
          <div key={col.key} className="flex flex-col gap-2">
            <div className="flex items-center justify-between px-1 mb-1">
              <span className={`text-xs font-semibold uppercase tracking-widest ${colHeaderColors[col.key]}`}>
                {col.label}
              </span>
              <span className="text-xs text-zinc-600 bg-zinc-800 rounded-full px-2 py-0.5">
                {colIssues.length}
              </span>
            </div>
            <div className="flex flex-col gap-2 min-h-[120px]">
              {colIssues.length === 0 ? (
                <div className="border border-dashed border-zinc-800 rounded-lg p-4 text-center text-xs text-zinc-700">
                  No issues
                </div>
              ) : (
                colIssues.map((issue) => (
                  <IssueCard key={issue.key} issue={issue} onClick={() => onSelect(issue)} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- IssueListRow ----

function IssueListRow({ issue, onClick }: { issue: Issue; onClick: () => void }) {
  return (
    <tr
      onClick={onClick}
      className="border-b border-zinc-800 hover:bg-zinc-800/40 cursor-pointer transition-colors"
    >
      <td className="px-3 py-2 font-mono text-xs text-zinc-400 whitespace-nowrap">{issue.key}</td>
      <td className="px-3 py-2">
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${TYPE_COLORS[issue.type] ?? TYPE_COLORS.task}`}>
          {issue.type}
        </span>
      </td>
      <td className="px-3 py-2 text-sm text-zinc-200 max-w-xs truncate">{issue.summary}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${PRIORITY_COLORS[issue.priority] ?? "bg-zinc-500"}`} />
          <span className="text-xs text-zinc-400 capitalize">{issue.priority}</span>
        </div>
      </td>
      <td className="px-3 py-2">
        <span className="text-xs text-zinc-400 capitalize">{issue.status.replace("_", " ")}</span>
      </td>
      <td className="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">{issue.assignee ?? "—"}</td>
      <td className="px-3 py-2 text-xs text-zinc-600 whitespace-nowrap">{fmtDate(issue.updatedAt)}</td>
    </tr>
  );
}

// ---- CreateModal ----

interface CreateDefaults {
  parentKey?: string;
  project?: string;
  type?: string;
}

function CreateModal({
  onClose,
  onCreated,
  defaults,
}: {
  onClose: () => void;
  onCreated: () => void;
  defaults?: CreateDefaults;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [parentOptions, setParentOptions] = useState<Issue[]>([]);
  const [form, setForm] = useState({
    project: defaults?.project ?? "",
    type: defaults?.type ?? "task",
    summary: "",
    description: "",
    priority: "medium",
    labels: "",
    parentKey: defaults?.parentKey ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Load known products for the project dropdown
  useEffect(() => {
    getAPI()?.listProducts().then((ps) => {
      setProducts(ps);
      // Set default project from first product if not pre-filled
      if (!defaults?.project && ps.length > 0) {
        const firstKey = ps[0].projectKey || ps[0].id.toUpperCase();
        setForm((f) => f.project ? f : { ...f, project: firstKey });
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load parent options when type changes (epics are parents of stories/tasks/bugs; stories are parents of subtasks)
  useEffect(() => {
    if (form.type === "epic") { setParentOptions([]); return; }
    const parentType = form.type === "subtask" ? "story" : "epic";
    getAPI()?.listIssues({ type: parentType, limit: 100 })
      .then((r) => setParentOptions(r.issues ?? []))
      .catch(() => setParentOptions([]));
  }, [form.type]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.summary.trim()) { setError("Summary is required."); return; }
    setSaving(true);
    setError("");
    try {
      const api = getAPI();
      if (!api) throw new Error("API not initialised");
      await api.createIssue({
        project: form.project.trim() || "APP",
        type: form.type as Issue["type"],
        summary: form.summary.trim(),
        description: form.description.trim() || undefined,
        priority: form.priority,
        labels: form.labels ? form.labels.split(",").map((l) => l.trim()).filter(Boolean) : [],
        parentKey: form.parentKey.trim() || undefined,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue.");
    } finally {
      setSaving(false);
    }
  }

  const projectKey = form.project || (products[0]?.projectKey ?? "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 className="text-base font-semibold text-white">New Issue</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 transition-colors text-lg leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {/* Project — dropdown from known products */}
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Project</label>
              {products.length > 0 ? (
                <select
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500"
                  value={projectKey}
                  onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
                >
                  {products.map((p) => {
                    const key = p.projectKey || p.id.toUpperCase();
                    return (
                      <option key={p.id} value={key}>
                        {p.name} ({key})
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-teal-500 font-mono uppercase"
                  value={form.project}
                  onChange={(e) => setForm((f) => ({ ...f, project: e.target.value.toUpperCase() }))}
                  placeholder="APP"
                />
              )}
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Type</label>
              <select
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, parentKey: defaults?.parentKey ?? "" }))}
              >
                <option value="epic">Epic</option>
                <option value="story">Story</option>
                <option value="task">Task</option>
                <option value="bug">Bug</option>
                <option value="subtask">Subtask</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Summary *</label>
            <input
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-teal-500"
              value={form.summary}
              onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
              placeholder="Brief description of the issue"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Description</label>
            <textarea
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-teal-500 resize-none"
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Additional details..."
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Priority</label>
              <select
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500"
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              >
                <option value="highest">Highest</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
                <option value="lowest">Lowest</option>
              </select>
            </div>
            {/* Parent — dropdown from known issues, hidden for epics */}
            {form.type !== "epic" && (
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  {form.type === "subtask" ? "Parent story" : "Epic"}
                </label>
                <select
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-teal-500 font-mono"
                  value={form.parentKey}
                  onChange={(e) => setForm((f) => ({ ...f, parentKey: e.target.value }))}
                  disabled={!!defaults?.parentKey}
                >
                  <option value="">None</option>
                  {parentOptions.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key} — {p.summary.length > 35 ? p.summary.slice(0, 35) + "…" : p.summary}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Labels (comma-separated)</label>
            <input
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-teal-500"
              value={form.labels}
              onChange={(e) => setForm((f) => ({ ...f, labels: e.target.value }))}
              placeholder="needs-requirements, agent:implementer"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
              {saving && <Spinner size="sm" />}
              Create Issue
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- EpicPicker (inline) ----

function EpicPicker({
  currentKey,
  onSelect,
  onCancel,
}: {
  currentKey?: string;
  onSelect: (key: string | null) => void;
  onCancel: () => void;
}) {
  const [epics, setEpics] = useState<Issue[]>([]);
  const [selected, setSelected] = useState(currentKey ?? "");

  useEffect(() => {
    getAPI()?.listIssues({ type: "epic", limit: 100 })
      .then((r) => setEpics(r.issues ?? []))
      .catch(() => {});
  }, []);

  return (
    <div className="flex items-center gap-2 mt-1">
      <select
        className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-teal-500 font-mono"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        autoFocus
      >
        <option value="">— No epic —</option>
        {epics.map((e) => (
          <option key={e.key} value={e.key}>
            {e.key} — {e.summary.length > 40 ? e.summary.slice(0, 40) + "…" : e.summary}
          </option>
        ))}
      </select>
      <button
        onClick={() => onSelect(selected || null)}
        className="px-2 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors"
      >
        Save
      </button>
      <button
        onClick={onCancel}
        className="px-2 py-1.5 text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// ---- DetailPanel ----

function DetailPanel({
  issue,
  onClose,
  onRefresh,
  onAddChild,
}: {
  issue: Issue;
  onClose: () => void;
  onRefresh: () => void;
  onAddChild: (defaults: CreateDefaults) => void;
}) {
  const [detail, setDetail] = useState<{ comments: IssueComment[]; links: IssueLink[]; subtasks: Issue[]; children: Issue[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [epicPickerOpen, setEpicPickerOpen] = useState(false);
  const [savingEpic, setSavingEpic] = useState(false);
  const [localParentKey, setLocalParentKey] = useState(issue.parentKey);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const api = getAPI();
      if (!api) return;
      const [d, childrenRes] = await Promise.all([
        api.getIssue(issue.key),
        issue.type === "epic"
          ? api.listIssues({ parentKey: issue.key, limit: 50 })
          : Promise.resolve({ issues: [] as Issue[], total: 0, ok: true }),
      ]);
      setDetail({
        comments: d.comments,
        links: d.links,
        subtasks: d.subtasks,
        children: childrenRes.issues ?? [],
      });
    } catch {
      setDetail({ comments: [], links: [], subtasks: [], children: [] });
    } finally {
      setLoading(false);
    }
  }, [issue.key, issue.type]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  async function handleTransition(status: string) {
    setTransitioning(true);
    try {
      await getAPI()?.transitionIssue(issue.key, status);
      onRefresh();
      onClose();
    } catch {
      // silently ignore
    } finally {
      setTransitioning(false);
    }
  }

  async function handleComment() {
    if (!newComment.trim()) return;
    setCommenting(true);
    try {
      await getAPI()?.addIssueComment(issue.key, newComment.trim());
      setNewComment("");
      loadDetail();
    } catch {
      // silently ignore
    } finally {
      setCommenting(false);
    }
  }

  async function handleSetEpic(epicKey: string | null) {
    setSavingEpic(true);
    setEpicPickerOpen(false);
    try {
      await getAPI()?.updateIssue(issue.key, { parentKey: epicKey ?? undefined });
      setLocalParentKey(epicKey ?? undefined);
      onRefresh();
    } catch {
      // silently ignore
    } finally {
      setSavingEpic(false);
    }
  }

  const availableTransitions = (["todo", "in_progress", "done", "cancelled"] as const).filter(
    (s) => s !== issue.status,
  );

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div
        className="w-full max-w-xl h-full bg-zinc-950 border-l border-zinc-800 overflow-y-auto shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Panel header */}
        <div className="flex items-start justify-between p-4 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${TYPE_COLORS[issue.type] ?? TYPE_COLORS.task}`}>
                {issue.type}
              </span>
              <span className="text-xs font-mono text-zinc-400">{issue.key}</span>
              <span className="text-xs text-zinc-500 capitalize">{issue.status.replace("_", " ")}</span>
            </div>
            <h3 className="text-sm font-semibold text-white leading-snug">{issue.summary}</h3>
          </div>
          <button onClick={onClose} className="ml-3 text-zinc-500 hover:text-zinc-200 text-xl leading-none flex-shrink-0">×</button>
        </div>

        {/* Metadata */}
        <div className="p-4 border-b border-zinc-800 grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-zinc-500">Priority</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`w-2 h-2 rounded-full ${PRIORITY_COLORS[issue.priority] ?? "bg-zinc-500"}`} />
              <span className="text-zinc-300 capitalize">{issue.priority}</span>
            </div>
          </div>
          <div>
            <span className="text-zinc-500">Assignee</span>
            <p className="text-zinc-300 mt-0.5">{issue.assignee ?? "Unassigned"}</p>
          </div>
          <div>
            <span className="text-zinc-500">Project</span>
            <p className="text-zinc-300 mt-0.5 font-mono">{issue.project}</p>
          </div>
          {issue.storyPoints != null && (
            <div>
              <span className="text-zinc-500">Story Points</span>
              <p className="text-zinc-300 mt-0.5">{issue.storyPoints}</p>
            </div>
          )}
          <div>
            <span className="text-zinc-500">Updated</span>
            <p className="text-zinc-300 mt-0.5">{fmtDate(issue.updatedAt)}</p>
          </div>

          {/* Epic field — shown for non-epic issues */}
          {issue.type !== "epic" && (
            <div className="col-span-2">
              <span className="text-zinc-500">Epic</span>
              {epicPickerOpen ? (
                <EpicPicker
                  currentKey={localParentKey}
                  onSelect={handleSetEpic}
                  onCancel={() => setEpicPickerOpen(false)}
                />
              ) : (
                <div className="flex items-center gap-2 mt-0.5">
                  {localParentKey ? (
                    <span className="font-mono text-purple-400">{localParentKey}</span>
                  ) : (
                    <span className="text-zinc-600 italic">None</span>
                  )}
                  <button
                    onClick={() => setEpicPickerOpen(true)}
                    disabled={savingEpic}
                    className="text-[10px] text-zinc-500 hover:text-teal-400 underline underline-offset-2 transition-colors disabled:opacity-50"
                  >
                    {savingEpic ? "Saving…" : localParentKey ? "Change" : "Set epic"}
                  </button>
                  {localParentKey && !savingEpic && (
                    <button
                      onClick={() => handleSetEpic(null)}
                      className="text-[10px] text-zinc-600 hover:text-red-400 underline underline-offset-2 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Labels */}
        {issue.labels.length > 0 && (
          <div className="px-4 py-3 border-b border-zinc-800">
            <p className="text-xs text-zinc-500 mb-2">Labels</p>
            <div className="flex flex-wrap gap-1.5">
              {issue.labels.map((l) => (
                <span key={l} className="text-xs bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded-full border border-zinc-700">
                  {l}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        {issue.description && (
          <div className="px-4 py-3 border-b border-zinc-800">
            <p className="text-xs text-zinc-500 mb-2">Description</p>
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{issue.description}</p>
          </div>
        )}

        {/* Transitions */}
        <div className="px-4 py-3 border-b border-zinc-800">
          <p className="text-xs text-zinc-500 mb-2">Transition to</p>
          <div className="flex flex-wrap gap-2">
            {availableTransitions.map((status) => (
              <button
                key={status}
                onClick={() => handleTransition(status)}
                disabled={transitioning}
                className="px-3 py-1.5 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 rounded-lg transition-colors capitalize disabled:opacity-50"
              >
                {status.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>

        {/* Loading or detail content */}
        {loading ? (
          <div className="flex justify-center py-10"><Spinner size="sm" /></div>
        ) : (
          <>
            {/* Epic children — only shown for epics */}
            {issue.type === "epic" && (
              <div className="px-4 py-3 border-b border-zinc-800">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-zinc-500">
                    Children ({detail?.children.length ?? 0})
                  </p>
                  <button
                    onClick={() => onAddChild({ parentKey: issue.key, project: issue.project })}
                    className="text-[10px] text-teal-400 hover:text-teal-300 border border-teal-600/40 hover:border-teal-500/60 rounded px-2 py-0.5 transition-colors"
                  >
                    + Add child
                  </button>
                </div>
                {detail && detail.children.length === 0 ? (
                  <p className="text-xs text-zinc-700 italic">No child issues yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {detail?.children.map((child) => (
                      <div key={child.key} className="flex items-center gap-2 text-xs bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">
                        <span className={`inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold uppercase ${TYPE_COLORS[child.type] ?? TYPE_COLORS.task}`}>
                          {child.type}
                        </span>
                        <span className="font-mono text-zinc-500 flex-shrink-0">{child.key}</span>
                        <span className="text-zinc-300 truncate flex-1">{child.summary}</span>
                        <span className="text-zinc-600 capitalize flex-shrink-0">{child.status.replace("_", " ")}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Subtasks */}
            {detail && detail.subtasks.length > 0 && (
              <div className="px-4 py-3 border-b border-zinc-800">
                <p className="text-xs text-zinc-500 mb-2">Subtasks ({detail.subtasks.length})</p>
                <div className="space-y-1.5">
                  {detail.subtasks.map((sub) => (
                    <div key={sub.key} className="flex items-center gap-2 text-xs">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_COLORS[sub.priority] ?? "bg-zinc-500"}`} />
                      <span className="font-mono text-zinc-500">{sub.key}</span>
                      <span className="text-zinc-300 truncate">{sub.summary}</span>
                      <span className="ml-auto text-zinc-600 capitalize flex-shrink-0">{sub.status.replace("_", " ")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Links */}
            {detail && detail.links.length > 0 && (
              <div className="px-4 py-3 border-b border-zinc-800">
                <p className="text-xs text-zinc-500 mb-2">Links ({detail.links.length})</p>
                <div className="space-y-1.5">
                  {detail.links.map((link) => (
                    <div key={link.id} className="flex items-center gap-2 text-xs">
                      <span className="text-zinc-600 capitalize">{link.linkType}</span>
                      <span className="font-mono text-teal-400">
                        {link.sourceKey === issue.key ? link.targetKey : link.sourceKey}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comments */}
            <div className="px-4 py-3 flex-1">
              <p className="text-xs text-zinc-500 mb-3">Comments ({detail?.comments.length ?? 0})</p>
              <div className="space-y-3 mb-4">
                {detail?.comments.map((c) => (
                  <div key={c.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-zinc-300">{c.author}</span>
                      <span className="text-[10px] text-zinc-600">{fmtDateTime(c.createdAt)}</span>
                    </div>
                    <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">{c.body}</p>
                  </div>
                ))}
                {detail?.comments.length === 0 && (
                  <p className="text-xs text-zinc-700 italic">No comments yet.</p>
                )}
              </div>
              <div className="space-y-2">
                <textarea
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-teal-500 resize-none"
                  rows={3}
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Add a comment..."
                />
                <div className="flex justify-end">
                  <button
                    onClick={handleComment}
                    disabled={commenting || !newComment.trim()}
                    className="px-3 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    {commenting && <Spinner size="sm" />}
                    Comment
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---- FilterBar ----

interface Filters {
  search: string;
  type: string;
  priority: string;
  status: string;
}

function FilterBar({
  filters,
  onChange,
  view,
  onViewChange,
  onNew,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  view: "board" | "list";
  onViewChange: (v: "board" | "list") => void;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-teal-500 w-48"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
        placeholder="Search issues..."
      />
      <select
        className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-teal-500"
        value={filters.type}
        onChange={(e) => onChange({ ...filters, type: e.target.value })}
      >
        <option value="">All types</option>
        <option value="epic">Epic</option>
        <option value="story">Story</option>
        <option value="task">Task</option>
        <option value="bug">Bug</option>
        <option value="subtask">Subtask</option>
      </select>
      <select
        className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-teal-500"
        value={filters.priority}
        onChange={(e) => onChange({ ...filters, priority: e.target.value })}
      >
        <option value="">All priorities</option>
        <option value="highest">Highest</option>
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
        <option value="lowest">Lowest</option>
      </select>
      {view === "list" && (
        <select
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-teal-500"
          value={filters.status}
          onChange={(e) => onChange({ ...filters, status: e.target.value })}
        >
          <option value="">All statuses</option>
          <option value="todo">To Do</option>
          <option value="in_progress">In Progress</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
        </select>
      )}

      <div className="ml-auto flex items-center gap-2">
        <div className="flex bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden">
          <button
            onClick={() => onViewChange("board")}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === "board" ? "bg-teal-600 text-white" : "text-zinc-400 hover:text-white"}`}
            title="Board view"
          >
            Board
          </button>
          <button
            onClick={() => onViewChange("list")}
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${view === "list" ? "bg-teal-600 text-white" : "text-zinc-400 hover:text-white"}`}
            title="List view"
          >
            List
          </button>
        </div>
        <button
          onClick={onNew}
          className="px-3 py-1.5 text-xs font-semibold bg-teal-600 hover:bg-teal-500 text-white rounded-lg transition-colors"
        >
          + New Issue
        </button>
      </div>
    </div>
  );
}

// ---- Main IssuesPage ----

function IssuesPage() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filters, setFilters] = useState<Filters>({ search: "", type: "", priority: "", status: "" });
  const [view, setView] = useState<"board" | "list">("board");
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null);
  const [createDefaults, setCreateDefaults] = useState<CreateDefaults | null>(null);

  const fetchIssues = useCallback(async () => {
    setLoading(true);
    try {
      const api = getAPI();
      if (!api) return;
      const params: Record<string, string> = {};
      if (filters.status) params.status = filters.status;
      if (filters.type) params.type = filters.type;
      if (filters.search) params.search = filters.search;
      const res = await api.listIssues(params);
      setIssues(res.issues ?? []);
      setLoadError("");
    } catch (err) {
      setIssues([]);
      setLoadError(err instanceof Error ? err.message : "Failed to load issues.");
    } finally {
      setLoading(false);
    }
  }, [filters.status, filters.type, filters.search]);

  useEffect(() => { fetchIssues(); }, [fetchIssues]);

  const filteredIssues = filters.priority
    ? issues.filter((i) => i.priority === filters.priority)
    : issues;

  function handleAddChild(defaults: CreateDefaults) {
    setSelectedIssue(null);
    setCreateDefaults(defaults);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Issues</h2>
        <span className="text-xs text-zinc-500">{filteredIssues.length} issue{filteredIssues.length !== 1 ? "s" : ""}</span>
      </div>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        view={view}
        onViewChange={setView}
        onNew={() => setCreateDefaults({})}
      />

      {loadError && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg px-4 py-3">
          Failed to load issues: {loadError}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : view === "board" ? (
        <KanbanBoard issues={filteredIssues} onSelect={setSelectedIssue} />
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">Key</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">Type</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">Summary</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">Priority</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">Status</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">Assignee</th>
                <th className="px-3 py-2 text-xs text-zinc-500 font-medium uppercase tracking-wider">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filteredIssues.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center text-sm text-zinc-600">No issues found.</td>
                </tr>
              ) : (
                filteredIssues.map((issue) => (
                  <IssueListRow key={issue.key} issue={issue} onClick={() => setSelectedIssue(issue)} />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {selectedIssue && (
        <DetailPanel
          issue={selectedIssue}
          onClose={() => setSelectedIssue(null)}
          onRefresh={fetchIssues}
          onAddChild={handleAddChild}
        />
      )}

      {createDefaults !== null && (
        <CreateModal
          defaults={createDefaults}
          onClose={() => setCreateDefaults(null)}
          onCreated={fetchIssues}
        />
      )}
    </div>
  );
}

// ---- Page export ----

export default function Page() {
  return (
    <AuthGate>
      {({ baseUrl }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-2 sm:p-4 md:p-6">
              <IssuesPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
