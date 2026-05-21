"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAPI } from "@/lib/api";
import type { Notification } from "@/lib/types";

const SEVERITY_STYLES: Record<Notification["severity"], { dot: string; icon: string }> = {
  info:    { dot: "bg-blue-500",   icon: "text-blue-400" },
  success: { dot: "bg-green-500",  icon: "text-green-400" },
  warning: { dot: "bg-yellow-400", icon: "text-yellow-400" },
  error:   { dot: "bg-red-500",    icon: "text-red-400" },
};

function SeverityIcon({ severity }: { severity: Notification["severity"] }) {
  const cls = `w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${SEVERITY_STYLES[severity].icon}`;
  if (severity === "success") {
    return (
      <svg className={cls} viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.28 5.28-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L6.75 8.69l3.47-3.47a.75.75 0 1 1 1.06 1.06z" />
      </svg>
    );
  }
  if (severity === "warning") {
    return (
      <svg className={cls} viewBox="0 0 16 16" fill="currentColor">
        <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z" />
      </svg>
    );
  }
  if (severity === "error") {
    return (
      <svg className={cls} viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V5a.5.5 0 0 1 .5-.5zm0 7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z" />
      </svg>
    );
  }
  // info
  return (
    <svg className={cls} viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 3.5a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM7.25 7a.75.75 0 0 1 1.5 0v4a.75.75 0 0 1-1.5 0V7z" />
    </svg>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const fetchCount = useCallback(async () => {
    const api = getAPI();
    if (!api) return;
    try {
      const res = await api.getNotificationCount();
      if (res.ok) setUnreadCount(res.count);
    } catch {
      // silently ignore — runner may not have the endpoint yet
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    const api = getAPI();
    if (!api) return;
    setLoading(true);
    try {
      const res = await api.listNotifications();
      if (res.ok) {
        setNotifications(res.notifications);
        setUnreadCount(res.notifications.filter((n) => !n.read).length);
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll unread count every 30 seconds
  useEffect(() => {
    fetchCount();
    const interval = setInterval(fetchCount, 30_000);
    return () => clearInterval(interval);
  }, [fetchCount]);

  // Load notifications when panel opens
  useEffect(() => {
    if (open) fetchNotifications();
  }, [open, fetchNotifications]);

  // Close panel when clicking outside
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const handleMarkRead = useCallback(
    async (id: number) => {
      const api = getAPI();
      if (!api) return;
      try {
        await api.markNotificationRead(id);
        setNotifications((prev) =>
          prev.map((n) => (n.id === id ? { ...n, read: true } : n))
        );
        setUnreadCount((c) => Math.max(0, c - 1));
      } catch {
        // silently ignore
      }
    },
    []
  );

  const handleMarkAllRead = useCallback(async () => {
    const api = getAPI();
    if (!api) return;
    try {
      await api.markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      // silently ignore
    }
  }, []);

  const handleNotificationClick = useCallback(
    async (n: Notification) => {
      if (!n.read) await handleMarkRead(n.id);
      if (n.link) {
        window.open(n.link, "_blank", "noopener,noreferrer");
      }
    },
    [handleMarkRead]
  );

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        aria-label="Notifications"
      >
        {/* Bell SVG */}
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>

        {/* Unread badge */}
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full mt-2 w-80 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-50 flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
            <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="overflow-y-auto max-h-80">
            {loading && (
              <div className="px-3 py-4 text-xs text-zinc-500 text-center">
                Loading...
              </div>
            )}
            {!loading && notifications.length === 0 && (
              <div className="px-3 py-6 text-xs text-zinc-500 text-center">
                No notifications
              </div>
            )}
            {!loading &&
              notifications.map((n) => (
                <div
                  key={n.id}
                  className={`flex items-start gap-2.5 px-3 py-2.5 border-b border-zinc-800 last:border-b-0 hover:bg-zinc-800/50 transition-colors ${
                    !n.read ? "bg-zinc-800/30" : ""
                  }`}
                >
                  {/* Unread dot */}
                  <div className="flex-shrink-0 mt-1.5">
                    {!n.read ? (
                      <span
                        className={`block w-1.5 h-1.5 rounded-full ${SEVERITY_STYLES[n.severity].dot}`}
                      />
                    ) : (
                      <span className="block w-1.5 h-1.5" />
                    )}
                  </div>

                  {/* Severity icon */}
                  <SeverityIcon severity={n.severity} />

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <button
                      onClick={() => handleNotificationClick(n)}
                      className={`block w-full text-left text-xs font-medium leading-snug mb-0.5 ${
                        n.link
                          ? "text-zinc-200 hover:text-white cursor-pointer"
                          : "text-zinc-200 cursor-default"
                      }`}
                    >
                      {n.title}
                    </button>
                    {n.body && (
                      <p className="text-xs text-zinc-500 leading-snug truncate">
                        {n.body}
                      </p>
                    )}
                    <span className="text-[10px] text-zinc-600 mt-0.5 block">
                      {formatRelativeTime(n.createdAt)}
                    </span>
                  </div>

                  {/* Mark as read button */}
                  {!n.read && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMarkRead(n.id);
                      }}
                      className="flex-shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors mt-0.5"
                      title="Mark as read"
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M2.5 8a5.5 5.5 0 0 1 8.25-4.764.75.75 0 0 0 .75-1.299A7 7 0 1 0 15 8a.75.75 0 0 0-1.5 0 5.5 5.5 0 1 1-11 0z" />
                        <path d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 9.999l-1.84-1.84a.75.75 0 0 1 1.06-1.06l.78.78 3.16-3.16a.75.75 0 0 1 1.06 0h.5z" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
          </div>

          {/* Footer */}
          {notifications.length > 0 && unreadCount === 0 && (
            <div className="px-3 py-2 border-t border-zinc-800 text-center">
              <span className="text-xs text-zinc-600">All caught up</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
