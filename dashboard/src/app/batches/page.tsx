"use client";

import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { BatchList } from "@/components/batches/BatchList";
import { Spinner } from "@/components/ui/Spinner";
import { useBatches } from "@/hooks/useBatches";
import { useSSE } from "@/lib/sse";

function BatchesPage({ baseUrl, secret }: { baseUrl: string; secret: string }) {
  useSSE(baseUrl, secret);
  const { data: batches, isLoading } = useBatches();

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-white">Batches</h2>
      {isLoading ? (
        <div className="flex justify-center py-20"><Spinner size="lg" /></div>
      ) : (
        <BatchList batches={batches || []} />
      )}
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      {({ baseUrl, secret }) => (
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 flex flex-col">
            <Header baseUrl={baseUrl} />
            <main className="flex-1 p-6">
              <BatchesPage baseUrl={baseUrl} secret={secret} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
