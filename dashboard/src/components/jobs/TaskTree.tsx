"use client";

import { useEffect, useState } from "react";
import { getAPI } from "@/lib/api";
import type { TaskProgress, TaskItem } from "@/lib/types";
import { Spinner } from "@/components/ui/Spinner";

const statusIcon: Record<string, { icon: string; color: string }> = {
  completed: { icon: "\u2713", color: "text-green-400" },
  in_progress: { icon: "\u25B6", color: "text-yellow-400" },
  pending: { icon: "\u25CB", color: "text-zinc-500" },
};

function TaskNode({ task, allTasks }: { task: TaskItem; allTasks: TaskItem[] }) {
  const { icon, color } = statusIcon[task.status] || statusIcon.pending;
  const blockers = (task.blockedBy || [])
    .map((id) => allTasks.find((t) => t.id === id))
    .filter(Boolean);

  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className={`${color} font-mono text-sm w-4 flex-shrink-0 mt-0.5`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-zinc-300 truncate">{task.subject}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
            task.status === "completed" ? "bg-green-900/30 text-green-400" :
            task.status === "in_progress" ? "bg-yellow-900/30 text-yellow-400" :
            "bg-zinc-800 text-zinc-500"
          }`}>
            {task.status.replace("_", " ")}
          </span>
        </div>
        {blockers.length > 0 && (
          <p className="text-[10px] text-zinc-600 mt-0.5">
            Blocked by: {blockers.map((b) => b!.subject).join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

export function TaskTree({ issueKey }: { issueKey: string }) {
  const [progress, setProgress] = useState<TaskProgress | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAPI()?.getTaskProgress(issueKey)
      .then(setProgress)
      .catch((err) => {
        console.warn(`[task-tree] Failed to load task progress for ${issueKey}:`, err);
      })
      .finally(() => setLoading(false));
  }, [issueKey]);

  if (loading) return <div className="py-4"><Spinner size="sm" /></div>;
  if (!progress?.found || !progress.tasks.length) return null;

  const completed = progress.tasks.filter((t) => t.status === "completed").length;
  const total = progress.tasks.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Tasks</h3>
        <div className="flex items-center gap-2">
          <div className="w-24 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-teal-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-zinc-500">{completed}/{total}</span>
        </div>
      </div>
      <div className="divide-y divide-zinc-800/50">
        {progress.tasks.map((task) => (
          <TaskNode key={task.id} task={task} allTasks={progress.tasks} />
        ))}
      </div>
    </div>
  );
}
