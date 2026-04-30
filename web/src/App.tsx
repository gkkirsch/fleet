import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AppWindow, ArrowLeft, ArrowUp, ArrowUpRight, BookOpen, CalendarClock, Check, ChevronRight, Clock, CornerDownRight, ExternalLink, Eye, EyeOff, Globe, KeyRound, Layers, Loader2, Maximize2, MessageCircle, Minimize2, MousePointerClick, Navigation, Package, Paperclip, PanelLeft, PanelLeftClose, PanelRight, PanelRightClose, Pencil, Plus, Send, Sparkles, Square, SquareCheckBig, SquareX, Store, TerminalSquare, Trash2, TriangleAlert, Users, Workflow, X as XIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { cn } from "@/lib/utils";
import { SPINNER_PHRASES } from "./spinnerVerbs";
import type { Agent, Artifact, ClaudeDirView, CredentialDecl, Marketplace, MarketPlugin, Message, NamedMD, Plugin, Schedule, ScheduleSuggestion, SetupScript, Skill } from "./types";

const POLL_MS = 2000;
const PANEL_STORAGE_KEY = "fleetview-thread-panel-open";

function useThreadPanel() {
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(PANEL_STORAGE_KEY);
    return v === null ? true : v === "true";
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    localStorage.setItem(PANEL_STORAGE_KEY, String(next));
  }, []);
  return {
    open,
    set,
    toggle: useCallback(() => set(!open), [open, set]),
    close: useCallback(() => set(false), [set]),
  };
}

const SIDEBAR_STORAGE_KEY = "fleetview.sidebar.open";

function useFleetSidebar() {
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return v === null ? true : v === "true";
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
  }, []);
  return {
    open,
    set,
    toggle: useCallback(() => set(!open), [open, set]),
  };
}

const ARTIFACT_PANEL_STORAGE_KEY = "fleetview.artifactPanel.open";

function useArtifactPanel() {
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(ARTIFACT_PANEL_STORAGE_KEY);
    return v === "true";
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    localStorage.setItem(ARTIFACT_PANEL_STORAGE_KEY, String(next));
  }, []);
  return {
    open,
    set,
    toggle: useCallback(() => set(!open), [open, set]),
    close: useCallback(() => set(false), [set]),
  };
}

const SCHEDULES_PANEL_STORAGE_KEY = "fleetview.schedulesPanel.open";

function useSchedulesPanel() {
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(SCHEDULES_PANEL_STORAGE_KEY);
    return v === "true";
  });
  const set = useCallback((next: boolean) => {
    setOpen(next);
    localStorage.setItem(SCHEDULES_PANEL_STORAGE_KEY, String(next));
  }, []);
  return {
    open,
    set,
    toggle: useCallback(() => set(!open), [open, set]),
    close: useCallback(() => set(false), [set]),
  };
}

export function App() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  // User's explicit pick. When null, we fall back to the dispatcher so
  // the app opens on something useful instead of the empty "select one".
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selectedId =
    pickedId ?? agents?.find((a) => a.kind === "dispatcher")?.id ?? null;
  const setSelectedId = setPickedId;
  const [messages, setMessages] = useState<Message[]>([]);
  const panel = useThreadPanel();
  const artifactPanel = useArtifactPanel();
  const schedulesPanel = useSchedulesPanel();
  const sidebar = useFleetSidebar();
  // Mutually-exclusive panels — opening one auto-closes the others.
  const toggleSettings = useCallback(() => {
    if (!panel.open) {
      artifactPanel.close();
      schedulesPanel.close();
    }
    panel.toggle();
  }, [panel, artifactPanel, schedulesPanel]);
  const toggleArtifact = useCallback(() => {
    if (!artifactPanel.open) {
      panel.close();
      schedulesPanel.close();
    }
    artifactPanel.toggle();
  }, [panel, artifactPanel, schedulesPanel]);
  const toggleSchedules = useCallback(() => {
    if (!schedulesPanel.open) {
      panel.close();
      artifactPanel.close();
    }
    schedulesPanel.toggle();
  }, [panel, artifactPanel, schedulesPanel]);
  // Map of agent id → timestamp of a just-sent message. Used to show the
  // thinking shimmer immediately, before backend polling catches up to the
  // agent entering "streaming" state. Cleared by the effect below.
  const [pendingSends, setPendingSends] = useState<Record<string, number>>({});
  const markPending = useCallback((id: string) => {
    setPendingSends((p) => ({ ...p, [id]: Date.now() }));
  }, []);
  const clearPending = useCallback((id: string) => {
    setPendingSends((p) => {
      if (!(id in p)) return p;
      const n = { ...p };
      delete n[id];
      return n;
    });
  }, []);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const r = await fetch("/api/fleet").catch(() => null);
      if (stop || !r || !r.ok) return;
      setAgents(((await r.json()) as Agent[] | null) ?? []);
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, []);

  // If the explicitly-picked agent vanishes (e.g. user just deleted it),
  // drop the pick so the derived selectedId falls back to the dispatcher.
  useEffect(() => {
    if (pickedId && agents && !agents.some((a) => a.id === pickedId)) {
      setPickedId(null);
    }
  }, [agents, pickedId]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let stop = false;
    const tick = async () => {
      const r = await fetch(`/api/agents/${selectedId}/messages`).catch(() => null);
      if (stop || !r || !r.ok) return;
      setMessages(((await r.json()) as Message[] | null) ?? []);
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [selectedId]);

  const selected = agents?.find((a) => a.id === selectedId) ?? null;

  // Clear per-agent pending flags once the backend has caught up (status
  // flipped to streaming — the shimmer keeps rendering from that source).
  // Safety: also expire after 60s so a silent backend doesn't strand us.
  useEffect(() => {
    if (!agents) return;
    const toClear: string[] = [];
    for (const [id, sentAt] of Object.entries(pendingSends)) {
      const a = agents.find((x) => x.id === id);
      const streaming = a?.status === "streaming";
      const expired = Date.now() - sentAt > 60_000;
      if (streaming || expired) toClear.push(id);
    }
    if (toClear.length) {
      setPendingSends((p) => {
        const n = { ...p };
        toClear.forEach((id) => delete n[id]);
        return n;
      });
    }
  }, [agents, pendingSends]);

  // Force a periodic re-render so the 60s safety timeout re-evaluates even
  // when nothing else changes (e.g. backend down).
  useEffect(() => {
    if (Object.keys(pendingSends).length === 0) return;
    const h = setInterval(() => setPendingSends((p) => ({ ...p })), 5_000);
    return () => clearInterval(h);
  }, [pendingSends]);

  const isPending = selected ? !!pendingSends[selected.id] : false;

  // Skills panel is orchestrator-only: the dispatcher / director has no
  // skills (it's a router). Gate the rendered "open" state on agent
  // kind so first launch — which selects the dispatcher by default —
  // doesn't show an empty skills drawer. The user's stored preference
  // (panel.open) is preserved and applies again as soon as they
  // navigate to an orchestrator.
  const skillsPanelOpen = panel.open && selected?.kind === "orchestrator";

  return (
    <div className="h-screen flex bg-background text-foreground">
      <div
        className={cn(
          "shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out",
          sidebar.open ? "w-[280px]" : "w-[56px]"
        )}
      >
        <Sidebar
          agents={agents}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            // The director/dispatcher has no Skills/Artifact/Schedules
            // sheets — close any that were open from a previous agent
            // so the chat takes the full width as expected.
            const next = agents?.find((a) => a.id === id);
            if (next?.kind === "dispatcher") {
              panel.close();
              artifactPanel.close();
              schedulesPanel.close();
            }
          }}
          collapsed={!sidebar.open}
          onToggle={sidebar.toggle}
        />
      </div>
      <div className="flex-1 min-w-0">
        <Detail
          agent={selected}
          messages={messages}
          isPending={isPending}
          onSent={markPending}
          onInterrupted={clearPending}
          panelOpen={skillsPanelOpen}
          onTogglePanel={toggleSettings}
          artifactPanelOpen={artifactPanel.open}
          onToggleArtifactPanel={toggleArtifact}
          schedulesPanelOpen={schedulesPanel.open}
          onToggleSchedulesPanel={toggleSchedules}
          sidebarOpen={sidebar.open}
          onToggleSidebar={sidebar.toggle}
        />
      </div>
      <ThreadPanel
        agent={selected}
        open={skillsPanelOpen}
      />
      <ArtifactPanel
        agent={selected}
        open={artifactPanel.open}
        onClose={artifactPanel.close}
      />
      <SchedulesPanel
        agent={selected}
        open={schedulesPanel.open}
        onClose={schedulesPanel.close}
      />
    </div>
  );
}

// ─── avatar ──────────────────────────────────────────────────────

// Director brand mark — two stacked rounded squares, colon-shaped.
// 10×22 viewBox: two 10×10 squares (y=0..10, y=12..22) with a 2-unit
// gap. Squares fill the viewBox exactly (no overflow), so the rendered
// size matches the className height — what you set is what you get.
function DirectorMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 10 22"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <rect x="0" y="0" width="10" height="10" rx="2.4" />
      <rect x="0" y="12" width="10" height="10" rx="2.4" />
    </svg>
  );
}

// Flat-icon variant of KindTile used in the sidebar tree. No bg square,
// just the lucide glyph in a muted japandi tone — keeps the row visually
// quieter so the agent's name/description carries the row.
function KindGlyph({ kind, size = 18 }: { kind: string; size?: number }) {
  const map: Record<string, { fg: string; Icon: typeof Workflow; filled?: boolean; stroke?: number }> = {
    dispatcher: { fg: "text-[color:var(--clay)]", Icon: Navigation, filled: true, stroke: 2.4 },
    orchestrator: { fg: "text-[color:var(--primary)]", Icon: Layers },
    worker: { fg: "text-muted-foreground", Icon: CornerDownRight },
  };
  const s = map[kind] ?? map.worker;
  const Icon = s.Icon;
  // Inner icon is ~83% of the square so the glyph reads at any size.
  const inner = Math.round(size * 0.83);
  return (
    <div
      className="flex-shrink-0 flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <Icon
        className={s.fg}
        size={inner}
        strokeWidth={s.stroke ?? 1.7}
        fill={s.filled ? "currentColor" : "none"}
      />
    </div>
  );
}

function KindTile({
  kind,
  size = 40,
}: {
  kind: string;
  size?: number;
}) {
  // Color + glyph per kind. Muted palette — never louder than a soft candy.
  const map: Record<string, { bg: string; fg: string; Icon: typeof Workflow }> = {
    dispatcher: {
      bg: "bg-[color:var(--clay-soft)]",
      fg: "text-[color:var(--clay)]",
      Icon: MessageCircle,
    },
    orchestrator: {
      bg: "bg-[color:var(--matcha-soft)]",
      fg: "text-[color:var(--primary)]",
      Icon: Layers,
    },
    worker: {
      bg: "bg-[color:var(--ochre-soft)]",
      fg: "text-[color:var(--ochre)]",
      Icon: ArrowUpRight,
    },
  };
  const s = map[kind] ?? map.worker;
  const Icon = s.Icon;
  return (
    <div
      className={cn(
        "rounded-lg flex items-center justify-center flex-shrink-0",
        s.bg
      )}
      style={{ width: size, height: size }}
    >
      <Icon className={s.fg} size={Math.round(size * 0.45)} strokeWidth={1.8} />
    </div>
  );
}

// ─── sidebar ─────────────────────────────────────────────────────

type Tree = {
  children: Map<string, Agent[]>;
  roots: Agent[];
};

function buildTree(agents: Agent[]): Tree {
  const byId = new Set(agents.map((a) => a.id));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  agents.forEach((a) => {
    if (a.parent && byId.has(a.parent)) {
      const kids = children.get(a.parent) ?? [];
      kids.push(a);
      children.set(a.parent, kids);
    } else {
      roots.push(a);
    }
  });
  return { children, roots };
}

function Sidebar({
  agents,
  selectedId,
  onSelect,
  collapsed = false,
  onToggle,
}: {
  agents: Agent[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed?: boolean;
  onToggle: () => void;
}) {
  const tree = useMemo(() => buildTree(agents ?? []), [agents]);
  const ToggleIcon = collapsed ? PanelLeft : PanelLeftClose;

  if (collapsed) {
    // Rail mode: brand mark anchor up top (so the brand doesn't
    // disappear with the nav) + clickable kind tiles stacked below.
    const ordered = flattenTree(tree);
    return (
      <aside className="border-r border-border/60 bg-sidebar flex flex-col h-full min-h-0 items-center overflow-hidden select-none">
        <div className="pt-10 pb-5">
          <DirectorMark className="h-7 w-auto text-foreground" />
        </div>
        <div className="flex-1 min-h-0 flex flex-col items-center gap-1 px-1 pt-1 pb-6 overflow-y-auto">
          {ordered.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id)}
              title={displayName(a)}
              className={cn(
                "rounded-md p-2 transition-colors",
                a.id === selectedId
                  ? "bg-card shadow-sm ring-1 ring-border/70"
                  : "hover:bg-sidebar-accent/60"
              )}
            >
              <KindGlyph kind={a.kind} />
            </button>
          ))}
        </div>
        <div className="flex items-center justify-center pb-4">
          <button
            type="button"
            onClick={onToggle}
            title="Expand fleet"
            className="text-muted-foreground hover:text-foreground transition-colors p-2"
          >
            <ToggleIcon className="w-4 h-4" strokeWidth={1.8} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="border-r border-border/60 bg-sidebar flex flex-col h-full min-h-0 w-[280px] select-none">
      <div className="px-8 pt-10 pb-6">
        <div className="flex items-center gap-3">
          <DirectorMark className="h-[32px] w-auto shrink-0 text-foreground" />
          <h1 className="font-[family-name:var(--font-heading)] text-[36px] leading-none tracking-tight text-foreground">
            director
          </h1>
        </div>
      </div>
      <div className="scrollbar-calm flex-1 min-h-0 overflow-y-auto px-4 pt-1 pb-8 space-y-2">
        {agents === null && (
          <p className="text-muted-foreground text-sm px-4 py-6 italic">loading…</p>
        )}
        {agents !== null && agents.length === 0 && (
          <p className="text-muted-foreground text-sm px-4 py-6">no agents yet</p>
        )}
        {tree.roots.map((a) => (
          <AgentNode
            key={a.id}
            agent={a}
            tree={tree}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
      <div className="flex items-center justify-end px-4 pb-4">
        <button
          type="button"
          onClick={onToggle}
          title="Collapse fleet"
          className="text-muted-foreground hover:text-foreground transition-colors p-2"
        >
          <ToggleIcon className="w-4 h-4" strokeWidth={1.8} />
        </button>
      </div>
    </aside>
  );
}

// Walk the tree depth-first into a flat ordered list, preserving the
// dispatcher → orchestrators → workers grouping. Used by the
// collapsed rail.
function flattenTree(tree: Tree): Agent[] {
  const out: Agent[] = [];
  const walk = (a: Agent) => {
    out.push(a);
    for (const k of tree.children.get(a.id) ?? []) walk(k);
  };
  for (const r of tree.roots) walk(r);
  return out;
}

function AgentNode({
  agent,
  tree,
  selectedId,
  onSelect,
  depth = 0,
}: {
  agent: Agent;
  tree: Tree;
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}) {
  const kids = tree.children.get(agent.id) ?? [];
  const isSelected = agent.id === selectedId;
  const isWorker = agent.kind === "worker";
  // Workers show their description as the primary label (their narrow
  // scope is what distinguishes them — the generated id isn't useful).
  // Dispatchers/orchestrators show their name. Description-only when
  // the worker has one; otherwise fall back to the name.
  const primaryLabel =
    isWorker && agent.description ? agent.description : displayName(agent);
  // Status is conveyed by the row itself, not a second line:
  //   streaming           → shimmer the label
  //   permission/trust    → clay notification dot
  //   stopped/dead/not-found → no indicator (the user can still send;
  //                            notify auto-resumes)
  const isStreaming = agent.status === "streaming";
  // Workers never directly ask the user — their parent orch handles
  // anything user-facing. A worker that's hit a permission/trust prompt
  // is a stuck-on-itself problem the orch needs to recover from, not
  // something to ping the user about.
  const needsAttention =
    !isWorker &&
    (agent.status === "trust-dialog" || agent.status === "permission-dialog");

  // Visual hierarchy: dispatch and orchestrators sit at the same
  // root indent (workers under their orchestrator stay nested). The
  // dispatcher is the only "header" and gets a small gap below it
  // before its orchestrator children to feel like a section.
  const isDispatcher = agent.kind === "dispatcher";
  const kidIndent = isDispatcher ? "" : "ml-5 mt-1 space-y-1";
  const kidsTopGap = isDispatcher ? "mt-2.5 space-y-1" : "";

  return (
    <div className={isDispatcher && depth === 0 ? "pb-1.5" : ""}>
      <div
        className={cn(
          "relative group rounded-lg transition-colors duration-150",
          isSelected
            ? "bg-card shadow-sm ring-1 ring-border/70"
            : "hover:bg-sidebar-accent/60"
        )}
      >
      <button
        type="button"
        onClick={() => onSelect(agent.id)}
        className={cn(
          "w-full text-left flex items-center gap-2.5 py-1.5 pl-2.5 transition-[padding-right]",
          // Reserve room for the inline delete button so the label
          // truncates earlier and never sits under the trash icon.
          isSelected && !isDispatcher ? "pr-9" : "pr-2.5"
        )}
      >
        <KindGlyph kind={agent.kind} />
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <div
            className={cn(
              "min-w-0 flex-1 text-[12.5px] tracking-tight truncate",
              isWorker ? "font-normal leading-snug" : "font-mono font-medium"
            )}
          >
            {/* Shimmer must live on an inner span — when applied to the
                same element as `truncate`, WebKit's text-overflow:ellipsis
                fights with background-clip:text and the gradient renders
                transparent. Workers especially: their long descriptions
                always truncate, so the shimmer was invisible. */}
            <span className={isStreaming ? "shimmer-text" : "text-foreground"}>
              {primaryLabel}
            </span>
          </div>
          {needsAttention && (
            <span
              title="needs your attention"
              className="shrink-0 w-1.5 h-1.5 rounded-full bg-[color:var(--clay)]"
            />
          )}
        </div>
      </button>
      {isSelected && !isDispatcher && (
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <InlineDeleteAgentButton agent={agent} />
        </div>
      )}
      </div>
      {kids.length > 0 && (
        <div className={cn(kidIndent, kidsTopGap, "relative")}>
          {kids.map((k) => (
            <AgentNode
              key={k.id}
              agent={k}
              tree={tree}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── detail ──────────────────────────────────────────────────────

function Detail({
  agent,
  messages,
  isPending,
  onSent,
  onInterrupted,
  panelOpen,
  onTogglePanel,
  artifactPanelOpen,
  onToggleArtifactPanel,
  schedulesPanelOpen,
  onToggleSchedulesPanel,
  sidebarOpen,
  onToggleSidebar,
}: {
  agent: Agent | null;
  messages: Message[];
  isPending: boolean;
  onSent: (id: string) => void;
  onInterrupted: (id: string) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  artifactPanelOpen: boolean;
  onToggleArtifactPanel: () => void;
  schedulesPanelOpen: boolean;
  onToggleSchedulesPanel: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  if (!agent) {
    return (
      <section className="relative flex flex-col h-full min-h-0">
        <TopNav
          agent={null}
          panelOpen={panelOpen}
          onTogglePanel={onTogglePanel}
          artifactPanelOpen={artifactPanelOpen}
          onToggleArtifactPanel={onToggleArtifactPanel}
          schedulesPanelOpen={schedulesPanelOpen}
          onToggleSchedulesPanel={onToggleSchedulesPanel}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={onToggleSidebar}
        />
        <div className="flex-1 flex items-center justify-center pt-16 text-muted-foreground text-sm italic">
          select one
        </div>
      </section>
    );
  }
  return (
    <section className="relative flex flex-col h-full min-h-0">
      <TopNav
        agent={agent}
        panelOpen={panelOpen}
        onTogglePanel={onTogglePanel}
        artifactPanelOpen={artifactPanelOpen}
        onToggleArtifactPanel={onToggleArtifactPanel}
        schedulesPanelOpen={schedulesPanelOpen}
        onToggleSchedulesPanel={onToggleSchedulesPanel}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
      />
      <MessageStream agent={agent} messages={messages} isPending={isPending} />
      <NotifyBox
        agentId={agent.id}
        onSent={onSent}
        onInterrupted={onInterrupted}
        agentBusy={agent.status === "streaming" || isPending}
        suggestions={
          agent.kind === "dispatcher"
            ? (() => {
                const fromTurns = latestDispatcherSuggestions(messages);
                if (fromTurns.length > 0) return fromTurns;
                // Default bubbles only when the chat is truly empty —
                // once the user has sent anything, leave the slot blank
                // until the dispatcher emits its own.
                const hasUser = messages.some(
                  (m) =>
                    m.role === "user" &&
                    (m.text || "").trim() &&
                    !isAgentRelay(m.text)
                );
                return hasUser ? [] : DEFAULT_DIRECTOR_SUGGESTIONS;
              })()
            : []
        }
      />
    </section>
  );
}

function TopNav({
  agent,
  panelOpen,
  onTogglePanel,
  artifactPanelOpen,
  onToggleArtifactPanel,
  schedulesPanelOpen,
  onToggleSchedulesPanel,
  sidebarOpen,
  onToggleSidebar,
}: {
  agent: Agent | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  artifactPanelOpen: boolean;
  onToggleArtifactPanel: () => void;
  schedulesPanelOpen: boolean;
  onToggleSchedulesPanel: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  const SettingsIcon = panelOpen ? PanelRightClose : PanelRight;
  const SidebarIcon = sidebarOpen ? PanelLeftClose : PanelLeft;
  return (
    <div className="@container absolute top-0 left-0 right-0 z-20 flex items-center justify-end gap-5 px-10 pt-8 pb-3 bg-background/[0.03] backdrop-blur-[2px]">
      <div className="flex items-center justify-end gap-5">
        {/* Workers inherit their orch's browser, schedules, plugins —
            none of those are user-actionable at the worker level. Keep
            the worker's top bar empty so it reads as a focused
            execution view. Health is system-wide and always shown. */}
        <DoctorButton />
        {agent && agent.kind !== "worker" && <BrowserButton agent={agent} />}
        {agent && agent.kind !== "worker" && (
          <ArtifactNavButton agent={agent} open={artifactPanelOpen} onToggle={onToggleArtifactPanel} />
        )}
        {agent && agent.kind !== "worker" && (
          <SchedulesNavButton agent={agent} open={schedulesPanelOpen} onToggle={onToggleSchedulesPanel} />
        )}
        {agent?.kind === "orchestrator" && (
          <button
            type="button"
            onClick={onTogglePanel}
            title={panelOpen ? "Hide skills panel" : "Show skills panel"}
            className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
          >
            <span className="hidden @lg:inline">Skills</span>
            <SettingsIcon className="w-3.5 h-3.5" strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  );
}

type BrowserState = {
  port?: number;
  profile?: string;
  alive: boolean;
  error?: string;
  loading: boolean;
};

// DoctorButton runs `roster doctor --json` and shows a small dropdown
// with the report. The icon goes amber if any check is non-OK, red if
// any check is failed. Click opens the dropdown; "Fix safe issues"
// re-runs with --fix and refreshes.
type DoctorCheck = { level: "ok" | "warn" | "fail"; title: string; detail?: string };
type DoctorReport = { failed: number; checks: DoctorCheck[] };

function DoctorButton() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (fix = false) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/doctor${fix ? "?fix=1" : ""}`);
      const d: DoctorReport = await r.json();
      setReport(d);
    } catch {
      setReport({ failed: 1, checks: [{ level: "fail", title: "doctor request failed" }] });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const tone = useMemo(() => {
    if (!report) return "text-muted-foreground";
    if (report.failed > 0) return "text-[var(--clay)]";
    if (report.checks.some((c) => c.level === "warn")) return "text-[var(--ochre)]";
    return "text-[var(--matcha)]";
  }, [report]);

  const tooltip = !report
    ? "Health: loading…"
    : report.failed > 0
      ? `${report.failed} failed check${report.failed === 1 ? "" : "s"}`
      : report.checks.some((c) => c.level === "warn")
        ? "Some warnings — click to see details"
        : "All checks passing";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={tooltip}
        className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
      >
        <span className="hidden @lg:inline">Health</span>
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.8} />
        ) : (
          <Activity className={`w-3.5 h-3.5 ${tone}`} strokeWidth={1.8} />
        )}
      </button>
      {open && report && (
        <div className="absolute right-0 top-full mt-2 w-[400px] max-h-[600px] overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md z-30">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-[11px] font-medium tracking-[0.22em] uppercase text-muted-foreground">
              roster doctor
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => refresh(true)}
                disabled={busy}
                className="text-[10px] tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Fix safe
              </button>
              <button
                type="button"
                onClick={() => refresh(false)}
                disabled={busy}
                className="text-[10px] tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                Refresh
              </button>
              <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <XIcon className="w-3 h-3" strokeWidth={1.8} />
              </button>
            </div>
          </div>
          <div className="p-2 space-y-1">
            {report.checks.map((c, i) => (
              <DoctorCheckRow key={i} check={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DoctorCheckRow({ check }: { check: DoctorCheck }) {
  const mark = check.level === "ok" ? "✓" : check.level === "warn" ? "⚠" : "✗";
  const tone =
    check.level === "ok"
      ? "text-[var(--matcha)]"
      : check.level === "warn"
        ? "text-[var(--ochre)]"
        : "text-[var(--clay)]";
  return (
    <div className="px-2 py-1.5 rounded-sm hover:bg-muted/40">
      <div className="flex items-start gap-2">
        <span className={`text-sm leading-none mt-0.5 ${tone}`}>{mark}</span>
        <span className="text-[12px] font-medium">{check.title}</span>
      </div>
      {check.detail && (
        <pre className="mt-1 ml-5 text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-snug">
          {check.detail}
        </pre>
      )}
    </div>
  );
}

function BrowserButton({ agent }: { agent: Agent }) {
  const [state, setState] = useState<BrowserState>({ alive: false, loading: false });
  const eligible = agent.kind === "orchestrator" || agent.kind === "worker";

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    fetch(`/api/agents/${agent.id}/browser`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setState((s) => ({ ...s, port: d.port, profile: d.profile, alive: !!d.alive }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent.id, eligible]);

  if (!eligible) return null;

  const onClick = async () => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const r = await fetch(`/api/agents/${agent.id}/browser`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState((s) => ({ ...s, loading: false, error: d.error || `HTTP ${r.status}` }));
        return;
      }
      setState({
        port: d.port,
        profile: d.profile,
        alive: !!d.alive,
        loading: false,
        error: d.error,
      });
    } catch (e: any) {
      setState((s) => ({ ...s, loading: false, error: String(e?.message || e) }));
    }
  };

  const title = state.error
    ? `Browser launch failed: ${state.error}`
    : state.alive
      ? `Chrome live on :${state.port}\nProfile: ${state.profile}`
      : state.port
        ? `Launch space Chrome (port ${state.port})`
        : "Launch space Chrome";

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={state.loading}
      className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors disabled:opacity-60"
    >
      <span className="hidden @lg:inline">Browser</span>
      {state.loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.8} />
      ) : (
        <Globe
          className={`w-3.5 h-3.5 ${state.alive ? "text-[var(--matcha)]" : ""}`}
          strokeWidth={1.8}
        />
      )}
    </button>
  );
}

// InlineDeleteAgentButton appears in the sidebar row of the currently-
// selected agent, on hover only. Two-step: first click arms (icon turns
// clay), second click commits. Auto-disarms after 4s. Click is captured
// (stopPropagation) so it doesn't re-trigger the row's select.
function InlineDeleteAgentButton({ agent }: { agent: Agent }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const cascadeNote =
    agent.kind === "orchestrator"
      ? "Delete this space and every worker under it?"
      : "Delete this worker?";

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/agents/${agent.id}/forget`, { method: "POST" });
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      title={armed ? cascadeNote : "Delete"}
      disabled={busy}
      className={cn(
        "flex items-center justify-center w-6 h-6 rounded-md transition-colors",
        armed
          ? "text-[color:var(--clay)] bg-[color:var(--clay-soft)]"
          : "text-muted-foreground hover:text-foreground hover:bg-sidebar-accent/80"
      )}
    >
      {busy ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.8} />
      ) : (
        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.8} />
      )}
    </button>
  );
}

// ─── messages ────────────────────────────────────────────────────

// How many recent turns to render initially. Each "Load earlier"
// click reveals another batch of the same size. Long sessions
// rehydrate ~hundreds of turns; rendering them all blew up scroll
// height and made the bubble layout sluggish.
const MESSAGE_PAGE_SIZE = 30;

function MessageStream({
  agent,
  messages,
  isPending,
}: {
  agent: Agent;
  messages: Message[];
  isPending: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(MESSAGE_PAGE_SIZE);

  // Only show the two conversation roles. Tool calls and their results
  // are hidden from the stream — when Claude is working, we surface a
  // shimmering verb pill instead. Thinking blocks are also filtered.
  const filtered = useMemo(
    () =>
      messages.filter(
        (m) => (m.role === "user" || m.role === "assistant") && !m.thinking
      ),
    [messages],
  );

  // Reset paging whenever the agent (and therefore the message stream)
  // changes — a new orch shouldn't inherit "I clicked load more 5
  // times" state from the previous one.
  useEffect(() => {
    setVisibleCount(MESSAGE_PAGE_SIZE);
  }, [agent.id]);

  // Auto-scroll to bottom only when a new message arrives at the tail
  // (i.e. the conversation grew). Don't fight the user when they
  // expand earlier history with "Load earlier".
  const lastLenRef = useRef(filtered.length);
  useEffect(() => {
    if (filtered.length > lastLenRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    lastLenRef.current = filtered.length;
  }, [filtered.length]);

  const isStreaming = agent.status === "streaming" || isPending;
  const sliceStart = Math.max(0, filtered.length - visibleCount);
  const visible = filtered.slice(sliceStart);
  const hidden = filtered.length - visible.length;

  return (
    <div className="scrollbar-calm flex-1 min-h-0 overflow-y-auto px-10 pt-20 pb-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-3">
          <KindGlyph kind={agent.kind} size={54} />
        </div>
        <h2 className="font-[family-name:var(--font-heading)] text-[56px] leading-[1.02] tracking-tight text-foreground mb-1">
          {titleFor(agent)}
        </h2>
        {agent.description && titleFor(agent) !== agent.description && (
          <p className="text-[14px] text-muted-foreground leading-relaxed max-w-xl mb-8">
            {agent.description}
          </p>
        )}
        {agent.description && titleFor(agent) === agent.description && (
          <div className="mb-8" />
        )}

        {filtered.length === 0 && !isStreaming ? (
          <div className="text-muted-foreground text-sm italic py-8">
            no messages yet — send one below
          </div>
        ) : (
          <div className="space-y-4">
            {hidden > 0 && (
              <div className="flex justify-center pt-2 pb-4">
                <button
                  type="button"
                  onClick={() =>
                    setVisibleCount((c) =>
                      Math.min(filtered.length, c + MESSAGE_PAGE_SIZE),
                    )
                  }
                  className="text-[11px] font-medium tracking-[0.22em] uppercase text-muted-foreground hover:text-foreground transition-colors"
                >
                  Load earlier · {hidden} hidden
                </button>
              </div>
            )}
            {visible.map((m, i) => (
              <MessageRow
                key={sliceStart + i}
                m={m}
                agentKind={agent.kind}
              />
            ))}
            {isStreaming && <ThinkingRow agent={agent} />}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ThinkingRow({ agent }: { agent: Agent }) {
  const [verb] = useState(() => SPINNER_PHRASES[Math.floor(Math.random() * SPINNER_PHRASES.length)]);
  const [current, setCurrent] = useState(verb);

  // Rotate the verb every few seconds so it feels alive without being twitchy.
  useEffect(() => {
    const h = setInterval(() => {
      const next = SPINNER_PHRASES[Math.floor(Math.random() * SPINNER_PHRASES.length)];
      setCurrent(next);
    }, 3200);
    return () => clearInterval(h);
  }, []);

  return (
    <div className="px-5 py-3 text-[15px]">
      <span className="shimmer-text font-medium">{current}…</span>
    </div>
  );
}

function titleFor(a: Agent): string {
  // Use the description as the display title when it's a single short sentence;
  // otherwise fall back to the friendly display name so the serif headline reads cleanly.
  const d = (a.description || "").trim();
  if (d && d.length <= 48 && !/\n/.test(d)) return d;
  return displayName(a);
}

// displayName picks the friendliest label for UI surfaces:
//   1. The agent's stored display_name (preferred — set at spawn time
//      via `roster spawn --display-name "Host Reply"`).
//   2. For the dispatcher, hard-coded "director".
//   3. A humanized fallback derived from the id — strips legacy
//      "orch-" / "-orch" decoration, swaps dashes for spaces,
//      title-cases each word. Lets older agents that pre-date the
//      display_name field still read clean.
function displayName(a: Agent): string {
  const stored = (a.display_name || "").trim();
  if (stored) return stored;
  if (a.kind === "dispatcher") return "director";
  return humanizeId(a.id);
}

function humanizeId(id: string): string {
  // Strip the legacy "orch-" prefix or "-orch" suffix that the
  // dispatcher used to add before display_name existed.
  let s = id.replace(/^orch-/, "").replace(/-orch$/, "");
  // dash/underscore → space; collapse runs of whitespace.
  s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  // Title-case each word. Single-letter words and short ones (≤3 chars)
  // get fully uppercased so "fb"/"api"/"id" don't render as "Fb"/"Api".
  return s
    .split(" ")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// Anything past this many characters in a single message gets
// clipped with a "Show more" toggle. Markdown-rendering a 50KB+
// blob freezes the bubble layout — react-markdown traverses every
// node every paint. The clip happens at the source string level so
// react-markdown only ever sees the visible portion.
const MAX_MESSAGE_CHARS = 4000;

function ClippedMarkdown({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const overflow = text.length > MAX_MESSAGE_CHARS;
  // When clipping, cut at the last newline so we don't slice through
  // a sentence; falls back to a hard cut if no newline is near.
  const visible = useMemo(() => {
    if (!overflow || expanded) return text;
    const slice = text.slice(0, MAX_MESSAGE_CHARS);
    const lastNL = slice.lastIndexOf("\n");
    return lastNL > MAX_MESSAGE_CHARS - 400 ? slice.slice(0, lastNL) : slice;
  }, [text, overflow, expanded]);

  return (
    <>
      <Markdown tone="light">{visible}</Markdown>
      {overflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-[11px] tracking-[0.2em] uppercase text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded
            ? "Show less"
            : `Show more · ${(text.length - visible.length).toLocaleString()} chars`}
        </button>
      )}
    </>
  );
}

function MessageRow({ m, agentKind }: { m: Message; agentKind?: string }) {
  // Two sides: user on the right (our side), assistant/agent on the left.
  // Tool blocks render centered, inline, in a muted style.
  if (m.role === "user") {
    const sender = agentRelaySender(m.text);
    // The dispatcher is the user-facing surface; cross-agent chatter
    // is noise there. In every OTHER pane (orchestrator, worker) the
    // inbound relay IS the task, so render it with a small "from X"
    // caption to keep it visually distinct from raw user input.
    if (sender) {
      if (agentKind === "dispatcher") return null;
      const body = relayBody(m.text);
      if (!body.trim()) return null;
      return (
        <div className="flex flex-col items-end gap-1.5">
          <div className="max-w-[78%] rounded-[20px] rounded-br-md px-5 py-3 bg-secondary/70 text-foreground text-[15px] leading-relaxed break-words">
            <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-1.5">
              from {sender}
            </div>
            <ClippedMarkdown text={body} />
          </div>
        </div>
      );
    }
    const cleaned = cleanUserText(m.text || "");
    const { stripped, paths } = extractAttachments(cleaned);
    const hasText = stripped.trim().length > 0;
    return (
      <div className="flex flex-col items-end gap-1.5">
        {paths.length > 0 && (
          <div className="max-w-[78%] flex flex-wrap gap-1.5 justify-end">
            {paths.map((p, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 max-w-[260px] text-[12px] text-muted-foreground"
                title={p}
              >
                <Paperclip className="w-3 h-3 shrink-0" strokeWidth={1.8} />
                <span className="truncate">{attachmentDisplayName(p)}</span>
              </span>
            ))}
          </div>
        )}
        {hasText && (
          <div className="max-w-[78%] rounded-[20px] rounded-br-md px-5 py-3 bg-secondary text-foreground text-[15px] leading-relaxed break-words">
            <ClippedMarkdown text={stripped} />
          </div>
        )}
      </div>
    );
  }
  if (m.role === "assistant") {
    // Strip the dispatcher's <suggestions> block — it's rendered as
    // bubbles above the input, not inline in the chat.
    const visible = extractSuggestions(m.text).text;
    if (!visible.trim()) return null;
    // Left indent matches the input box's text start (NotifyBox textarea
    // px-5 inside the same max-w-3xl column) so the conversation reads
    // along a single column edge.
    return (
      <div className="max-w-[78%] pl-5 py-1 text-foreground text-[15px] leading-relaxed break-words">
        <ClippedMarkdown text={visible} />
      </div>
    );
  }
  return null;
}

// ─── markdown ────────────────────────────────────────────────────
//
// Subtle, in-bubble markdown rendering. Bold/italic just shift weight
// and slant; code gets a faint tint that reads against either bubble
// color; lists indent gently; links underline on hover. Single
// newlines stay as line breaks (remark-breaks) so plain-text replies
// render the same as before.

function Markdown({ children, tone }: { children: string; tone: "light" | "dark" }) {
  const styles = MARKDOWN_TONE[tone];
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={{
        p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{withIcons(children)}</p>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={`${styles.link} underline-offset-2 hover:underline`}
          >
            {children}
          </a>
        ),
        code: ({ className, children }) => {
          // react-markdown v9: fenced code blocks get a `language-*`
          // className from rehype; bare `<code>` (inline) does not.
          if (!className) {
            return (
              <code className={`${styles.codeInline} px-[0.35em] py-[0.05em] rounded font-mono text-[0.9em]`}>
                {children}
              </code>
            );
          }
          return <code className={`${className} font-mono text-[0.9em]`}>{children}</code>;
        },
        pre: ({ children }) => (
          <pre className={`${styles.codeBlock} my-2 px-3 py-2 rounded-md overflow-x-auto leading-snug`}>
            {children}
          </pre>
        ),
        ul: ({ children }) => <ul className="my-1 list-disc pl-5 space-y-0.5 marker:opacity-60">{children}</ul>,
        ol: ({ children }) => <ol className="my-1 list-decimal pl-5 space-y-0.5 marker:opacity-60">{children}</ol>,
        li: ({ children }) => <li className="pl-0.5">{withIcons(children)}</li>,
        h1: ({ children }) => <h3 className="font-[family-name:var(--font-heading)] text-[1.18em] tracking-tight mt-3 mb-1 first:mt-0">{withIcons(children)}</h3>,
        h2: ({ children }) => <h3 className="font-[family-name:var(--font-heading)] text-[1.12em] tracking-tight mt-3 mb-1 first:mt-0">{withIcons(children)}</h3>,
        h3: ({ children }) => <h3 className="text-[1.0em] font-semibold mt-2 mb-1 first:mt-0">{withIcons(children)}</h3>,
        h4: ({ children }) => <h4 className="text-[0.97em] font-semibold mt-2 mb-1 first:mt-0">{withIcons(children)}</h4>,
        blockquote: ({ children }) => (
          <blockquote className={`my-2 pl-3 ${styles.quoteBorder} italic opacity-90`}>{withIcons(children)}</blockquote>
        ),
        hr: () => <hr className={`my-3 ${styles.hrColor}`} />,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="text-[0.92em] border-collapse">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className={`px-2 py-1 text-left font-semibold ${styles.tableBorder}`}>{withIcons(children)}</th>,
        td: ({ children }) => <td className={`px-2 py-1 ${styles.tableBorder}`}>{withIcons(children)}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

// Inline icon swap for the most common emojis Claude sprinkles into
// chat — keeps the rest of the message untouched. Only walks through
// block-element children (p, li, td, blockquote, headings) so code
// blocks and `inline code` are never rewritten.
type IconComponent = React.ComponentType<{ className?: string; strokeWidth?: number }>;

const ICON_FOR_CHAR: Record<string, { Icon: IconComponent; tone: string }> = {
  // Slim marks for the line-art glyphs
  "✓": { Icon: Check as IconComponent, tone: "text-[var(--matcha)]" },
  "✗": { Icon: XIcon as IconComponent, tone: "" },
  "✘": { Icon: XIcon as IconComponent, tone: "" },
  // Square-framed variants for the emoji forms (colored-square in source)
  "✅": { Icon: SquareCheckBig as IconComponent, tone: "text-[var(--matcha)]" },
  "❌": { Icon: SquareX as IconComponent, tone: "" },
  "⚠": { Icon: TriangleAlert as IconComponent, tone: "" },
  "⚠️": { Icon: TriangleAlert as IconComponent, tone: "" },
};

function withIcons(node: React.ReactNode): React.ReactNode {
  if (typeof node === "string") return replaceEmojiInString(node);
  if (Array.isArray(node)) {
    return node.map((c, i) => <React.Fragment key={i}>{withIcons(c)}</React.Fragment>);
  }
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    if (props.children !== undefined) {
      return React.cloneElement(
        node as React.ReactElement<{ children?: React.ReactNode }>,
        undefined,
        withIcons(props.children),
      );
    }
  }
  return node;
}

function replaceEmojiInString(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };
  while (i < text.length) {
    // Two-char (⚠ + variation selector U+FE0F) takes precedence.
    const two = text.slice(i, i + 2);
    const matched = ICON_FOR_CHAR[two] ? two : ICON_FOR_CHAR[text[i]] ? text[i] : null;
    if (matched) {
      flush();
      const { Icon, tone } = ICON_FOR_CHAR[matched];
      out.push(
        <Icon
          key={`ic-${i}`}
          className={`inline-block w-[1em] h-[1em] align-text-bottom ${tone}`.trim()}
          strokeWidth={2}
        />,
      );
      i += matched.length;
      continue;
    }
    buf += text[i];
    i++;
  }
  flush();
  if (out.length === 0) return text;
  if (out.length === 1 && typeof out[0] === "string") return out[0];
  return <>{out}</>;
}

const MARKDOWN_TONE = {
  // light = the user-side bubble (linen secondary bg, dark text)
  light: {
    codeInline: "bg-black/8 text-foreground",
    codeBlock: "bg-black/8 text-foreground",
    link: "text-[var(--matcha)]",
    quoteBorder: "border-l-2 border-foreground/25",
    hrColor: "border-foreground/15",
    tableBorder: "border border-foreground/15",
  },
  // dark = the assistant-side bubble (foreground bg, light text)
  dark: {
    codeInline: "bg-white/12 text-background",
    codeBlock: "bg-white/12 text-background",
    link: "text-[var(--matcha-soft)]",
    quoteBorder: "border-l-2 border-background/30",
    hrColor: "border-background/20",
    tableBorder: "border border-background/20",
  },
} as const;

// Pull the trailing "attached:\n<path>\n<path>" block out of a user
// message so it can render as chips above the bubble. Path lines are
// expected to be absolute (start with /) — anything else is left in
// the text.
function extractAttachments(text: string): { stripped: string; paths: string[] } {
  const m = text.match(/(\n*)attached:\n((?:\/[^\n]+\n?)+)\s*$/);
  if (!m) return { stripped: text, paths: [] };
  const paths = m[2]
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("/"));
  if (paths.length === 0) return { stripped: text, paths: [] };
  const stripped = text.slice(0, m.index).replace(/\s+$/, "");
  return { stripped, paths };
}

// Strip the on-disk timestamp + random suffix that the upload handler
// prepends so the chip shows the original filename.
//   20260426-010619-ec1cdb1d-Screenshot 2026-04-24 at 8.46.15 PM.jpg
//   →                       Screenshot 2026-04-24 at 8.46.15 PM.jpg
function attachmentDisplayName(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash < 0 ? p : p.slice(slash + 1);
  const m = base.match(/^\d{8}-\d{6}-[a-f0-9]+-(.+)$/);
  return m ? m[1] : base;
}

function cleanUserText(text?: string): string {
  if (!text) return "";
  return text
    // Legacy: strip the "[from sender]\n\n" prefix roster used to
    // prepend (replaced by <from id="…"> wrapping; kept for old logs).
    .replace(/^\[from [^\]]+\]\n\n/, "")
    // Legacy reply-protocol footer.
    .replace(/\n*—\nTo respond,[\s\S]*$/m, "")
    .trim();
}

// isAgentRelay returns true when a "user" turn is actually a peer-to-
// peer notify from another roster agent. Modern: <from id="...">…</from>
// wrapping. Legacy: a "[from <id>]\n\n…" prefix from older roster
// versions.
function isAgentRelay(text?: string): boolean {
  return !!agentRelaySender(text);
}

const FROM_TAG_RE = /^<from\s+id="([^"]+)">([\s\S]*?)<\/from>\s*$/m;
const FROM_PREFIX_RE = /^\[from ([^\]]+)\]\n\n([\s\S]*)$/;

// agentRelaySender returns the sender id when text is an inter-agent
// relay, or null when it's plain user input.
function agentRelaySender(text?: string): string | null {
  if (!text) return null;
  const t = text.trim();
  const m = t.match(FROM_TAG_RE);
  if (m) return m[1];
  const m2 = t.match(FROM_PREFIX_RE);
  if (m2) return m2[1];
  return null;
}

// relayBody returns the inner content of a wrapped or prefixed relay,
// minus the reply-protocol footer roster appends. Empty string if the
// text isn't a relay.
function relayBody(text?: string): string {
  if (!text) return "";
  const t = text.trim();
  const m = t.match(FROM_TAG_RE);
  let inner = "";
  if (m) {
    inner = m[2];
  } else {
    const m2 = t.match(FROM_PREFIX_RE);
    if (m2) inner = m2[2];
    else return "";
  }
  return inner
    .replace(/\n*—?\n?To respond,[\s\S]*$/m, "")
    .trim();
}

// extractSuggestions pulls a `<suggestions>...</suggestions>` block out
// of an assistant turn. Returns the suggestion lines (one per line in
// the block, blanks dropped) and the text with that block stripped so
// it doesn't render in the chat. The dispatcher's prompt teaches it to
// emit this; orchestrators don't, so this is a no-op for them.
const SUGGESTIONS_RE = /<suggestions>([\s\S]*?)<\/suggestions>\s*$/i;
function extractSuggestions(raw?: string): { text: string; suggestions: string[] } {
  if (!raw) return { text: "", suggestions: [] };
  const m = raw.match(SUGGESTIONS_RE);
  if (!m) return { text: raw, suggestions: [] };
  const lines = m[1]
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  return { text: raw.replace(SUGGESTIONS_RE, "").trimEnd(), suggestions: lines };
}

// latestDispatcherSuggestions walks the message stream backwards and
// returns the suggestion list from the most recent assistant turn that
// emitted one. Returns [] if no turn yet had suggestions — the UI then
// falls back to its default bubbles.
function latestDispatcherSuggestions(messages: Message[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.text) continue;
    const { suggestions } = extractSuggestions(m.text);
    if (suggestions.length > 0) return suggestions;
  }
  return [];
}

// Default bubbles for the empty director chat. Wording is what the
// user would actually type — not labels and not directives at the
// system. The dispatcher overrides these the moment it replies.
const DEFAULT_DIRECTOR_SUGGESTIONS = [
  "i have an idea i want to explore",
  "interview me — i'm not sure what to build",
  "what's already running for me?",
];

// ─── notify ──────────────────────────────────────────────────────

type Attachment = {
  path: string;
  filename: string;
  size: number;
  media_type?: string;
};

function NotifyBox({
  agentId,
  onSent,
  onInterrupted,
  agentBusy,
  suggestions = [],
}: {
  agentId: string;
  onSent: (id: string) => void;
  onInterrupted: (id: string) => void;
  agentBusy: boolean;
  suggestions?: string[];
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize the textarea to fit its content, up to a hard cap.
  // Past the cap it scrolls; the scrollbar is hidden via CSS so we
  // don't get the chunky default rendering. We reset to "auto" first
  // so shrinking after a delete actually works (otherwise scrollHeight
  // is sticky at the previous max).
  useEffect(() => {
    const ta = textRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const max = 280; // ~12 lines at 15px/1.5 line-height
    ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  }, [text]);

  // Reset draft state when the user switches agents — the input is per
  // agent in spirit, and a stale draft on the wrong agent invites
  // accidental sends.
  useEffect(() => {
    setText("");
    setAttachments([]);
    setSendError(null);
  }, [agentId]);

  const interrupt = useCallback(async () => {
    setInterrupting(true);
    try {
      await fetch(`/api/agents/${agentId}/interrupt`, { method: "POST" });
      // Clear App-level pending flag so the send button comes back
      // immediately. The fleet poll will catch the orch's status flip
      // back to "ready" within ~POLL_MS.
      onInterrupted(agentId);
    } finally {
      setInterrupting(false);
    }
  }, [agentId, onInterrupted]);

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;
      setUploading((n) => n + arr.length);
      await Promise.all(
        arr.map(async (f) => {
          const fd = new FormData();
          fd.append("file", f);
          try {
            const r = await fetch(`/api/agents/${agentId}/upload`, {
              method: "POST",
              body: fd,
            });
            if (r.ok) {
              const a: Attachment = await r.json();
              setAttachments((cur) => [...cur, a]);
            }
          } finally {
            setUploading((n) => n - 1);
          }
        }),
      );
    },
    [agentId],
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((arr) => arr.filter((_, i) => i !== idx));
  }, []);

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body && attachments.length === 0) return;
    // Avoid leading whitespace on attachment lines: Claude Code's TUI
    // treats `\n` followed by whitespace (or a `-`) as a paste-end
    // heuristic during bracketed paste and drops everything after.
    // Bare paths on their own lines pass through cleanly; the orch's
    // Read tool handles each path the same way.
    const message =
      attachments.length === 0
        ? body
        : `${body}${body ? "\n\n" : ""}attached:\n${attachments.map((a) => a.path).join("\n")}`;
    // Optimistic clear: drop the draft + attachments immediately so the
    // input is ready for the next message. On failure we restore the
    // text, surface the reason inline, and keep attachments cleared
    // (re-attaching is cheaper than guessing whether the server kept them).
    const draftText = text;
    setText("");
    setAttachments([]);
    setSendError(null);
    setSending(true);
    onSent(agentId);
    try {
      const r = await fetch(`/api/agents/${agentId}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, from: "ui" }),
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        setText(draftText);
        setSendError(detail.trim() || `send failed (${r.status})`);
      }
    } catch (e: any) {
      setText(draftText);
      setSendError(String(e?.message || e));
    } finally {
      setSending(false);
    }
  }, [agentId, text, attachments, onSent]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) upload(e.dataTransfer.files);
    },
    [upload],
  );

  const hasAttachments = attachments.length > 0;
  const hasText = text.trim().length > 0;
  const canSend = (hasText || hasAttachments) && !sending && uploading === 0;

  return (
    <div className="px-10 pb-8 pt-4">
      <div className="max-w-3xl mx-auto">
        {suggestions.length > 0 && !text.trim() && (
          <div className="flex flex-wrap gap-2 mb-3">
            {suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setText(s);
                  textRef.current?.focus();
                }}
                className="text-[12px] px-3 py-1.5 rounded-full bg-card ring-1 ring-border/60 hover:ring-border hover:bg-secondary transition text-muted-foreground hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "relative rounded-2xl bg-card ring-1 shadow-sm transition-colors",
            dragOver ? "ring-[var(--matcha)] bg-[color-mix(in_oklch,var(--matcha)_8%,var(--card))]" : "ring-border/70"
          )}
        >
          {hasAttachments && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {attachments.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 max-w-[260px] text-[12px] px-2 py-1 rounded-full bg-secondary text-foreground"
                  title={a.path}
                >
                  <Paperclip className="w-3 h-3 shrink-0" strokeWidth={1.8} />
                  <span className="truncate">{a.filename}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${a.filename}`}
                  >
                    <XIcon className="w-3 h-3" strokeWidth={1.8} />
                  </button>
                </span>
              ))}
              {uploading > 0 && (
                <span className="inline-flex items-center gap-1.5 text-[12px] px-2 py-1 rounded-full bg-secondary text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
                  uploading {uploading}…
                </span>
              )}
            </div>
          )}
          <div className="flex items-end gap-2 pr-2 pb-2">
            <textarea
              ref={textRef}
              className="scrollbar-none flex-1 resize-none bg-transparent outline-none px-5 py-4 text-[15px] leading-relaxed min-h-[112px] placeholder:text-muted-foreground/70 caret-muted-foreground"
              placeholder={dragOver ? "Drop files to attach" : "What do you need?"}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onPaste={(e) => {
                if (e.clipboardData?.files?.length) {
                  e.preventDefault();
                  upload(e.clipboardData.files);
                }
              }}
              disabled={sending}
              rows={3}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              title="Attach files"
              className="flex items-center justify-center h-10 w-10 rounded-xl text-muted-foreground hover:text-foreground hover:bg-background transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Paperclip size={16} strokeWidth={1.8} />
            </button>
            {agentBusy && !sending ? (
              <button
                type="button"
                onClick={interrupt}
                disabled={interrupting}
                title="Stop the agent (sends Esc)"
                className="flex items-center justify-center h-10 w-10 rounded-xl bg-foreground text-background ring-1 ring-foreground hover:bg-foreground/85 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {interrupting ? (
                  <Loader2 className="animate-spin" size={16} strokeWidth={1.8} />
                ) : (
                  <Square size={12} strokeWidth={2.4} fill="currentColor" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                title="Send"
                className="flex items-center justify-center h-10 w-10 rounded-xl bg-background ring-1 ring-border/70 hover:ring-border transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sending || uploading > 0 ? (
                  <Loader2 className="text-muted-foreground animate-spin" size={16} strokeWidth={1.8} />
                ) : (
                  <ArrowUp className="text-foreground" size={18} strokeWidth={2.2} />
                )}
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        {sendError && (
          <div className="mt-2 text-[12px] text-[color:var(--clay)]">
            send failed: {sendError}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── thread panel ────────────────────────────────────────────────

type PanelRoute =
  | { kind: "home" }
  | { kind: "marketplaces" } // hub: all registered marketplaces
  | { kind: "marketplace"; marketplace: string } // a single marketplace
  | { kind: "marketplace-add" }
  | {
      kind: "plugin";
      pluginName: string;
      marketplace: string;
      origin: "home" | "marketplace";
    };

function ThreadPanel({
  agent,
  open,
}: {
  agent: Agent | null;
  open: boolean;
}) {
  const [data, setData] = useState<ClaudeDirView | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({});
  const [route, setRoute] = useState<PanelRoute>({ kind: "home" });

  // Reset to home whenever the selected agent changes.
  useEffect(() => {
    setRoute({ kind: "home" });
    setInstallErrors({});
  }, [agent?.id]);

  const openPlugin = useCallback(
    (pluginName: string, marketplace: string, origin: "home" | "marketplace") => {
      setRoute({ kind: "plugin", pluginName, marketplace, origin });
    },
    []
  );

  const load = useCallback(() => {
    if (!agent) return;
    fetch(`/api/agents/${agent.id}/claude`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ClaudeDirView | null) => setData(d))
      .catch(() => {});
  }, [agent?.id]);

  useEffect(() => {
    if (!open || !agent) {
      setData(null);
      return;
    }
    let stop = false;
    setLoading(true);
    load();
    setLoading(false);
    // Light refresh so newly-installed plugins appear within a few seconds.
    const h = setInterval(() => {
      if (!stop) load();
    }, 4000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [agent?.id, open, load]);

  const install = useCallback(
    async (pluginName: string, marketplace: string) => {
      if (!agent) return;
      const key = `${pluginName}@${marketplace}`;
      setInstalling((s) => new Set(s).add(key));
      setInstallErrors((e) => {
        if (!(key in e)) return e;
        const n = { ...e };
        delete n[key];
        return n;
      });
      try {
        const r = await fetch(`/api/agents/${agent.id}/plugins/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plugin: pluginName, marketplace, restart: true }),
        });
        if (!r.ok) {
          const msg = (await r.text()).trim() || `HTTP ${r.status}`;
          setInstallErrors((e) => ({ ...e, [key]: summarizeInstallError(msg) }));
        }
      } catch (err) {
        setInstallErrors((e) => ({ ...e, [key]: String(err) }));
      } finally {
        setInstalling((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [agent]
  );

  // mutateMarketplace: thin wrapper around POST /api/agents/:id/marketplaces.
  // Returns the trimmed body on failure so callers can surface it inline.
  const mutateMarketplace = useCallback(
    async (
      body: {
        action:
          | "add"
          | "remove"
          | "update"
          | "plugin-update"
          | "plugin-remove";
        source?: string;
        name?: string;
        plugin?: string;
        marketplace?: string;
        restart?: boolean;
      }
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!agent) return { ok: false, error: "no agent" };
      try {
        const r = await fetch(`/api/agents/${agent.id}/marketplaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const msg = (await r.text()).trim() || `HTTP ${r.status}`;
          return { ok: false, error: msg };
        }
        // Refetch immediately so UI reflects the change without
        // waiting for the 4s polling tick.
        load();
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
    [agent, load]
  );

  // Clear an install error when the poll shows the plugin landed after all.
  useEffect(() => {
    if (!data) return;
    const installed = new Set(
      (data.plugins ?? []).map((p) => `${p.name}@${p.marketplace}`)
    );
    setInstallErrors((e) => {
      let changed = false;
      const n = { ...e };
      for (const k of Object.keys(n)) {
        if (installed.has(k)) {
          delete n[k];
          changed = true;
        }
      }
      return changed ? n : e;
    });
  }, [data]);

  return (
    <aside
      className={cn(
        "shrink-0 border-l border-border/60 bg-sidebar h-full overflow-hidden transition-[width] duration-200 ease-in-out",
        open ? "w-[340px] xl:w-[380px]" : "w-0 border-l-0"
      )}
    >
      {open && (
        <div className="h-full flex flex-col">
          {route.kind === "home" && (
            <PanelHeader agent={agent} view={data} route={route} />
          )}
          <div className="scrollbar-calm flex-1 min-h-0 overflow-y-auto">
            {!agent && (
              <p className="px-8 py-6 text-sm italic text-muted-foreground">
                select an agent
              </p>
            )}
            {agent && loading && !data && (
              <p className="px-8 py-6 text-sm italic text-muted-foreground">
                scanning…
              </p>
            )}
            {agent && data && route.kind === "home" && (
              <HomeView
                view={data}
                onBrowse={(name) =>
                  setRoute(
                    name
                      ? { kind: "marketplace", marketplace: name }
                      : { kind: "marketplaces" }
                  )
                }
                onOpenPlugin={(name, mp) => openPlugin(name, mp, "home")}
              />
            )}
            {agent && data && route.kind === "marketplaces" && (
              <MarketplacesHub
                view={data}
                onOpen={(name) =>
                  setRoute({ kind: "marketplace", marketplace: name })
                }
                onAdd={() => setRoute({ kind: "marketplace-add" })}
                onUpdateAll={() =>
                  mutateMarketplace({ action: "update", restart: true })
                }
                onBack={() => setRoute({ kind: "home" })}
              />
            )}
            {agent && data && route.kind === "marketplace-add" && (
              <MarketplaceAddView
                onSubmit={async (source) => {
                  const res = await mutateMarketplace({
                    action: "add",
                    source,
                  });
                  if (res.ok) setRoute({ kind: "marketplaces" });
                  return res;
                }}
                onBack={() => setRoute({ kind: "marketplaces" })}
              />
            )}
            {agent && data && route.kind === "marketplace" && (
              <MarketplaceView
                view={data}
                marketplace={route.marketplace}
                installing={installing}
                errors={installErrors}
                onInstall={install}
                onOpenPlugin={(name, mp) => openPlugin(name, mp, "marketplace")}
                onUpdate={() =>
                  mutateMarketplace({
                    action: "update",
                    name: route.marketplace,
                    restart: true,
                  })
                }
                onRemove={async () => {
                  const res = await mutateMarketplace({
                    action: "remove",
                    name: route.marketplace,
                    restart: true,
                  });
                  if (res.ok) setRoute({ kind: "marketplaces" });
                  return res;
                }}
                onBack={() => setRoute({ kind: "marketplaces" })}
              />
            )}
            {agent && data && route.kind === "plugin" && (
              <PluginDetailView
                view={data}
                pluginName={route.pluginName}
                marketplace={route.marketplace}
                installing={installing.has(
                  `${route.pluginName}@${route.marketplace}`
                )}
                error={
                  installErrors[`${route.pluginName}@${route.marketplace}`]
                }
                onInstall={install}
                onUpdate={() =>
                  mutateMarketplace({
                    action: "plugin-update",
                    plugin: route.pluginName,
                    marketplace: route.marketplace,
                    restart: true,
                  })
                }
                onUninstall={() =>
                  mutateMarketplace({
                    action: "plugin-remove",
                    plugin: route.pluginName,
                    marketplace: route.marketplace,
                    restart: true,
                  })
                }
                onBack={() =>
                  setRoute(
                    route.origin === "marketplace"
                      ? { kind: "marketplace", marketplace: route.marketplace }
                      : { kind: "home" }
                  )
                }
                backLabel={
                  route.origin === "marketplace" ? route.marketplace : "Installed"
                }
              />
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function PanelHeader({
  agent,
  view,
  route,
}: {
  agent: Agent | null;
  view: ClaudeDirView | null;
  route: PanelRoute;
}) {
  const sourceLabel = !view
    ? ""
    : view.source === "own"
      ? "own .claude"
      : view.source === "inherited"
        ? `inherited · ${view.source_id}`
        : "global ~/.claude";
  let crumb = "Installed";
  if (route.kind === "marketplaces") crumb = "Marketplaces";
  else if (route.kind === "marketplace") crumb = `Marketplaces · ${route.marketplace}`;
  else if (route.kind === "marketplace-add") crumb = "Marketplaces · Add";
  else if (route.kind === "plugin")
    crumb = route.origin === "marketplace" ? `${route.marketplace} · Plugin` : "Plugin";
  return (
    <div className="px-8 pt-8 pb-5 border-b border-border/50">
      <div className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
        {crumb}
      </div>
      <div className="mt-1 font-[family-name:var(--font-heading)] text-[28px] leading-[1] tracking-tight text-foreground">
        Skills
      </div>
      {sourceLabel && (
        <div className="mt-2 text-[11px] text-muted-foreground font-mono truncate">
          {sourceLabel}
        </div>
      )}
    </div>
  );
}

function HomeView({
  view,
  onBrowse,
  onOpenPlugin,
}: {
  view: ClaudeDirView;
  onBrowse: (marketplace?: string) => void;
  onOpenPlugin: (plugin: string, marketplace: string) => void;
}) {
  const skills = view.skills ?? [];
  const agents = view.agents ?? [];
  const commands = view.commands ?? [];
  const plugins = view.plugins ?? [];
  const markets = view.marketplaces ?? [];
  const anythingInstalled =
    skills.length + agents.length + commands.length + plugins.length > 0 ||
    !!view.memory;
  return (
    <div className="px-8 py-6 space-y-9">
      {!anythingInstalled && markets.length === 0 && (
        <p className="text-sm italic text-muted-foreground">
          nothing installed yet
        </p>
      )}
      <Section icon={Store} label="Marketplaces" count={markets.length}>
        <div className="space-y-2">
          {markets.map((m) => (
            <MarketplaceTile
              key={m.name}
              marketplace={m}
              onClick={() => onBrowse(m.name)}
            />
          ))}
          <button
            type="button"
            onClick={() => onBrowse()}
            className="group w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl ring-1 ring-dashed ring-border/60 hover:ring-border hover:bg-card transition-colors text-left"
          >
            <div className="shrink-0 w-7 h-7 rounded-lg bg-secondary flex items-center justify-center">
              <Plus className="text-muted-foreground" size={13} strokeWidth={1.8} />
            </div>
            <div className="text-[12.5px] text-muted-foreground group-hover:text-foreground transition-colors">
              Manage marketplaces
            </div>
          </button>
        </div>
      </Section>
      {plugins.length > 0 && (
        <Section icon={Package} label="Plugins" count={plugins.length}>
          {plugins.map((p) => (
            <PluginRow
              key={`${p.name}@${p.marketplace}`}
              plugin={p}
              onOpen={() => onOpenPlugin(p.name, p.marketplace)}
            />
          ))}
        </Section>
      )}
      {skills.length > 0 && (
        <Section icon={Sparkles} label="Skills" count={skills.length}>
          {skills.map((s) => (
            <SkillRow key={s.name} skill={s} />
          ))}
        </Section>
      )}
      {agents.length > 0 && (
        <Section icon={Users} label="Agents" count={agents.length}>
          {agents.map((a) => (
            <NamedRow key={a.name} item={a} />
          ))}
        </Section>
      )}
      {commands.length > 0 && (
        <Section icon={TerminalSquare} label="Commands" count={commands.length}>
          {commands.map((c) => (
            <NamedRow key={c.name} item={c} />
          ))}
        </Section>
      )}
      {view.memory && (
        <Section icon={BookOpen} label="Memory">
          <div className="text-[13px] leading-relaxed text-foreground/90">
            {view.memory.preview ||
              <span className="italic text-muted-foreground">empty</span>}
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground font-mono tabular-nums">
            CLAUDE.md · {formatBytes(view.memory.bytes)}
          </div>
        </Section>
      )}
    </div>
  );
}

// MarketplacesHub lists every registered marketplace as a card. From
// here the user can drill into one, refresh all of them, or add a new
// one. Replaces the old "all plugins flat" view.
function MarketplacesHub({
  view,
  onOpen,
  onAdd,
  onUpdateAll,
  onBack,
}: {
  view: ClaudeDirView;
  onOpen: (marketplace: string) => void;
  onAdd: () => void;
  onUpdateAll: () => Promise<{ ok: boolean; error?: string }>;
  onBack: () => void;
}) {
  const markets = view.marketplaces ?? [];
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const refreshAll = async () => {
    setUpdating(true);
    setUpdateError(null);
    const res = await onUpdateAll();
    if (!res.ok) setUpdateError(res.error || "update failed");
    setUpdating(false);
  };

  return (
    <div className="px-8 pt-8 pb-6 space-y-6">
      <BackCrumb label="Installed" onClick={onBack} />
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground">
          <Store className="w-3 h-3" strokeWidth={1.8} />
          Marketplaces
        </div>
        <h3 className="font-[family-name:var(--font-heading)] text-[26px] leading-[1.05] tracking-tight text-foreground">
          {markets.length === 0
            ? "None yet"
            : `${markets.length} ${markets.length === 1 ? "marketplace" : "marketplaces"}`}
        </h3>
      </header>

      {markets.length === 0 && (
        <p className="text-[13px] text-muted-foreground italic">
          Add a marketplace to browse plugins.
        </p>
      )}

      <div className="space-y-2">
        {markets.map((m) => (
          <MarketplaceTile
            key={m.name}
            marketplace={m}
            onClick={() => onOpen(m.name)}
          />
        ))}
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-background ring-1 ring-border/70 hover:ring-border text-[10px] tracking-[0.22em] uppercase text-foreground transition"
        >
          <Plus className="w-3 h-3" strokeWidth={1.8} />
          Add
        </button>
        {markets.length > 0 && (
          <button
            type="button"
            onClick={refreshAll}
            disabled={updating}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-background ring-1 ring-border/70 hover:ring-border text-[10px] tracking-[0.22em] uppercase text-muted-foreground hover:text-foreground transition disabled:opacity-60"
          >
            {updating ? (
              <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
            ) : (
              <Sparkles className="w-3 h-3" strokeWidth={1.8} />
            )}
            Update all
          </button>
        )}
      </div>
      {updateError && (
        <p className="text-[11px] leading-snug text-[color:var(--clay)]/90">
          {updateError}
        </p>
      )}
    </div>
  );
}

// MarketplaceTile is a compact card used in both the Skills home view
// and the marketplaces hub. Click drills into the marketplace's
// plugin list.
function MarketplaceTile({
  marketplace,
  onClick,
}: {
  marketplace: Marketplace;
  onClick: () => void;
}) {
  const installed = marketplace.plugins.filter((p) => p.installed).length;
  const total = marketplace.plugins.length;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full flex items-center gap-3 px-3.5 py-3 rounded-xl bg-background ring-1 ring-border/60 hover:ring-border transition-colors text-left"
    >
      <div className="shrink-0 w-8 h-8 rounded-lg bg-[color:var(--matcha-soft)] flex items-center justify-center">
        <Store
          className="text-[color:var(--primary)]"
          size={14}
          strokeWidth={1.8}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-foreground truncate">
          {marketplace.name}
        </div>
        <div className="text-[11px] text-muted-foreground font-mono truncate">
          {total === 0
            ? "no plugins"
            : `${installed}/${total} installed`}
          {marketplace.source ? ` · ${marketplace.source}` : ""}
        </div>
      </div>
      <ChevronRight
        className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors"
        size={14}
        strokeWidth={1.8}
      />
    </button>
  );
}

// MarketplaceAddView is a small form that takes a source string
// (URL, GitHub slug, or local path) and POSTs `marketplace add`.
function MarketplaceAddView({
  onSubmit,
  onBack,
}: {
  onSubmit: (source: string) => Promise<{ ok: boolean; error?: string }>;
  onBack: () => void;
}) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source.trim() || busy) return;
    setBusy(true);
    setError(null);
    const res = await onSubmit(source.trim());
    if (!res.ok) {
      setError(res.error || "add failed");
      setBusy(false);
    }
  };

  return (
    <div className="px-8 pt-8 pb-6 space-y-6">
      <BackCrumb label="Marketplaces" onClick={onBack} />
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground">
          <Plus className="w-3 h-3" strokeWidth={1.8} />
          Add marketplace
        </div>
        <h3 className="font-[family-name:var(--font-heading)] text-[26px] leading-[1.05] tracking-tight text-foreground">
          New source
        </h3>
        <p className="text-[12.5px] text-muted-foreground leading-relaxed">
          A GitHub repo (<code className="font-mono">owner/repo</code>), a full URL, or a local
          path. Claude Code will clone it into this space's plugin
          directory.
        </p>
      </header>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="text"
          autoFocus
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="anthropics/claude-code-marketplace"
          className="w-full h-9 px-3 rounded-md bg-background ring-1 ring-border/70 focus:ring-border outline-none text-[13px] font-mono caret-muted-foreground"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={!source.trim() || busy}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-background ring-1 ring-border/70 hover:ring-border text-[10px] tracking-[0.22em] uppercase text-foreground transition disabled:opacity-60"
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
          ) : (
            <Plus className="w-3 h-3" strokeWidth={1.8} />
          )}
          {busy ? "adding…" : "Add marketplace"}
        </button>
      </form>
      {error && (
        <p className="text-[11px] leading-snug text-[color:var(--clay)]/90 whitespace-pre-wrap break-words">
          {error}
        </p>
      )}
    </div>
  );
}

// MarketplaceView shows a single marketplace's plugin list with
// per-marketplace actions (Update / Remove). Drilled into from the
// hub or from the Skills home tile.
function MarketplaceView({
  view,
  marketplace,
  installing,
  errors,
  onInstall,
  onOpenPlugin,
  onUpdate,
  onRemove,
  onBack,
}: {
  view: ClaudeDirView;
  marketplace: string;
  installing: Set<string>;
  errors: Record<string, string>;
  onInstall: (plugin: string, marketplace: string) => void;
  onOpenPlugin: (plugin: string, marketplace: string) => void;
  onUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onRemove: () => Promise<{ ok: boolean; error?: string }>;
  onBack: () => void;
}) {
  const m = (view.marketplaces ?? []).find((x) => x.name === marketplace);
  const [updating, setUpdating] = useState(false);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  if (!m) {
    return (
      <div className="px-8 pt-8 pb-6 space-y-6">
        <BackCrumb label="Marketplaces" onClick={onBack} />
        <p className="text-sm italic text-muted-foreground">
          marketplace not found — it may have just been removed.
        </p>
      </div>
    );
  }

  const refresh = async () => {
    setUpdating(true);
    setActionError(null);
    const res = await onUpdate();
    if (!res.ok) setActionError(res.error || "update failed");
    setUpdating(false);
  };

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setRemoving(true);
    setActionError(null);
    const res = await onRemove();
    if (!res.ok) {
      setActionError(res.error || "remove failed");
      setRemoving(false);
      setArmed(false);
    }
  };

  return (
    <div className="px-8 pt-8 pb-6 space-y-6">
      <BackCrumb label="Marketplaces" onClick={onBack} />
      <header className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground">
          <Store className="w-3 h-3" strokeWidth={1.8} />
          Marketplace
        </div>
        <h3 className="font-[family-name:var(--font-heading)] text-[26px] leading-[1.05] tracking-tight text-foreground">
          {m.name}
        </h3>
        {m.source && (
          <div className="text-[11px] text-muted-foreground font-mono truncate">
            {m.source}
          </div>
        )}
      </header>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={refresh}
          disabled={updating || removing}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-background ring-1 ring-border/70 hover:ring-border text-[10px] tracking-[0.22em] uppercase text-foreground transition disabled:opacity-60"
        >
          {updating ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
          ) : (
            <Sparkles className="w-3 h-3" strokeWidth={1.8} />
          )}
          Update
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={updating || removing}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-md ring-1 transition text-[10px] tracking-[0.22em] uppercase disabled:opacity-60",
            armed
              ? "ring-[color:var(--clay)]/60 text-[color:var(--clay)] bg-[color:var(--clay-soft)]/40"
              : "ring-border/70 text-muted-foreground hover:text-foreground hover:ring-border bg-background"
          )}
        >
          {removing ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
          ) : (
            <Trash2 className="w-3 h-3" strokeWidth={1.8} />
          )}
          {armed ? "Confirm" : "Remove"}
        </button>
      </div>
      {actionError && (
        <p className="text-[11px] leading-snug text-[color:var(--clay)]/90 whitespace-pre-wrap break-words">
          {actionError}
        </p>
      )}

      <Section icon={Package} label="Plugins" count={m.plugins.length}>
        {m.plugins.length === 0 ? (
          <p className="text-[12.5px] italic text-muted-foreground">
            no plugins advertised
          </p>
        ) : (
          m.plugins.map((mp) => {
            const key = `${mp.name}@${m.name}`;
            return (
              <MarketRow
                key={mp.name}
                plugin={mp}
                marketplace={m.name}
                installing={installing.has(key)}
                error={errors[key]}
                onInstall={onInstall}
                onOpen={() => onOpenPlugin(mp.name, m.name)}
              />
            );
          })
        )}
      </Section>
    </div>
  );
}

function PluginDetailView({
  view,
  pluginName,
  marketplace,
  installing,
  error,
  onInstall,
  onUpdate,
  onUninstall,
  onBack,
  backLabel,
}: {
  view: ClaudeDirView;
  pluginName: string;
  marketplace: string;
  installing: boolean;
  error?: string;
  onInstall: (plugin: string, marketplace: string) => void;
  onUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onUninstall: () => Promise<{ ok: boolean; error?: string }>;
  onBack: () => void;
  backLabel: string;
}) {
  const installed = (view.plugins ?? []).find(
    (p) => p.name === pluginName && p.marketplace === marketplace
  );
  const market = (view.marketplaces ?? [])
    .find((m) => m.name === marketplace)
    ?.plugins.find((p) => p.name === pluginName);

  const title = pluginName;
  const description = installed?.description || market?.description;
  const author = installed?.author;
  const version = installed?.version;
  const category = market?.category;
  const isInstalled = !!installed;
  const enabled = installed?.enabled ?? false;

  return (
    <div className="px-8 pt-8 pb-6 space-y-6">
      <BackCrumb label={backLabel} onClick={onBack} />

      <header className="space-y-2">
        <div className="flex items-center gap-2 text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground">
          <Package className="w-3 h-3" strokeWidth={1.8} />
          Plugin
        </div>
        <h3 className="font-[family-name:var(--font-heading)] text-[26px] leading-[1.05] tracking-tight text-foreground">
          {title}
        </h3>
        <div className="text-[11px] text-muted-foreground font-mono truncate">
          {[marketplace, version ? `v${version}` : null, author ? `by ${author}` : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {category && (
          <div className="text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
            {category}
          </div>
        )}
      </header>

      <PluginActions
        isInstalled={isInstalled}
        enabled={enabled}
        installing={installing}
        installError={error}
        onInstall={() => onInstall(pluginName, marketplace)}
        onUpdate={onUpdate}
        onUninstall={onUninstall}
      />

      {description && (
        <section>
          <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-2">
            About
          </div>
          <p className="text-[13px] leading-relaxed text-foreground/90">
            {description}
          </p>
        </section>
      )}

      <PluginSetupSection
        isInstalled={isInstalled}
        installed={installed}
        agentId={view.source === "global" ? "" : view.source_id || ""}
        pluginName={pluginName}
        marketplace={marketplace}
      />
    </div>
  );
}

// PluginActions: Install (when not installed) or Update + Uninstall
// (when installed). Two-step uninstall — first click arms, second
// commits — matching the sidebar delete pattern.
function PluginActions({
  isInstalled,
  enabled,
  installing,
  installError,
  onInstall,
  onUpdate,
  onUninstall,
}: {
  isInstalled: boolean;
  enabled: boolean;
  installing: boolean;
  installError?: string;
  onInstall: () => void;
  onUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onUninstall: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [updating, setUpdating] = useState(false);
  const [armed, setArmed] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  const update = async () => {
    setUpdating(true);
    setActionError(null);
    const res = await onUpdate();
    if (!res.ok) setActionError(res.error || "update failed");
    setUpdating(false);
  };

  const uninstall = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setRemoving(true);
    setActionError(null);
    const res = await onUninstall();
    if (!res.ok) {
      setActionError(res.error || "uninstall failed");
      setRemoving(false);
      setArmed(false);
    }
  };

  if (!isInstalled) {
    return (
      <>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={installing}
            onClick={onInstall}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-background ring-1 transition text-[10px] tracking-[0.22em] uppercase disabled:opacity-40",
              installError
                ? "ring-[color:var(--clay)]/40 text-[color:var(--clay)] hover:ring-[color:var(--clay)]/70"
                : "ring-border/70 text-foreground hover:ring-border"
            )}
          >
            {installing ? "installing…" : installError ? "Retry install" : (
              <>
                <Plus className="w-3 h-3" strokeWidth={1.8} />
                Install
              </>
            )}
          </button>
        </div>
        {installError && (
          <p className="text-[11px] leading-snug text-[color:var(--clay)]/90">
            {installError}
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[10px] tracking-[0.22em] uppercase ring-1",
            enabled
              ? "ring-[color:var(--matcha-soft)] text-[color:var(--primary)] bg-[color:var(--matcha-soft)]/50"
              : "ring-border/70 text-muted-foreground"
          )}
        >
          {enabled ? "installed · enabled" : "installed · disabled"}
        </span>
        <button
          type="button"
          onClick={update}
          disabled={updating || removing}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-background ring-1 ring-border/70 hover:ring-border text-[10px] tracking-[0.22em] uppercase text-foreground transition disabled:opacity-60"
        >
          {updating ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
          ) : (
            <Sparkles className="w-3 h-3" strokeWidth={1.8} />
          )}
          Update
        </button>
        <button
          type="button"
          onClick={uninstall}
          disabled={updating || removing}
          className={cn(
            "inline-flex items-center gap-1.5 h-7 px-3 rounded-md ring-1 transition text-[10px] tracking-[0.22em] uppercase disabled:opacity-60",
            armed
              ? "ring-[color:var(--clay)]/60 text-[color:var(--clay)] bg-[color:var(--clay-soft)]/40"
              : "ring-border/70 text-muted-foreground hover:text-foreground hover:ring-border bg-background"
          )}
        >
          {removing ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
          ) : (
            <Trash2 className="w-3 h-3" strokeWidth={1.8} />
          )}
          {armed ? "Confirm" : "Uninstall"}
        </button>
      </div>
      {actionError && (
        <p className="text-[11px] leading-snug text-[color:var(--clay)]/90 whitespace-pre-wrap break-words">
          {actionError}
        </p>
      )}
    </>
  );
}

// PluginSetupSection rolls up everything a plugin can ship in its
// config.json: credentials (form fields), suggested schedules
// (one-click apply), and setup scripts (one-click run).
function PluginSetupSection({
  isInstalled,
  installed,
  agentId,
  pluginName,
  marketplace,
}: {
  isInstalled: boolean;
  installed: Plugin | undefined;
  agentId: string;
  pluginName: string;
  marketplace: string;
}) {
  if (!isInstalled) {
    return (
      <section>
        <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-2">
          Setup
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground italic">
          Install the plugin first to see any setup steps.
        </p>
      </section>
    );
  }

  const creds = installed?.credentials ?? [];
  const schedules = installed?.schedules ?? [];
  const scripts = installed?.setup_scripts ?? [];
  const nothing =
    creds.length === 0 && schedules.length === 0 && scripts.length === 0;

  return (
    <div className="space-y-7">
      {nothing && (
        <section>
          <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-2">
            Setup
          </div>
          <p className="text-[12px] leading-relaxed text-muted-foreground italic">
            No setup needed. The plugin loads on the next agent restart.
          </p>
        </section>
      )}

      {creds.length > 0 && (
        <section>
          <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-3">
            Credentials
          </div>
          <CredentialForm
            agentId={agentId}
            plugin={pluginName}
            marketplace={marketplace}
            credentials={creds}
          />
          <p className="mt-3 text-[11px] text-muted-foreground leading-relaxed">
            Saved values are exported as{" "}
            <code className="font-mono">$KEY</code> on the agent's tmux
            session, so plugin scripts can read them directly.
          </p>
        </section>
      )}

      {schedules.length > 0 && (
        <section>
          <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-3">
            Suggested schedules
          </div>
          <div className="space-y-2">
            {schedules.map((s) => (
              <SuggestedScheduleRow
                key={s.id}
                agentId={agentId}
                plugin={pluginName}
                marketplace={marketplace}
                schedule={s}
              />
            ))}
          </div>
        </section>
      )}

      {scripts.length > 0 && (
        <section>
          <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-3">
            Setup scripts
          </div>
          <div className="space-y-2">
            {scripts.map((s) => (
              <SetupScriptRow
                key={s.id}
                agentId={agentId}
                plugin={pluginName}
                marketplace={marketplace}
                script={s}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SuggestedScheduleRow({
  agentId,
  plugin,
  marketplace,
  schedule,
}: {
  agentId: string;
  plugin: string;
  marketplace: string;
  schedule: ScheduleSuggestion;
}) {
  const [applied, setApplied] = useState(!!schedule.applied);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick up server-side state when the parent re-fetches.
  useEffect(() => {
    setApplied(!!schedule.applied);
  }, [schedule.applied]);

  const apply = async () => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/agents/${agentId}/plugins/apply-schedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plugin,
          marketplace,
          schedule_id: schedule.id,
        }),
      });
      if (!r.ok) {
        setError((await r.text()).trim() || `apply failed (${r.status})`);
      } else {
        setApplied(true);
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg bg-card ring-1 ring-border/60 px-3.5 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-foreground">
            {schedule.label || schedule.id}
          </div>
          {schedule.description && (
            <div className="mt-1 text-[11.5px] text-muted-foreground leading-relaxed">
              {schedule.description}
            </div>
          )}
          <div className="mt-1 text-[11px] text-muted-foreground font-mono">
            {schedule.cron}
          </div>
        </div>
        <button
          type="button"
          onClick={apply}
          disabled={applied || busy}
          className={cn(
            "shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md ring-1 transition text-[10px] tracking-[0.22em] uppercase disabled:opacity-60",
            applied
              ? "ring-[color:var(--matcha-soft)] text-[color:var(--primary)] bg-[color:var(--matcha-soft)]/50"
              : "ring-border/70 text-foreground hover:ring-border bg-background"
          )}
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
          ) : applied ? (
            <Check className="w-3 h-3" strokeWidth={2} />
          ) : (
            <Plus className="w-3 h-3" strokeWidth={1.8} />
          )}
          {applied ? "Added" : "Add"}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-[11px] text-[color:var(--clay)]/90 break-words">
          {error}
        </p>
      )}
    </div>
  );
}

function SetupScriptRow({
  agentId,
  plugin,
  marketplace,
  script,
}: {
  agentId: string;
  plugin: string;
  marketplace: string;
  script: SetupScript;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(
    null
  );

  const run = async () => {
    if (!agentId) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agents/${agentId}/plugins/run-script`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plugin,
          marketplace,
          script_id: script.id,
        }),
      });
      const d = await r.json().catch(() => ({}));
      setResult({
        ok: r.ok && d.status === "ran",
        output: d.output || d.error || (await r.text().catch(() => "")) || "",
      });
    } catch (e: any) {
      setResult({ ok: false, output: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg bg-card ring-1 ring-border/60 px-3.5 py-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-foreground">
            {script.label || script.id}
          </div>
          {script.description && (
            <div className="mt-1 text-[11.5px] text-muted-foreground leading-relaxed">
              {script.description}
            </div>
          )}
          <pre className="mt-2 text-[11px] font-mono text-muted-foreground bg-secondary/40 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">
            {script.command}
          </pre>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className={cn(
            "shrink-0 inline-flex items-center gap-1.5 h-7 px-3 rounded-md ring-1 transition text-[10px] tracking-[0.22em] uppercase disabled:opacity-60",
            result?.ok
              ? "ring-[color:var(--matcha-soft)] text-[color:var(--primary)] bg-[color:var(--matcha-soft)]/50"
              : "ring-border/70 text-foreground hover:ring-border bg-background"
          )}
        >
          {busy ? (
            <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
          ) : result?.ok ? (
            <Check className="w-3 h-3" strokeWidth={2} />
          ) : (
            <TerminalSquare className="w-3 h-3" strokeWidth={1.8} />
          )}
          {result?.ok ? "Ran" : "Run"}
        </button>
      </div>
      {result && !result.ok && result.output && (
        <pre className="mt-2 text-[11px] text-[color:var(--clay)]/90 whitespace-pre-wrap break-words font-mono">
          {result.output}
        </pre>
      )}
      {result?.ok && result.output && (
        <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-words font-mono">
          {result.output}
        </pre>
      )}
    </div>
  );
}

// CredentialForm renders one field per declared credential. Values save
// on blur via POST /api/agents/:id/credentials → macOS Keychain.
// Existing values aren't pulled back (the keychain doesn't expose them
// here); the field only tracks saved/required state.
function CredentialForm({
  agentId,
  plugin,
  marketplace,
  credentials,
}: {
  agentId: string;
  plugin: string;
  marketplace: string;
  credentials: CredentialDecl[];
}) {
  return (
    <div className="space-y-4">
      {credentials.map((c) => (
        <CredentialField
          key={c.key}
          agentId={agentId}
          plugin={plugin}
          marketplace={marketplace}
          decl={c}
        />
      ))}
    </div>
  );
}

function CredentialField({
  agentId,
  plugin,
  marketplace,
  decl,
}: {
  agentId: string;
  plugin: string;
  marketplace: string;
  decl: CredentialDecl;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(decl.set);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!value.trim() || !agentId) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/agents/${agentId}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugin, marketplace, key: decl.key, value }),
      });
      if (!r.ok) {
        setError((await r.text()).trim() || `HTTP ${r.status}`);
      } else {
        setSaved(true);
        setValue("");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }, [agentId, plugin, marketplace, decl.key, value]);

  const clear = useCallback(async () => {
    if (!agentId) return;
    await fetch(`/api/agents/${agentId}/credentials`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin, marketplace, key: decl.key }),
    });
    setSaved(false);
    setValue("");
  }, [agentId, plugin, marketplace, decl.key]);

  const placeholder = saved ? "•••••• saved in Keychain — enter to replace" : "—";

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <label className="text-[12px] font-medium text-foreground">
          {decl.label || decl.key}
        </label>
        {decl.required && (
          <span className="text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
            required
          </span>
        )}
        {saved && (
          <span className="inline-flex items-center gap-1 text-[9px] tracking-[0.22em] uppercase text-[color:var(--primary)]">
            <Check className="w-2.5 h-2.5" strokeWidth={2.2} />
            saved
          </span>
        )}
      </div>
      {decl.description && (
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {decl.description}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 h-9 px-3 rounded-lg bg-background ring-1 ring-border/70 focus-within:ring-border">
          <KeyRound className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={1.8} />
          <input
            type={reveal ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder={placeholder}
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-foreground placeholder:text-muted-foreground/60 font-mono"
          />
          {value && (
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              title={reveal ? "Hide" : "Show"}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              {reveal ? (
                <EyeOff className="w-3.5 h-3.5" strokeWidth={1.8} />
              ) : (
                <Eye className="w-3.5 h-3.5" strokeWidth={1.8} />
              )}
            </button>
          )}
        </div>
        {saved && !value && (
          <button
            type="button"
            onClick={clear}
            title="Remove from Keychain"
            className="text-[10px] tracking-[0.18em] uppercase text-muted-foreground hover:text-[color:var(--clay)] transition-colors"
          >
            Clear
          </button>
        )}
      </div>
      {saving && (
        <p className="mt-1 text-[10px] italic text-muted-foreground">saving…</p>
      )}
      {error && (
        <p className="mt-1 text-[11px] text-[color:var(--clay)]/90">{error}</p>
      )}
    </div>
  );
}

function BackCrumb({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 -ml-0.5 text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.8} />
      {label}
    </button>
  );
}

function PluginRow({
  plugin,
  onOpen,
}: {
  plugin: Plugin;
  onOpen: () => void;
}) {
  return (
    <NavRow
      title={plugin.name}
      suffix={
        !plugin.enabled ? (
          <span className="text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
            disabled
          </span>
        ) : null
      }
      onClick={onOpen}
    />
  );
}

function MarketRow({
  plugin,
  marketplace,
  installing,
  error,
  onInstall,
  onOpen,
}: {
  plugin: MarketPlugin;
  marketplace: string;
  installing: boolean;
  error?: string;
  onInstall: (plugin: string, marketplace: string) => void;
  onOpen: () => void;
}) {
  const trailing = plugin.installed ? (
    <span className="shrink-0 text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
      installed
    </span>
  ) : (
    <button
      type="button"
      disabled={installing}
      onClick={(e) => {
        e.stopPropagation();
        onInstall(plugin.name, marketplace);
      }}
      title={installing ? "installing…" : error ? "Retry install" : `Install ${plugin.name}`}
      className={cn(
        "shrink-0 flex items-center gap-1 h-6 px-2 rounded-md bg-background ring-1 transition text-[10px] tracking-[0.18em] uppercase disabled:opacity-40",
        error
          ? "ring-[color:var(--clay)]/40 text-[color:var(--clay)] hover:ring-[color:var(--clay)]/70"
          : "ring-border/70 text-muted-foreground hover:text-foreground hover:ring-border"
      )}
    >
      {installing ? "…" : error ? "Retry" : (
        <>
          <Plus className="w-3 h-3" strokeWidth={1.8} />
          Install
        </>
      )}
    </button>
  );
  return (
    <NavRow
      title={plugin.name}
      meta={plugin.category}
      trailing={trailing}
      onClick={onOpen}
    />
  );
}

// NavRow is a clickable row that navigates elsewhere (vs ExpandableRow
// which toggles inline content). Trailing actions stopPropagation so
// they don't trigger the row's onClick.
function NavRow({
  title,
  suffix,
  meta,
  trailing,
  onClick,
}: {
  title: string;
  suffix?: React.ReactNode;
  meta?: string | null;
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="group cursor-pointer flex items-start gap-3 py-3"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-foreground truncate">
            {title}
          </span>
          {suffix}
        </div>
        {meta && (
          <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
            {meta}
          </div>
        )}
      </div>
      {trailing}
      <ChevronRight
        className="shrink-0 mt-1 text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity"
        size={13}
        strokeWidth={1.8}
      />
    </div>
  );
}

// ExpandableRow is the shared progressive-disclosure primitive: a title
// row (optional meta line below), a chevron that rotates on expand, and
// a body that appears on click. Trailing action (e.g. Install button)
// stays clickable without toggling the row.
function ExpandableRow({
  title,
  suffix,
  meta,
  trailing,
  expandable,
  children,
}: {
  title: string;
  suffix?: React.ReactNode;
  meta?: string | null;
  trailing?: React.ReactNode;
  expandable: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const interactive = expandable;
  return (
    <div>
      <div
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={() => interactive && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!interactive) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className={cn(
          "flex items-start gap-3 py-3",
          interactive && "cursor-pointer group"
        )}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-foreground truncate">
              {title}
            </span>
            {suffix}
          </div>
          {meta && (
            <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
              {meta}
            </div>
          )}
        </div>
        {trailing}
        {interactive && (
          <ChevronRight
            className={cn(
              "shrink-0 mt-1 text-muted-foreground/70 transition-[transform,opacity] duration-150",
              open
                ? "rotate-90 opacity-100"
                : "opacity-0 group-hover:opacity-100"
            )}
            size={13}
            strokeWidth={1.8}
          />
        )}
      </div>
      {open && children && (
        <div className="pb-3 pr-6">{children}</div>
      )}
    </div>
  );
}

// summarizeInstallError trims the noisiest bits off the claude CLI's error
// text so the inline message reads as a sentence, not a stack dump.
function summarizeInstallError(raw: string): string {
  const s = raw.replace(/^install:\s*/, "").replace(/^exit status \d+\s*—\s*/, "");
  // Claude prints the failure line after "✘ Failed to install plugin X:"
  const m = s.match(/Failed to install plugin[^:]*:\s*([\s\S]*)/);
  const body = m ? m[1] : s;
  // Keep just the first meaningful line, clip to something readable.
  const first = body.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? body;
  return first.length > 200 ? first.slice(0, 200) + "…" : first;
}

function Section({
  icon: Icon,
  label,
  count,
  children,
}: {
  icon: typeof Workflow;
  label: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <Icon
          className="text-muted-foreground"
          size={13}
          strokeWidth={1.8}
        />
        <span className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
          {label}
        </span>
        {typeof count === "number" && (
          <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
            · {count}
          </span>
        )}
      </div>
      <div className="divide-y divide-border/40">{children}</div>
    </section>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  return (
    <ExpandableRow
      title={skill.name}
      suffix={
        !skill.enabled ? (
          <span className="text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
            disabled
          </span>
        ) : null
      }
      expandable={!!skill.description}
    >
      {skill.description && (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {skill.description}
        </p>
      )}
    </ExpandableRow>
  );
}

function NamedRow({ item }: { item: NamedMD }) {
  return (
    <ExpandableRow title={item.name} expandable={!!item.description}>
      {item.description && (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {item.description}
        </p>
      )}
    </ExpandableRow>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ─── artifact panel ──────────────────────────────────────────────
//
// Each orchestrator can have artifacts: small Vite + React + Tailwind
// apps the orch scaffolds via `roster artifact create`. fleetview's
// backend lazily spawns the dev server; this panel shows the list +
// a live iframe pointing at that server. Vite's HMR keeps the iframe
// in sync automatically — no postMessage source-pushing needed.
//
// V2: a postMessage protocol (annotations on hover, error overlays,
// resize requests) — reserved here as a stub so the iframe loader
// stays compatible.

function ArtifactNavButton({
  agent,
  open,
  onToggle,
}: {
  agent: Agent;
  open: boolean;
  onToggle: () => void;
}) {
  const [hasAny, setHasAny] = useState(false);
  const eligible = agent.kind === "orchestrator" || agent.kind === "worker";

  useEffect(() => {
    if (!eligible) return;
    let cancelled = false;
    fetch(`/api/agents/${agent.id}/artifacts`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Artifact[]) => {
        if (!cancelled) setHasAny(Array.isArray(d) && d.length > 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent.id, eligible]);

  if (!eligible || !hasAny) return null;

  return (
    <button
      type="button"
      onClick={onToggle}
      title={open ? "Hide artifact panel" : "Show artifact panel"}
      className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
    >
      <span className="hidden @lg:inline">Artifact</span>
      <AppWindow className="w-3.5 h-3.5" strokeWidth={1.8} />
    </button>
  );
}

type Annotation = {
  text: string;
  source?: { fileName: string; lineNumber: number; columnNumber?: number };
  label?: string;
  html?: string;
  url?: string;
};

function ArtifactPanel({
  agent,
  open,
  onClose,
}: {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Artifact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [serving, setServing] = useState<Record<string, Artifact>>({});
  const [designOn, setDesignOn] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [sending, setSending] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Load list when opened or agent changes.
  const refresh = useCallback(() => {
    if (!agent) return;
    fetch(`/api/agents/${agent.id}/artifacts`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d: Artifact[]) => {
        const list = Array.isArray(d) ? d : [];
        setItems(list);
        setSelectedId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch(() => {});
  }, [agent?.id]);

  useEffect(() => {
    if (open && agent) refresh();
  }, [open, agent?.id, refresh]);

  // Reset selection when agent switches.
  useEffect(() => {
    setSelectedId(null);
    setServing({});
  }, [agent?.id]);

  // When the panel opens with a selection, kick the dev server and
  // poll until ready. The backend handles npm install + spawn idempotently.
  useEffect(() => {
    if (!open || !agent || !selectedId) return;
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      const r = await fetch(`/api/agents/${agent.id}/artifacts/${selectedId}/serve`, {
        method: "POST",
      }).catch(() => null);
      if (cancelled || !r) return;
      const d: Artifact = await r.json().catch(() => null as any);
      if (cancelled || !d) return;
      setServing((s) => ({ ...s, [selectedId]: d }));
      if (d.status !== "ready" && d.status !== "crashed") {
        timer = window.setTimeout(tick, 1500);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [open, agent?.id, selectedId]);

  // ── design mode + annotations ───────────────────────────────

  // Stable ref so the message handler reads the freshest queue
  // without re-binding the listener on every annotation change.
  const annotationsRef = useRef<Annotation[]>([]);
  useEffect(() => {
    annotationsRef.current = annotations;
  }, [annotations]);

  // Push design-mode toggle into the iframe whenever it changes,
  // and re-push when src/serving updates so a freshly-loaded iframe
  // catches up to the current toggle state.
  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: "fv:design", on: designOn },
      "*",
    );
  }, [designOn, selectedId, serving]);

  // Reset annotation queue + design mode when switching artifact / agent.
  useEffect(() => {
    setAnnotations([]);
    setDesignOn(false);
    setFullscreen(false);
  }, [agent?.id, selectedId]);

  // Esc bails out of fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const sendAll = useCallback(
    async (queue?: Annotation[]) => {
      const list = queue ?? annotationsRef.current;
      if (!agent || list.length === 0) return;
      const aid = selectedId ?? "(unknown)";
      const lines = list.map((a, i) => {
        const loc = a.source
          ? `${a.source.fileName.replace(/^.*\/artifacts\/[^/]+\//, "")}:${a.source.lineNumber}`
          : "(no source)";
        return `${i + 1}. ${loc} · ${a.label ?? ""}\n   → ${a.text}`;
      });
      const message = `[UI feedback — artifact ${aid}]\n\n${lines.join("\n\n")}`;
      setSending(true);
      try {
        await fetch(`/api/agents/${agent.id}/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, from: "ui" }),
        });
        setAnnotations([]);
      } finally {
        setSending(false);
      }
    },
    [agent, selectedId],
  );

  // Listen for annotations posted from the iframe.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "fv:annotation" && msg.payload) {
        setAnnotations((arr) => {
          const next = [...arr, msg.payload as Annotation];
          if (msg.sendNow) {
            // Defer one tick so React commits the new state first.
            window.setTimeout(() => sendAll(next), 0);
          }
          return next;
        });
      }
      if (msg.type === "fv:design-cancel") {
        setDesignOn(false);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendAll]);

  const removeAnnotation = useCallback((idx: number) => {
    setAnnotations((arr) => arr.filter((_, i) => i !== idx));
  }, []);

  const selected = items.find((a) => a.id === selectedId) ?? null;
  const live = selectedId ? serving[selectedId] ?? selected : null;
  const iframeSrc =
    live && (live.status === "ready" || live.alive)
      ? `http://127.0.0.1:${live.port}/`
      : null;

  return (
    <aside
      className={cn(
        "shrink-0 border-l border-border/60 bg-card h-full overflow-hidden transition-[width] duration-200 ease-in-out",
        // Fullscreen lifts the panel out of the flex row entirely:
        // fixed-positioned, z-elevated, full viewport. The flex slot
        // collapses to 0 so the chat column doesn't reflow under it.
        fullscreen
          ? "fixed inset-0 z-50 w-full max-w-none border-l-0"
          : open
            ? "w-[58%] max-w-[960px]"
            : "w-0 border-l-0"
      )}
    >
      {open && (
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between px-6 pt-7 pb-3">
            <DesignSwitch on={designOn} onToggle={() => setDesignOn((v) => !v)} />
            <div className="flex items-center gap-3">
              {iframeSrc && (
                <a
                  href={iframeSrc}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Open in new tab"
                >
                  <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.8} />
                </a>
              )}
              <button
                type="button"
                onClick={() => setFullscreen((v) => !v)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title={fullscreen ? "Exit fullscreen (Esc)" : "View fullscreen"}
              >
                {fullscreen ? (
                  <Minimize2 className="w-3.5 h-3.5" strokeWidth={1.8} />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.8} />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setFullscreen(false);
                  onClose();
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
                title="Close artifact panel"
              >
                <PanelRightClose className="w-3.5 h-3.5" strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {items.length > 1 && (
            <div className="px-6 pb-2 flex flex-wrap gap-1.5">
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setSelectedId(a.id)}
                  className={cn(
                    "text-[12px] px-2.5 py-1 rounded-full ring-1 transition-colors",
                    a.id === selectedId
                      ? "bg-foreground text-background ring-foreground"
                      : "ring-border/70 text-muted-foreground hover:text-foreground"
                  )}
                  title={a.path}
                >
                  {a.title || a.id}
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 min-h-0 px-6 pt-2 pb-2">
            <ArtifactFrame artifact={live} src={iframeSrc} iframeRef={iframeRef} />
          </div>

          {annotations.length > 0 && (
            <AnnotationTray
              annotations={annotations}
              sending={sending}
              onRemove={removeAnnotation}
              onSend={() => sendAll()}
              onClear={() => setAnnotations([])}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function DesignSwitch({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      title={on ? "Exit edit-design mode" : "Edit design — hover to highlight, click to comment"}
      className="group flex items-center gap-2.5"
    >
      <Pencil
        className={cn(
          "w-3.5 h-3.5 transition-colors",
          on ? "text-[var(--matcha)]" : "text-muted-foreground group-hover:text-foreground"
        )}
        strokeWidth={1.8}
      />
      <span
        className={cn(
          "text-[11px] font-medium tracking-[0.22em] uppercase transition-colors",
          on ? "text-foreground" : "text-muted-foreground group-hover:text-foreground"
        )}
      >
        Edit Design
      </span>
      <span
        className={cn(
          "relative inline-block h-[18px] w-8 rounded-full transition-colors ring-1",
          on
            ? "bg-[var(--matcha)] ring-[var(--matcha)]"
            : "bg-secondary ring-border/70 group-hover:ring-border"
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-background shadow-sm transition-[left] duration-150 ease-out",
            on ? "left-[16px]" : "left-[2px]"
          )}
        />
      </span>
    </button>
  );
}

function AnnotationTray({
  annotations,
  sending,
  onRemove,
  onSend,
  onClear,
}: {
  annotations: Annotation[];
  sending: boolean;
  onRemove: (idx: number) => void;
  onSend: () => void;
  onClear: () => void;
}) {
  return (
    <div className="px-6 pb-6 pt-1">
      <div className="rounded-2xl ring-1 ring-border/60 bg-background overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/50">
          <MousePointerClick className="w-3.5 h-3.5 text-[var(--matcha)]" strokeWidth={1.8} />
          <span className="text-[12px] font-medium text-foreground">
            {annotations.length} {annotations.length === 1 ? "comment" : "comments"}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground transition-colors"
          >
            Clear
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={onSend}
            className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.22em] uppercase px-3 py-1.5 rounded-full bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
            ) : (
              <Send className="w-3 h-3" strokeWidth={1.8} />
            )}
            <span>Send all</span>
          </button>
        </div>
        <ul className="max-h-40 overflow-y-auto scrollbar-calm">
          {annotations.map((a, i) => (
            <li
              key={i}
              className="flex items-start gap-3 px-4 py-2 hover:bg-secondary/40 group"
            >
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground pt-0.5">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-foreground truncate">{a.text}</div>
                {a.label && (
                  <div className="text-[11px] text-muted-foreground truncate">
                    {a.source
                      ? `${a.source.fileName.replace(/^.*\/artifacts\/[^/]+\//, "")}:${a.source.lineNumber} · ${a.label}`
                      : a.label}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemove(i)}
                title="Remove"
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
              >
                <XIcon className="w-3.5 h-3.5" strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ArtifactFrame({
  artifact,
  src,
  iframeRef,
}: {
  artifact: Artifact | null;
  src: string | null;
  iframeRef?: React.Ref<HTMLIFrameElement>;
}) {
  if (!artifact) {
    return (
      <div className="h-full flex items-center justify-center text-sm italic text-muted-foreground rounded-2xl ring-1 ring-border/60 bg-background">
        no artifact selected
      </div>
    );
  }
  if (!src) {
    const label =
      artifact.status === "installing"
        ? "Installing dependencies…"
        : artifact.status === "starting"
          ? "Starting Vite…"
          : artifact.status === "crashed"
            ? `Crashed${artifact.error ? `: ${artifact.error}` : ""}`
            : "Idle";
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground rounded-2xl ring-1 ring-border/60 bg-background">
        {artifact.status === "installing" || artifact.status === "starting" ? (
          <Loader2 className="w-5 h-5 animate-spin" strokeWidth={1.8} />
        ) : null}
        <span>{label}</span>
        {artifact.error && <span className="text-xs px-6 text-center">{artifact.error}</span>}
      </div>
    );
  }
  return (
    <iframe
      ref={iframeRef}
      title={`artifact:${artifact.id}`}
      src={src}
      className="w-full h-full rounded-2xl ring-1 ring-border/60 bg-background"
      allow="cross-origin-isolated"
    />
  );
}

// ─── schedules panel ─────────────────────────────────────────────
//
// CRUD UI for the orch's <CLAUDE_CONFIG_DIR>/scheduled_tasks.json.
// Claude Code reads that file natively and fires the prompts when
// the cron matches; this panel just lets the user inspect and
// curate the durable jobs through the dashboard. Frequency picker
// adapted from superbot3's SchedulesTab — covers minutes / hourly /
// daily / weekdays / weekly with a few common time slots.

function SchedulesNavButton({
  agent,
  open,
  onToggle,
}: {
  agent: Agent;
  open: boolean;
  onToggle: () => void;
}) {
  const eligible = agent.kind === "orchestrator" || agent.kind === "worker";
  if (!eligible) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={open ? "Hide schedules panel" : "Show schedules panel"}
      className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
    >
      <span className="hidden @lg:inline">Schedules</span>
      <CalendarClock className="w-3.5 h-3.5" strokeWidth={1.8} />
    </button>
  );
}

type Frequency = "minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "once";

type SchedulesRoute = { kind: "list" } | { kind: "create" } | { kind: "edit"; task: Schedule };

// Best-effort: turn an existing cron + recurring flag back into a
// ScheduleConfig the picker can show. Falls back to "raw" mode if
// the cron doesn't match a shape we generate (the user can still
// edit the prompt without losing the original cron).
function cronToConfig(cron: string, recurring: boolean): ScheduleConfig | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;

  // One-shot: M H D Mo *
  if (!recurring && /^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === "*") {
    const yyyy = new Date().getFullYear();
    const date = `${yyyy}-${String(+mon).padStart(2, "0")}-${String(+dom).padStart(2, "0")}`;
    const time = `${String(+hour).padStart(2, "0")}:${String(+min).padStart(2, "0")}`;
    return { ...DEFAULT_SCHEDULE, frequency: "once", onceDate: date, onceTime: time };
  }
  // */N * * * *
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULT_SCHEDULE, frequency: "minutes", everyMinutes: parseInt(everyMin[1], 10) };
  }
  // M * * * *
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULT_SCHEDULE, frequency: "hourly", times: [{ hour: 0, minute: parseInt(min, 10) }] };
  }
  if (!/^\d+$/.test(min) || !/^[\d,]+$/.test(hour)) return null;
  const m = parseInt(min, 10);
  const hours = hour.split(",").map((h) => parseInt(h, 10));
  const times = hours.map((h) => ({ hour: h, minute: m }));
  if (dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULT_SCHEDULE, frequency: "daily", times };
  }
  if (dom === "*" && mon === "*" && dow === "1-5") {
    return { ...DEFAULT_SCHEDULE, frequency: "weekdays", times };
  }
  if (dom === "*" && mon === "*" && /^\d$/.test(dow)) {
    return { ...DEFAULT_SCHEDULE, frequency: "weekly", times, weekday: dow };
  }
  return null;
}

const WEEKDAY_LABELS: { value: string; short: string }[] = [
  { value: "1", short: "Mon" },
  { value: "2", short: "Tue" },
  { value: "3", short: "Wed" },
  { value: "4", short: "Thu" },
  { value: "5", short: "Fri" },
  { value: "6", short: "Sat" },
  { value: "0", short: "Sun" },
];

const MINUTE_OPTIONS = [5, 10, 15, 20, 30];
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);

type TimeSlot = { hour: number; minute: number };

type ScheduleConfig = {
  frequency: Frequency;
  everyMinutes: number;
  // For daily / weekdays / weekly: one or more times of day (must
  // share the same minute — cron's minute field can't be a list when
  // the hour field is a list).
  times: TimeSlot[];
  weekday: string;
  // For "once": absolute local datetime (date + time).
  onceDate: string; // YYYY-MM-DD
  onceTime: string; // HH:MM (24h)
};

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  frequency: "daily",
  everyMinutes: 15,
  times: [{ hour: 9, minute: 0 }],
  weekday: "1",
  onceDate: todayLocal(),
  onceTime: "17:00",
};

function configToCron(c: ScheduleConfig): string {
  const sorted = [...c.times].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  const minute = sorted[0]?.minute ?? 0;
  const hours = sorted.map((t) => t.hour).join(",");
  switch (c.frequency) {
    case "minutes":
      return `*/${c.everyMinutes} * * * *`;
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hours} * * *`;
    case "weekdays":
      return `${minute} ${hours} * * 1-5`;
    case "weekly":
      return `${minute} ${hours} * * ${c.weekday}`;
    case "once": {
      const d = parseOnceDate(c.onceDate, c.onceTime);
      if (!d) return "";
      return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    }
  }
}

function parseOnceDate(date: string, time: string): Date | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;
  const [, y, mo, da] = m;
  const [, h, mi] = t;
  const d = new Date(+y, +mo - 1, +da, +h, +mi, 0, 0);
  if (isNaN(d.getTime())) return null;
  return d;
}

function SchedulesPanel({
  agent,
  open,
  onClose,
}: {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Schedule[]>([]);
  const [route, setRoute] = useState<SchedulesRoute>({ kind: "list" });

  const eligible = !!agent && (agent.kind === "orchestrator" || agent.kind === "worker");

  const refresh = useCallback(() => {
    if (!agent || !eligible) return;
    fetch(`/api/agents/${agent.id}/schedules`)
      .then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((d: { tasks: Schedule[] }) => setItems(d.tasks ?? []))
      .catch(() => {});
  }, [agent?.id, eligible]);

  useEffect(() => {
    if (open && agent) refresh();
  }, [open, agent?.id, refresh]);

  // Reset to list view + clear data when switching agents or closing.
  useEffect(() => {
    setRoute({ kind: "list" });
  }, [agent?.id]);
  useEffect(() => {
    if (!open) setRoute({ kind: "list" });
  }, [open]);

  const remove = useCallback(
    async (taskId: string) => {
      if (!agent) return;
      const r = await fetch(`/api/agents/${agent.id}/schedules/${taskId}`, {
        method: "DELETE",
      });
      if (r.ok) refresh();
    },
    [agent?.id, refresh],
  );

  const onCreated = useCallback(() => {
    refresh();
    setRoute({ kind: "list" });
  }, [refresh]);

  return (
    <aside
      className={cn(
        "shrink-0 border-l border-border/60 bg-sidebar h-full overflow-hidden transition-[width] duration-200 ease-in-out",
        open ? "w-[340px] xl:w-[380px]" : "w-0 border-l-0"
      )}
    >
      {open && (
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between px-6 pt-7 pb-3">
            <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
              {route.kind !== "list" ? (
                <button
                  type="button"
                  onClick={() => setRoute({ kind: "list" })}
                  className="flex items-center gap-2 hover:text-foreground transition-colors"
                  title="Back to schedules"
                >
                  <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.8} />
                  <span>{route.kind === "edit" ? "Edit schedule" : "New schedule"}</span>
                </button>
              ) : (
                <>
                  <CalendarClock className="w-3.5 h-3.5" strokeWidth={1.8} />
                  <span>Schedules</span>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Close schedules panel"
            >
              <PanelRightClose className="w-3.5 h-3.5" strokeWidth={1.8} />
            </button>
          </div>

          {!eligible && (
            <p className="text-sm italic text-muted-foreground px-6 py-6">
              Schedules are per-orchestrator. Select an orchestrator (or worker) to manage them.
            </p>
          )}

          {eligible && route.kind === "list" && (
            <SchedulesListView
              items={items}
              onRemove={remove}
              onAdd={() => setRoute({ kind: "create" })}
              onEdit={(task) => setRoute({ kind: "edit", task })}
            />
          )}

          {eligible && route.kind === "create" && agent && (
            <ScheduleFormView
              agent={agent}
              mode="create"
              onCancel={() => setRoute({ kind: "list" })}
              onSaved={onCreated}
            />
          )}

          {eligible && route.kind === "edit" && agent && (
            <ScheduleFormView
              agent={agent}
              mode="edit"
              task={route.task}
              onCancel={() => setRoute({ kind: "list" })}
              onSaved={onCreated}
            />
          )}
        </div>
      )}
    </aside>
  );
}

function SchedulesListView({
  items,
  onRemove,
  onAdd,
  onEdit,
}: {
  items: Schedule[];
  onRemove: (id: string) => void;
  onAdd: () => void;
  onEdit: (task: Schedule) => void;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-6 pb-3">
        <button
          type="button"
          onClick={onAdd}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] font-medium tracking-[0.22em] uppercase px-3 py-2 rounded-xl ring-1 ring-border/70 text-foreground hover:bg-secondary transition-colors"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={1.8} />
          <span>Add new schedule</span>
        </button>
      </div>

      <div className="scrollbar-calm flex-1 min-h-0 overflow-y-auto px-6 pb-6 space-y-2">
        {items.length === 0 ? (
          <p className="text-sm italic text-muted-foreground py-2">No schedules yet.</p>
        ) : (
          items.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onEdit(t)}
              className="group w-full text-left rounded-xl bg-background ring-1 ring-border/60 hover:ring-border p-3 flex items-start gap-3 transition-colors"
            >
              <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" strokeWidth={1.8} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-foreground">
                  {t.humanCron || t.cron}
                </div>
                <div className="text-[12px] text-muted-foreground mt-0.5 line-clamp-3">
                  {t.prompt}
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-[10px] tracking-wide text-muted-foreground/80 font-mono">
                  <span>{t.cron}</span>
                  {!t.recurring && <span>· once</span>}
                </div>
              </div>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(t.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemove(t.id);
                  }
                }}
                className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                title="Delete schedule"
              >
                <Trash2 className="w-3.5 h-3.5" strokeWidth={1.8} />
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ScheduleFormView({
  agent,
  mode,
  task,
  onCancel,
  onSaved,
}: {
  agent: Agent;
  mode: "create" | "edit";
  task?: Schedule;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [draftPrompt, setDraftPrompt] = useState(task?.prompt ?? "");
  const [draftCfg, setDraftCfg] = useState<ScheduleConfig>(() => {
    if (task) {
      return cronToConfig(task.cron, task.recurring) ?? DEFAULT_SCHEDULE;
    }
    return DEFAULT_SCHEDULE;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cron = configToCron(draftCfg);
  const validCron = cron.length > 0 && !cron.includes("NaN");

  const save = useCallback(async () => {
    const prompt = draftPrompt.trim();
    if (!prompt) {
      setError("Prompt is required.");
      return;
    }
    if (!validCron) {
      setError("Pick a valid time before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const recurring = draftCfg.frequency !== "once";
      let r: Response;
      if (mode === "edit" && task) {
        r = await fetch(`/api/agents/${agent.id}/schedules/${task.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cron, prompt, recurring }),
        });
      } else {
        r = await fetch(`/api/agents/${agent.id}/schedules`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cron, prompt, recurring }),
        });
      }
      if (!r.ok) {
        setError(await r.text());
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [agent.id, draftPrompt, draftCfg, cron, validCron, mode, task, onSaved]);

  return (
    <div className="scrollbar-calm flex-1 min-h-0 overflow-y-auto px-6 pb-6">
      <div className="space-y-4">
        <FrequencyPicker config={draftCfg} onChange={setDraftCfg} />

        <div>
          <label className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground block mb-1">
            Prompt
          </label>
          <textarea
            className="w-full resize-none bg-background ring-1 ring-border/70 focus:ring-foreground/40 outline-none rounded-lg px-3 py-2 text-[13px] leading-relaxed min-h-[96px]"
            placeholder="What should the orch do when this fires?"
            value={draftPrompt}
            onChange={(e) => setDraftPrompt(e.target.value)}
            rows={4}
          />
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-[11px] text-muted-foreground font-mono truncate">
            {validCron ? cron : "—"}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onCancel}
              className="text-[11px] font-medium tracking-[0.22em] uppercase px-3 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !draftPrompt.trim() || !validCron}
              onClick={save}
              className="flex items-center gap-1.5 text-[11px] font-medium tracking-[0.22em] uppercase px-3 py-1.5 rounded-full bg-foreground text-background hover:bg-foreground/85 transition-colors disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.8} />
              ) : mode === "edit" ? (
                <Check className="w-3 h-3" strokeWidth={1.8} />
              ) : (
                <Plus className="w-3 h-3" strokeWidth={1.8} />
              )}
              <span>{mode === "edit" ? "Save" : "Save"}</span>
            </button>
          </div>
        </div>

        {error && <div className="text-[11px] text-[var(--clay)]">{error}</div>}
      </div>
    </div>
  );
}

function FrequencyPicker({
  config,
  onChange,
}: {
  config: ScheduleConfig;
  onChange: (c: ScheduleConfig) => void;
}) {
  const supportsTimes =
    config.frequency === "daily" ||
    config.frequency === "weekdays" ||
    config.frequency === "weekly";
  const showWeekday = config.frequency === "weekly";
  const showEveryMin = config.frequency === "minutes";
  const showHourlyMinute = config.frequency === "hourly";
  const showOnce = config.frequency === "once";

  const sortedTimes = [...config.times].sort(
    (a, b) => a.hour - b.hour || a.minute - b.minute,
  );

  function updateTime(idx: number, patch: Partial<TimeSlot>) {
    const next = config.times.map((t, i) => (i === idx ? { ...t, ...patch } : t));
    // Force shared minute across all slots so the cron stays valid.
    if (patch.minute !== undefined) {
      const m = patch.minute;
      onChange({ ...config, times: next.map((t) => ({ ...t, minute: m })) });
    } else {
      onChange({ ...config, times: next });
    }
  }
  function addTime() {
    const last = sortedTimes[sortedTimes.length - 1];
    const nextHour = last ? Math.min(last.hour + 2, 23) : 9;
    const minute = config.times[0]?.minute ?? 0;
    onChange({ ...config, times: [...config.times, { hour: nextHour, minute }] });
  }
  function removeTime(idx: number) {
    if (config.times.length <= 1) return;
    onChange({ ...config, times: config.times.filter((_, i) => i !== idx) });
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground block mb-1.5">
          Frequency
        </label>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["once", "Once"],
              ["minutes", "Minutes"],
              ["hourly", "Hourly"],
              ["daily", "Daily"],
              ["weekdays", "Weekdays"],
              ["weekly", "Weekly"],
            ] as [Frequency, string][]
          ).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => onChange({ ...config, frequency: val })}
              className={cn(
                "text-[11px] tracking-[0.16em] uppercase px-2.5 py-1 rounded-full ring-1 transition-colors",
                config.frequency === val
                  ? "bg-foreground text-background ring-foreground"
                  : "ring-border/70 text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {showEveryMin && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground">Every</span>
          <select
            value={config.everyMinutes}
            onChange={(e) => onChange({ ...config, everyMinutes: parseInt(e.target.value, 10) })}
            className="bg-background ring-1 ring-border/70 rounded-md px-2 py-1 text-[12px]"
          >
            {MINUTE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className="text-[12px] text-muted-foreground">minutes</span>
        </div>
      )}

      {showHourlyMinute && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground">At</span>
          <select
            value={config.times[0]?.minute ?? 0}
            onChange={(e) =>
              onChange({
                ...config,
                times: config.times.map((t) => ({ ...t, minute: parseInt(e.target.value, 10) })),
              })
            }
            className="bg-background ring-1 ring-border/70 rounded-md px-2 py-1 text-[12px]"
          >
            {[0, 5, 10, 15, 20, 30, 45].map((m) => (
              <option key={m} value={m}>
                :{String(m).padStart(2, "0")}
              </option>
            ))}
          </select>
        </div>
      )}

      {supportsTimes && (
        <div>
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground">
              Times
            </span>
            <button
              type="button"
              onClick={addTime}
              className="text-[10px] tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground transition-colors"
            >
              + Add time
            </button>
          </div>
          <div className="space-y-1.5">
            {sortedTimes.map((t, i) => {
              const idx = config.times.indexOf(t);
              return (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={t.hour}
                    onChange={(e) =>
                      updateTime(idx, { hour: parseInt(e.target.value, 10) })
                    }
                    className="bg-background ring-1 ring-border/70 rounded-md px-2 py-1 text-[12px]"
                  >
                    {HOUR_OPTIONS.map((h) => (
                      <option key={h} value={h}>
                        {formatHourLabel(h)}
                      </option>
                    ))}
                  </select>
                  <select
                    value={t.minute}
                    onChange={(e) =>
                      updateTime(idx, { minute: parseInt(e.target.value, 10) })
                    }
                    className="bg-background ring-1 ring-border/70 rounded-md px-2 py-1 text-[12px]"
                  >
                    {[0, 15, 30, 45].map((m) => (
                      <option key={m} value={m}>
                        :{String(m).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                  {config.times.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeTime(idx)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      title="Remove time"
                    >
                      <XIcon className="w-3.5 h-3.5" strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {showWeekday && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground">On</span>
          <div className="flex gap-1">
            {WEEKDAY_LABELS.map((d) => (
              <button
                key={d.value}
                type="button"
                onClick={() => onChange({ ...config, weekday: d.value })}
                className={cn(
                  "text-[11px] px-2 py-1 rounded-md ring-1 transition-colors",
                  config.weekday === d.value
                    ? "bg-foreground text-background ring-foreground"
                    : "ring-border/70 text-muted-foreground hover:text-foreground"
                )}
              >
                {d.short}
              </button>
            ))}
          </div>
        </div>
      )}

      {showOnce && (
        <div>
          <label className="text-[11px] tracking-[0.18em] uppercase text-muted-foreground block mb-1.5">
            When (local time)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={config.onceDate}
              onChange={(e) => onChange({ ...config, onceDate: e.target.value })}
              min={todayLocal()}
              className="bg-background ring-1 ring-border/70 rounded-md px-2 py-1 text-[12px]"
            />
            <input
              type="time"
              value={config.onceTime}
              onChange={(e) => onChange({ ...config, onceTime: e.target.value })}
              className="bg-background ring-1 ring-border/70 rounded-md px-2 py-1 text-[12px]"
            />
          </div>
          <p className="text-[10.5px] text-muted-foreground mt-1.5 leading-snug">
            Auto-deletes after firing.
          </p>
        </div>
      )}
    </div>
  );
}

function formatHourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}
