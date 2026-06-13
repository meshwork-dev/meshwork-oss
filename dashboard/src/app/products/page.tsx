"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { AuthGate } from "@/components/layout/AuthGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { Spinner } from "@/components/ui/Spinner";
import { getAPI } from "@/lib/api";
import type { Product } from "@/lib/types";

function ProductCard({ product, onReload }: { product: Product; onReload: () => void }) {
  const [reloading, setReloading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function handleReload() {
    setReloading(true);
    setMsg(null);
    try {
      await getAPI().reloadProduct(product.id);
      setMsg("Reloaded");
      onReload();
    } catch {
      setMsg("Reload failed");
    } finally {
      setReloading(false);
      setTimeout(() => setMsg(null), 3000);
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-white font-semibold text-base truncate">{product.name}</h3>
          {product.description && (
            <p className="text-zinc-400 text-sm mt-0.5 line-clamp-2">{product.description}</p>
          )}
        </div>
        {product.projectKey && (
          <span className="flex-shrink-0 px-2 py-0.5 rounded-full text-xs font-mono font-semibold bg-teal-500/10 text-teal-400 border border-teal-500/20">
            {product.projectKey}
          </span>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="font-mono bg-zinc-800 px-1.5 py-0.5 rounded truncate max-w-full">
            {product.workingDir}
          </span>
        </div>
        {product.pluginDir && (
          <div className="text-xs text-zinc-600">Plugin: {product.pluginDir}</div>
        )}
      </div>

      <div className="flex items-center gap-2 mt-auto pt-2 border-t border-zinc-800">
        <button
          onClick={handleReload}
          disabled={reloading}
          className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {reloading ? "Reloading…" : "Reload config"}
        </button>
        {msg && (
          <span className={`text-xs ${msg === "Reloaded" ? "text-emerald-400" : "text-red-400"}`}>
            {msg}
          </span>
        )}
      </div>
    </div>
  );
}

function ProductsPage() {
  const router = useRouter();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getAPI()
      .listProducts()
      .then(setProducts)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load products"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white">Products</h2>
          <p className="text-zinc-400 text-sm mt-0.5">Manage onboarded codebases and their Claude agents.</p>
        </div>
        <button
          onClick={() => router.push("/products/new")}
          className="px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold transition-colors"
        >
          + Onboard Product
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      )}

      {error && (
        <div className="text-center py-16">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={load} className="mt-3 text-xs text-zinc-400 hover:text-white underline">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && products.length === 0 && (
        <div className="text-center py-20 border border-dashed border-zinc-800 rounded-xl">
          <div className="text-5xl mb-4">◈</div>
          <h3 className="text-white font-semibold text-lg mb-2">No products onboarded yet</h3>
          <p className="text-zinc-400 text-sm mb-6 max-w-sm mx-auto">
            Onboard a codebase to give Claude agents the context they need to implement, review, and test features autonomously.
          </p>
          <button
            onClick={() => router.push("/products/new")}
            className="px-5 py-2.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white text-sm font-semibold transition-colors"
          >
            Onboard your first product
          </button>
        </div>
      )}

      {!loading && !error && products.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {products.map((p) => (
            <ProductCard key={p.id} product={p} onReload={load} />
          ))}
        </div>
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
              <ProductsPage />
            </main>
          </div>
        </div>
      )}
    </AuthGate>
  );
}
