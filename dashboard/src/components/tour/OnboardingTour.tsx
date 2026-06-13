"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "meshwork-onboarding-v1";
const DONE_VALUE = "done";

interface Step {
  id: string;
  title: string;
  body: string;
  tourTarget?: string; // data-tour attribute value; absent = centered modal
}

const STEPS: Step[] = [
  {
    id: "welcome",
    title: "Welcome to Meshwork",
    body: "A quick tour of the key areas. Takes 30 seconds.",
  },
  {
    id: "issues",
    title: "Issue Tracker",
    body: "Browse and manage your backlog — stories, bugs, tasks, and epics. Issues can be created here or synced automatically if you connect an external tracker like Jira.",
    tourTarget: "issues",
  },
  {
    id: "pipelines",
    title: "Pipelines",
    body: "Multi-phase SDLC workflows — plan, implement, review, verify. Build custom pipelines or use built-in templates.",
    tourTarget: "pipelines",
  },
  {
    id: "agents",
    title: "Agents",
    body: "Specialist AI agents for each role — engineer, reviewer, QA, security, and more. Each has its own prompt and tool configuration. Add product-specific agents in Markdown.",
    tourTarget: "agents",
  },
  {
    id: "chat",
    title: "Chat",
    body: "Talk directly to any agent. Select from the dropdown or use /agent commands to route to a specialist inline.",
    tourTarget: "chat",
  },
  {
    id: "settings",
    title: "Integrations",
    body: "Optionally connect Jira, Telegram, Slack, and N8N. All integrations are optional — the runner works standalone, but connecting them unlocks automated dispatch and notifications.",
    tourTarget: "settings",
  },
  {
    id: "done",
    title: "You're ready",
    body: "Trigger a pipeline or start a chat with an agent to get going. Connect integrations in Settings whenever you're ready. Check the Guide tab for detailed docs.",
  },
];

interface HighlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getTargetRect(tourTarget: string): HighlightRect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${tourTarget}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

interface TooltipPosition {
  top: number;
  left: number;
}

const PADDING = 10; // padding around highlighted element
const TOOLTIP_WIDTH = 288; // max-w-xs = 288px
const TOOLTIP_MARGIN = 16;

function computeTooltipPosition(
  rect: HighlightRect,
  viewportWidth: number,
  viewportHeight: number
): TooltipPosition {
  // Try placing to the right of the element
  let left = rect.left + rect.width + TOOLTIP_MARGIN;
  let top = rect.top + rect.height / 2 - 80;

  // If it overflows right, try left
  if (left + TOOLTIP_WIDTH > viewportWidth - TOOLTIP_MARGIN) {
    left = rect.left - TOOLTIP_WIDTH - TOOLTIP_MARGIN;
  }

  // If it overflows left (e.g. element is near left edge), place below
  if (left < TOOLTIP_MARGIN) {
    left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
    top = rect.top + rect.height + TOOLTIP_MARGIN;
  }

  // Clamp vertically
  top = Math.max(TOOLTIP_MARGIN, Math.min(top, viewportHeight - 200));
  // Clamp horizontally
  left = Math.max(TOOLTIP_MARGIN, Math.min(left, viewportWidth - TOOLTIP_WIDTH - TOOLTIP_MARGIN));

  return { top, left };
}

export function OnboardingTour() {
  const [visible, setVisible] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [highlightRect, setHighlightRect] = useState<HighlightRect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<TooltipPosition>({ top: 0, left: 0 });
  const rafRef = useRef<number | null>(null);

  const currentStep = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;
  const isModal = !currentStep.tourTarget;

  // Mark as done and close
  const closeTour = useCallback((markDone: boolean) => {
    if (markDone && typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, DONE_VALUE);
    }
    setVisible(false);
    setStepIndex(0);
    setHighlightRect(null);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const startTour = useCallback(() => {
    setStepIndex(0);
    setVisible(true);
  }, []);

  // Auto-show on first visit + listen for programmatic trigger
  useEffect(() => {
    if (typeof window === "undefined") return;

    const alreadyDone = localStorage.getItem(STORAGE_KEY) === DONE_VALUE;
    if (!alreadyDone) {
      setVisible(true);
    }

    const handler = () => startTour();
    window.addEventListener("meshwork:start-tour", handler);
    return () => window.removeEventListener("meshwork:start-tour", handler);
  }, [startTour]);

  // Update highlight rect and tooltip position whenever step or visibility changes
  useEffect(() => {
    if (!visible || isModal) {
      setHighlightRect(null);
      return;
    }

    function update() {
      const target = currentStep.tourTarget;
      if (!target) {
        setHighlightRect(null);
        return;
      }
      const rect = getTargetRect(target);
      if (rect) {
        setHighlightRect(rect);
        setTooltipPos(computeTooltipPosition(rect, window.innerWidth, window.innerHeight));
      } else {
        setHighlightRect(null);
      }
    }

    update();
    // Keep updating on scroll/resize
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("scroll", update, { passive: true, capture: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, { capture: true });
    };
  }, [visible, stepIndex, isModal, currentStep.tourTarget]);

  const advance = useCallback(() => {
    if (isLast) {
      closeTour(true);
      return;
    }

    // Find next step that has a visible target (or is a modal step)
    let next = stepIndex + 1;
    while (next < STEPS.length - 1) {
      const s = STEPS[next];
      if (!s.tourTarget) break; // modal step — always show
      const el = typeof document !== "undefined"
        ? document.querySelector(`[data-tour="${s.tourTarget}"]`)
        : null;
      if (el) break;
      next++; // skip steps whose targets aren't in the DOM
    }
    setStepIndex(next);
  }, [isLast, stepIndex, closeTour]);

  const back = useCallback(() => {
    if (isFirst) return;
    setStepIndex((i) => Math.max(0, i - 1));
  }, [isFirst]);

  if (!visible) return null;

  const stepLabel = `${stepIndex + 1} of ${STEPS.length}`;

  // ---- Modal (Welcome / Done) ----
  if (isModal) {
    return (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
        onClick={(e) => { if (e.target === e.currentTarget) closeTour(false); }}
      >
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-zinc-500">{stepLabel}</span>
            <button
              onClick={() => closeTour(false)}
              className="text-zinc-600 hover:text-zinc-300 text-lg leading-none"
              aria-label="Close tour"
            >
              ×
            </button>
          </div>
          <h2 className="text-lg font-bold text-white mt-1 mb-2">{currentStep.title}</h2>
          <p className="text-sm text-zinc-300 leading-relaxed mb-6">{currentStep.body}</p>
          <div className="flex gap-2">
            {isFirst ? (
              <>
                <button
                  onClick={advance}
                  className="flex-1 rounded-lg bg-teal-500 hover:bg-teal-400 text-zinc-900 font-semibold text-sm py-2 transition-colors"
                >
                  Take the tour
                </button>
                <button
                  onClick={() => closeTour(true)}
                  className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  Skip
                </button>
              </>
            ) : (
              <>
                {!isFirst && (
                  <button
                    onClick={back}
                    className="rounded-lg px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={advance}
                  className="flex-1 rounded-lg bg-teal-500 hover:bg-teal-400 text-zinc-900 font-semibold text-sm py-2 transition-colors"
                >
                  {isLast ? "Let's go" : "Next"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- Highlight step ----
  const pad = PADDING;
  const cutout = highlightRect
    ? {
        top: highlightRect.top - pad,
        left: highlightRect.left - pad,
        width: highlightRect.width + pad * 2,
        height: highlightRect.height + pad * 2,
      }
    : null;

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none">
      {/* Overlay with cutout via clip-path */}
      {cutout ? (
        <div
          className="absolute inset-0 bg-black/50 pointer-events-auto"
          style={{
            clipPath: `polygon(
              0% 0%, 100% 0%, 100% 100%, 0% 100%,
              0% ${cutout.top}px,
              ${cutout.left}px ${cutout.top}px,
              ${cutout.left}px ${cutout.top + cutout.height}px,
              ${cutout.left + cutout.width}px ${cutout.top + cutout.height}px,
              ${cutout.left + cutout.width}px ${cutout.top}px,
              0% ${cutout.top}px
            )`,
          }}
          onClick={() => closeTour(false)}
        />
      ) : (
        // Target not found — show full overlay
        <div
          className="absolute inset-0 bg-black/50 pointer-events-auto"
          onClick={() => closeTour(false)}
        />
      )}

      {/* Highlight ring around target */}
      {cutout && (
        <div
          className="absolute rounded-lg border-2 border-teal-400/70 pointer-events-none"
          style={{
            top: cutout.top,
            left: cutout.left,
            width: cutout.width,
            height: cutout.height,
          }}
        />
      )}

      {/* Tooltip */}
      <div
        className="absolute bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl p-5 pointer-events-auto"
        style={{
          width: TOOLTIP_WIDTH,
          top: tooltipPos.top,
          left: tooltipPos.left,
        }}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs text-zinc-500">{stepLabel}</span>
          <button
            onClick={() => closeTour(false)}
            className="text-zinc-600 hover:text-zinc-300 text-lg leading-none"
            aria-label="Close tour"
          >
            ×
          </button>
        </div>
        <h3 className="text-base font-bold text-white mt-1 mb-1.5">{currentStep.title}</h3>
        <p className="text-sm text-zinc-300 leading-relaxed mb-4">{currentStep.body}</p>
        <div className="flex gap-2">
          {!isFirst && (
            <button
              onClick={back}
              className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
            >
              Back
            </button>
          )}
          <button
            onClick={advance}
            className="flex-1 rounded-lg bg-teal-500 hover:bg-teal-400 text-zinc-900 font-semibold text-sm py-1.5 transition-colors"
          >
            {isLast ? "Let's go" : "Next"}
          </button>
          <button
            onClick={() => closeTour(true)}
            className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

export default OnboardingTour;
