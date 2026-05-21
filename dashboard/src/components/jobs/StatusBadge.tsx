import { Badge } from "@/components/ui/Badge";

const statusColors: Record<string, string> = {
  queued: "blue",
  running: "yellow",
  succeeded: "green",
  failed: "red",
  cancelled: "gray",
  "retry-pending": "yellow",
  "quality-gate-retry": "yellow",
  "quality-gate-failed": "red",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge color={statusColors[status] || "gray"}>{status}</Badge>;
}
