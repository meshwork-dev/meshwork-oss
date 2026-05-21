"use client";

import { useEffect, useState } from "react";
import { mutate } from "swr";
import { useRouter } from "next/navigation";
import { getAPI } from "@/lib/api";
import type { Job, JobOutput, JobProgress, StreamEvent } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { LiveLog } from "./LiveLog";
import { LiveActivity } from "./LiveActivity";
import { TaskTree } from "./TaskTree";
import { Card, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";

export function JobDetail({ job, baseUrl, secret, liveProgress }: {
  job: Job;
  baseUrl?: string;
  secret?: string;
  liveProgress?: JobProgress[];
}) {
  const router = useRouter();
  const [output, setOutput] = useState<JobOutput | null>(null);
  const [streamEvents, setStreamEvents] = useState<StreamEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (job.status === "succeeded" || job.status === "failed") {
      setLoading(true);
      Promise.all([
        getAPI()?.getJobOutput(job.id).catch(() => null),
        getAPI()?.getStreamEvents(job.id).catch(() => null),
      ]).then(([out, stream]) => {
        if (out) setOutput(out);
        if (stream?.events) setStreamEvents(stream.events);
      }).finally(() => setLoading(false));
    } else if (job.status === "running") {
      // Fetch existing stream events for running jobs (catches up with activity before page load)
      getAPI()?.getStreamEvents(job.id).then((stream) => {
        if (stream?.events) setStreamEvents(stream.events);
      }).catch(() => {});
    }
  }, [job.id, job.status]);

  const isActive = job.status === "running" || job.status === "queued";
  const canRetry = job.status === "failed" || job.status === "cancelled";

  async function handleCancel() {
    if (!confirm("Cancel this job?")) return;
    setCancelling(true);
    try {
      await getAPI()?.cancelJob(job.id);
      mutate(`job:${job.id}`);
      mutate("jobs");
    } catch { /* ignore */ }
    setCancelling(false);
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      const result = await getAPI()?.retryJob(job.id);
      if (result?.jobId) {
        router.push(`/jobs/${result.jobId}`);
      }
    } catch { /* ignore */ }
    setRetrying(false);
  }

  // Extract the text result from parsedOutput
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outputAny = output as any;
  const resultText = outputAny?.parsedOutput?.result ?? output?.result;

  // Get prompt from job data (agent mode stores prompt, delivery stores description/summary)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jobAny = job as any;
  const prompt = (jobAny.prompt || jobAny.description || jobAny.summary || "") as string;
  const context = (jobAny.context || "") as string;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <h2 className="text-lg font-bold text-white font-mono">{job.id}</h2>
        <StatusBadge status={job.status} />
        {job.provider && (
          <Badge color={job.provider === "zai" ? "blue" : "teal"}>
            {job.provider === "zai" ? "Z.ai" : "Claude"}
          </Badge>
        )}
        {job.chromeEnabled && <Badge color="blue">Chrome</Badge>}
        <div className="ml-auto flex gap-2">
          {canRetry && (
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="px-3 py-1 text-xs font-medium rounded-lg bg-teal-600/20 text-teal-400 hover:bg-teal-600/30 border border-teal-600/30 transition-colors disabled:opacity-50"
            >
              {retrying ? "Retrying..." : "Retry Job"}
            </button>
          )}
          {isActive && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className="px-3 py-1 text-xs font-medium rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-600/30 transition-colors disabled:opacity-50"
            >
              {cancelling ? "Cancelling..." : "Cancel Job"}
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <InfoItem label="Agent" value={job.agent || "-"} />
        <InfoItem label="Model" value={job.selectedModel || job.model || "-"} />
        <InfoItem label="Provider" value={job.provider === "zai" ? "Z.ai" : job.provider || "-"} />
        <InfoItem label="Issue" value={job.issueKey || "-"} />
        <InfoItem label="Mode" value={job.mode} />
        <InfoItem label="Created" value={job.createdAt ? new Date(job.createdAt).toLocaleString() : "-"} />
        <InfoItem label="Duration" value={
          job.startedAt && job.finishedAt
            ? `${Math.round((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)}s`
            : job.duration ? `${Math.round(job.duration / 1000)}s` : "-"
        } />
        <InfoItem label="Cost" value={job.estimatedCostUsd != null ? `$${job.estimatedCostUsd.toFixed(4)}` : "-"} />
        <InfoItem label="Tokens" value={job.inputTokens ? `${job.inputTokens} in / ${job.outputTokens} out` : "-"} />
      </div>

      {job.source && (
        <div className="flex items-center gap-4 text-xs text-zinc-500 bg-zinc-900/50 border border-zinc-800 rounded-lg px-4 py-2">
          {job.source.workflow && <span>Workflow: <span className="text-zinc-400">{job.source.workflow}</span></span>}
          {job.source.triggeredBy && <span>Trigger: <span className="text-zinc-400">{job.source.triggeredBy}</span></span>}
        </div>
      )}

      {/* Prompt */}
      {prompt && (
        <Card>
          <CardTitle>Prompt</CardTitle>
          <div className="mt-2 text-sm text-zinc-300 whitespace-pre-wrap">{prompt}</div>
          {context && (
            <div className="mt-3 pt-3 border-t border-zinc-800">
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Context</p>
              <div className="text-sm text-zinc-400 whitespace-pre-wrap">{context}</div>
            </div>
          )}
        </Card>
      )}

      {job.lastError && (
        <Card className="border-red-500/30">
          <CardTitle>Error</CardTitle>
          <pre className="text-red-400 text-xs mt-2 whitespace-pre-wrap">{job.lastError}</pre>
        </Card>
      )}

      {/* Quality gate results */}
      {job.qualityGate && !job.qualityGate.skipped && (
        <Card className={job.qualityGate.passed ? "border-green-500/30" : "border-red-500/30"}>
          <div className="flex items-center gap-3">
            <CardTitle>Quality Gate</CardTitle>
            <Badge color={job.qualityGate.passed ? "green" : "red"}>
              {job.qualityGate.passed ? "Passed" : "Failed"}
            </Badge>
          </div>
          {job.qualityGate.results && job.qualityGate.results.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {job.qualityGate.results.map((check) => (
                <div key={check.name} className="flex items-center gap-3 text-xs">
                  <span className={check.passed ? "text-green-400" : "text-red-400"}>
                    {check.passed ? "\u2713" : "\u2717"}
                  </span>
                  <span className="text-zinc-300">{check.name}</span>
                  {check.duration != null && (
                    <span className="text-zinc-600">{Math.round(check.duration)}ms</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Chrome usage details */}
      {job.chromeEnabled && job.chromeUsage && (
        <Card className="border-blue-500/20">
          <div className="flex items-center gap-3">
            <CardTitle>Chrome Integration</CardTitle>
            <Badge color={job.chromeUsage.used ? "blue" : "gray"}>
              {job.chromeUsage.used ? `${job.chromeUsage.count} tool calls` : "Available (unused)"}
            </Badge>
          </div>
          {job.chromeUsage.used && job.chromeUsage.tools.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {job.chromeUsage.tools.map((tool) => (
                <span key={tool} className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 text-xs font-mono">
                  {tool.replace("mcp__claude-in-chrome__", "")}
                </span>
              ))}
            </div>
          )}
          {job.chromeReason && (
            <p className="mt-2 text-xs text-zinc-500">{job.chromeReason}</p>
          )}
        </Card>
      )}

      {/* Live activity stream for running jobs */}
      {isActive && liveProgress && liveProgress.length > 0 && (
        <LiveActivity progress={liveProgress} />
      )}

      {/* Live log for active jobs */}
      {isActive && baseUrl && secret && (
        <LiveLog jobId={job.id} jobStatus={job.status} />
      )}

      {/* Task tree for jobs with an issue key */}
      {job.issueKey && (
        <TaskTree issueKey={job.issueKey} />
      )}

      {/* Tool usage summary */}
      {streamEvents.length > 0 && (
        <Card className="border-zinc-700/50">
          <CardTitle>Tool Usage</CardTitle>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(
              streamEvents.reduce((acc, e) => {
                if (e.type === "tool_use") {
                  acc[e.tool] = (acc[e.tool] || 0) + 1;
                }
                return acc;
              }, {} as Record<string, number>)
            )
              .sort(([, a], [, b]) => b - a)
              .map(([tool, count]) => (
                <span key={tool} className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 text-xs font-mono">
                  {tool} <span className="text-zinc-600">{count}x</span>
                </span>
              ))}
          </div>
        </Card>
      )}

      {loading && (
        <div className="flex justify-center py-8"><Spinner /></div>
      )}

      {/* Response */}
      {resultText && (
        <Card>
          <CardTitle>Response</CardTitle>
          <div className="mt-2 text-sm text-zinc-300 whitespace-pre-wrap max-h-[800px] overflow-y-auto leading-relaxed">
            {resultText}
          </div>
        </Card>
      )}
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-wider">{label}</p>
      <p className="text-sm text-zinc-300 mt-0.5">{value}</p>
    </div>
  );
}
