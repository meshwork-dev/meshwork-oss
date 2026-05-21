"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";

const OfficeScene = dynamic(() => import("@/components/office/OfficePixelScene"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[480px] text-zinc-500">
      Loading pixel office…
    </div>
  ),
});

type Product = { id: string; name: string };

function OfficeView({ baseUrl, secret }: { baseUrl: string; secret: string }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${baseUrl}/api/products`, { headers: { "x-runner-secret": secret } })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Product[]) => {
        if (Array.isArray(list)) setProducts(list);
      })
      .catch(() => {});
  }, [baseUrl, secret]);

  const current = products.find((p) => p.id === productId);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">
            The Office{current ? ` — ${current.name}` : ""}
          </h2>
          <p className="text-xs text-zinc-500">
            {productId
              ? `Scoped to ${current?.name ?? productId}. Only this product's agents are shown.`
              : "Platform roster (all products combined). Hover an agent for details."}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <span>Product</span>
          <select
            value={productId ?? ""}
            onChange={(e) => setProductId(e.target.value || null)}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:ring-1 focus:ring-teal-500"
          >
            <option value="">All (platform)</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        <OfficeScene
          key={productId ?? "all"}
          baseUrl={baseUrl}
          secret={secret}
          productId={productId}
        />
      </div>
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
            <main className="flex-1 p-2 sm:p-4 md:p-6">
              <OfficeView baseUrl={baseUrl} secret={secret} />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
