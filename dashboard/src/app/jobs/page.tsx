"use client";

import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { JobsTable } from "@/components/jobs/JobsTable";
import { Spinner } from "@/components/ui/Spinner";
import { useJobs } from "@/hooks/useJobs";
import { useSSE } from "@/lib/sse";
import { useState } from "react";
import type { JobsQueryParams } from "@/lib/types";

function JobsPage() {
  useSSE(); // Wire SSE for real-time updates via SWR mutation
  const [params, setParams] = useState<JobsQueryParams>({ page: 1, limit: 50 });
  const { data, isLoading } = useJobs(params);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Jobs</h2>
      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : (
        <JobsTable
          jobs={data?.jobs || []}
          pagination={data?.pagination}
          onParamsChange={setParams}
          params={params}
        />
      )}
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
            <main className="flex-1 p-2 sm:p-4 md:p-6">
              <JobsPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
