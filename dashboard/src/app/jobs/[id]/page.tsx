"use client";

import { use } from "react";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { JobDetail } from "@/components/jobs/JobDetail";
import { Spinner } from "@/components/ui/Spinner";
import { useJob } from "@/hooks/useJobs";
import { useSSE } from "@/lib/sse";
import Link from "next/link";

function JobPage({ id, baseUrl, secret }: { id: string; baseUrl: string; secret: string }) {
  const { jobProgress } = useSSE(baseUrl, secret); // Wire SSE for real-time updates
  const { data: job, isLoading } = useJob(id);

  // Get live progress events for this specific job
  const liveProgress = jobProgress.get(id) || [];

  return (
    <div className="space-y-6">
      <Link href="/jobs" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Back to Jobs</Link>
      {isLoading || !job ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : (
        <JobDetail job={job} baseUrl={baseUrl} secret={secret} liveProgress={liveProgress} />
      )}
    </div>
  );
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <AuthGate>
      {({ baseUrl, secret }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-6">
              <JobPage id={id} baseUrl={baseUrl} secret={secret} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
