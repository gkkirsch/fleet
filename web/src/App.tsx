import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronRight, Eye, EyeOff, Globe, KeyRound, Layers, Loader2, Package, Paperclip, PanelRight, PanelRightClose, Plus, Send, Sparkles, Store, TerminalSquare, Users, Workflow } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { cn } from "@/lib/utils";
import { SPINNER_PHRASES } from "./spinnerVerbs";
import type { Agent, ClaudeDirView, CredentialDecl, Marketplace, MarketPlugin, Message, NamedMD, Plugin, Skill } from "./types";

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
    toggle: useCallback(() => set(!open), [open, set]),
    close: useCallback(() => set(false), [set]),
  };
}

export function App() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const panel = useThreadPanel();
  // Map of agent id → timestamp of a just-sent message. Used to show the
  // thinking shimmer immediately, before backend polling catches up to the
  // agent entering "streaming" state. Cleared by the effect below.
  const [pendingSends, setPendingSends] = useState<Record<string, number>>({});
  const markPending = useCallback((id: string) => {
    setPendingSends((p) => ({ ...p, [id]: Date.now() }));
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

  return (
    <div className="h-screen flex bg-background text-foreground">
      <div className="w-[380px] shrink-0">
        <Sidebar
          agents={agents}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
      <div className="flex-1 min-w-0">
        <Detail
          agent={selected}
          messages={messages}
          isPending={isPending}
          onSent={markPending}
          panelOpen={panel.open}
          onTogglePanel={panel.toggle}
        />
      </div>
      <ThreadPanel
        agent={selected}
        open={panel.open}
      />
    </div>
  );
}

// ─── avatar ──────────────────────────────────────────────────────

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
      Icon: Workflow,
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
}: {
  agents: Agent[] | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const tree = useMemo(() => buildTree(agents ?? []), [agents]);
  return (
    <aside className="border-r border-border/60 bg-sidebar flex flex-col h-full min-h-0">
      <div className="px-8 pt-10 pb-6 flex items-baseline justify-between">
        <h1 className="font-[family-name:var(--font-heading)] text-[42px] leading-[0.95] tracking-tight text-foreground">
          Fleet
        </h1>
        {agents !== null && (
          <span className="text-xs tabular-nums text-muted-foreground font-mono">
            {agents.length}
          </span>
        )}
      </div>
      <div className="scrollbar-calm flex-1 min-h-0 overflow-y-auto px-4 pb-8 space-y-2">
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
    </aside>
  );
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
  const stateHint =
    agent.status === "streaming"
      ? "streaming"
      : agent.status === "trust-dialog" || agent.status === "permission-dialog"
      ? "waiting for you"
      : agent.status === "stopped" || agent.status === "not-found" || agent.status === "dead"
      ? "stopped"
      : null;

  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(agent.id)}
        className={cn(
          "w-full text-left flex items-start gap-3.5 px-3.5 py-3 rounded-xl transition-colors duration-150",
          isSelected
            ? "bg-card shadow-sm ring-1 ring-border/70"
            : "hover:bg-sidebar-accent/60"
        )}
      >
        <KindTile kind={agent.kind} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="font-mono text-[13px] font-medium tracking-tight text-foreground truncate">
            {agent.id}
          </div>
          {agent.description && (
            <div className="text-[12.5px] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
              {agent.description}
            </div>
          )}
          {stateHint && (
            <div
              className={cn(
                "text-[11px] mt-1.5 tracking-wide",
                agent.status === "streaming"
                  ? "text-[color:var(--ochre)] animate-soft-pulse"
                  : agent.status === "trust-dialog" || agent.status === "permission-dialog"
                  ? "text-[color:var(--clay)]"
                  : "text-muted-foreground"
              )}
            >
              {stateHint}
            </div>
          )}
        </div>
      </button>
      {kids.length > 0 && (
        <div className="ml-6 mt-1 space-y-1.5 relative">
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
  panelOpen,
  onTogglePanel,
}: {
  agent: Agent | null;
  messages: Message[];
  isPending: boolean;
  onSent: (id: string) => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  if (!agent) {
    return (
      <div className="flex items-center justify-center text-muted-foreground text-sm italic h-full">
        select one
      </div>
    );
  }
  return (
    <section className="flex flex-col h-full min-h-0">
      <TopNav agent={agent} panelOpen={panelOpen} onTogglePanel={onTogglePanel} />
      <MessageStream agent={agent} messages={messages} isPending={isPending} />
      <NotifyBox agentId={agent.id} onSent={onSent} />
    </section>
  );
}

function TopNav({
  agent,
  panelOpen,
  onTogglePanel,
}: {
  agent: Agent;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const Icon = panelOpen ? PanelRightClose : PanelRight;
  return (
    <div className="flex items-center justify-end gap-5 px-10 pt-8 pb-2">
      <BrowserButton agent={agent} />
      <button
        type="button"
        onClick={onTogglePanel}
        title={panelOpen ? "Hide settings panel" : "Show settings panel"}
        className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
      >
        <span>Settings</span>
        <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
      </button>
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
      <span>Browser</span>
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

// ─── messages ────────────────────────────────────────────────────

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
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // Only show the two conversation roles. Tool calls and their results
  // are hidden from the stream — when Claude is working, we surface a
  // shimmering verb pill instead. Thinking blocks are also filtered.
  const filtered = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && !m.thinking
  );
  const isStreaming = agent.status === "streaming" || isPending;

  return (
    <div className="scrollbar-calm flex-1 min-h-0 overflow-y-auto px-10 pt-4 pb-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-3">
          <KindTile kind={agent.kind} size={54} />
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
            {filtered.map((m, i) => (
              <MessageRow key={i} m={m} />
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
    <div className="flex items-center gap-3">
      <KindTile kind={agent.kind} size={34} />
      <div className="px-5 py-3 text-[15px]">
        <span className="shimmer-text font-medium">{current}…</span>
      </div>
    </div>
  );
}

function titleFor(a: Agent): string {
  // Use the description as the display title when it's a single short sentence;
  // otherwise fall back to the id so the serif headline reads cleanly.
  const d = (a.description || "").trim();
  if (d && d.length <= 48 && !/\n/.test(d)) return d;
  return a.id;
}

function MessageRow({ m }: { m: Message }) {
  // Two sides: user on the right (our side), assistant/agent on the left.
  // Tool blocks render centered, inline, in a muted style.
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-[20px] rounded-br-md px-5 py-3 bg-secondary text-foreground text-[15px] leading-relaxed break-words">
          <Markdown tone="light">{cleanUserText(m.text || "")}</Markdown>
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    // Left indent matches the input box's text start (NotifyBox textarea
    // px-5 inside the same max-w-3xl column) so the conversation reads
    // along a single column edge.
    return (
      <div className="max-w-[78%] pl-5 py-1 text-foreground text-[15px] leading-relaxed break-words">
        <Markdown tone="light">{m.text || ""}</Markdown>
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
        p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
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
        li: ({ children }) => <li className="pl-0.5">{children}</li>,
        h1: ({ children }) => <h3 className="text-[1.06em] font-semibold mt-3 mb-1 first:mt-0">{children}</h3>,
        h2: ({ children }) => <h3 className="text-[1.03em] font-semibold mt-3 mb-1 first:mt-0">{children}</h3>,
        h3: ({ children }) => <h3 className="text-[1.0em] font-semibold mt-2 mb-1 first:mt-0">{children}</h3>,
        h4: ({ children }) => <h4 className="text-[0.97em] font-semibold mt-2 mb-1 first:mt-0">{children}</h4>,
        blockquote: ({ children }) => (
          <blockquote className={`my-2 pl-3 ${styles.quoteBorder} italic opacity-90`}>{children}</blockquote>
        ),
        hr: () => <hr className={`my-3 ${styles.hrColor}`} />,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="text-[0.92em] border-collapse">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className={`px-2 py-1 text-left font-semibold ${styles.tableBorder}`}>{children}</th>,
        td: ({ children }) => <td className={`px-2 py-1 ${styles.tableBorder}`}>{children}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  );
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

function cleanUserText(text?: string): string {
  if (!text) return "";
  return text
    // Strip the "[from sender]\n\n" prefix roster prepends on delivery.
    .replace(/^\[from [^\]]+\]\n\n/, "")
    // Strip the "— \nTo respond, end your turn…" reply footer roster appends
    // when a registered agent sends the message.
    .replace(/\n*—\nTo respond,[\s\S]*$/m, "")
    .trim();
}

// ─── notify ──────────────────────────────────────────────────────

function NotifyBox({
  agentId,
  onSent,
}: {
  agentId: string;
  onSent: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    if (!text.trim()) return;
    setSending(true);
    // Optimistically kick off the shimmer the instant the user sends,
    // BEFORE the network round-trip. The App-level effect will clear
    // the flag once the backend reports streaming (or after 60s).
    onSent(agentId);
    try {
      const r = await fetch(`/api/agents/${agentId}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, from: "ui" }),
      });
      if (r.ok) setText("");
    } finally {
      setSending(false);
    }
  }, [agentId, text, onSent]);

  return (
    <div className="px-10 pb-8 pt-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 rounded-2xl bg-card ring-1 ring-border/70 shadow-sm pr-2">
          <textarea
            className="flex-1 resize-none bg-transparent outline-none px-5 py-3.5 text-[15px] leading-relaxed min-h-[56px] placeholder:text-muted-foreground/70"
            placeholder="Write here"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
            disabled={sending}
            rows={1}
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || !text.trim()}
            title="send"
            className="flex items-center justify-center h-10 w-10 rounded-xl bg-background ring-1 ring-border/70 hover:ring-border transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? (
              <span className="text-muted-foreground">…</span>
            ) : text.trim() ? (
              <Send className="text-foreground" size={16} strokeWidth={1.8} />
            ) : (
              <Paperclip className="text-muted-foreground" size={16} strokeWidth={1.8} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── thread panel ────────────────────────────────────────────────

type PanelRoute =
  | { kind: "home" }
  | { kind: "marketplace" }
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
                onBrowse={() => setRoute({ kind: "marketplace" })}
                onOpenPlugin={(name, mp) => openPlugin(name, mp, "home")}
              />
            )}
            {agent && data && route.kind === "marketplace" && (
              <MarketplaceView
                view={data}
                installing={installing}
                errors={installErrors}
                onInstall={install}
                onOpenPlugin={(name, mp) => openPlugin(name, mp, "marketplace")}
                onBack={() => setRoute({ kind: "home" })}
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
                onBack={() =>
                  setRoute({
                    kind: route.origin === "marketplace" ? "marketplace" : "home",
                  })
                }
                backLabel={route.origin === "marketplace" ? "Marketplace" : "Installed"}
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
  const crumb =
    route.kind === "home"
      ? "Installed"
      : route.kind === "marketplace"
        ? "Installed · Marketplace"
        : route.origin === "marketplace"
          ? "Marketplace · Plugin"
          : "Installed · Plugin";
  return (
    <div className="px-8 pt-8 pb-5 border-b border-border/50">
      <div className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
        {crumb}
      </div>
      <div className="mt-1 font-[family-name:var(--font-heading)] text-[28px] leading-[1] tracking-tight text-foreground">
        {agent?.id ?? "—"}
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
  onBrowse: () => void;
  onOpenPlugin: (plugin: string, marketplace: string) => void;
}) {
  const skills = view.skills ?? [];
  const agents = view.agents ?? [];
  const commands = view.commands ?? [];
  const plugins = view.plugins ?? [];
  const markets = view.marketplaces ?? [];
  const availableCount = markets.reduce(
    (acc, m) => acc + m.plugins.filter((p) => !p.installed).length,
    0
  );
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
      {markets.length > 0 && (
        <BrowseEntry
          totalAvailable={availableCount}
          totalPlugins={markets.reduce((acc, m) => acc + m.plugins.length, 0)}
          onClick={onBrowse}
        />
      )}
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

function MarketplaceView({
  view,
  installing,
  errors,
  onInstall,
  onOpenPlugin,
  onBack,
}: {
  view: ClaudeDirView;
  installing: Set<string>;
  errors: Record<string, string>;
  onInstall: (plugin: string, marketplace: string) => void;
  onOpenPlugin: (plugin: string, marketplace: string) => void;
  onBack: () => void;
}) {
  const markets = view.marketplaces ?? [];
  return (
    <div className="px-8 pt-8 pb-6 space-y-9">
      <BackCrumb label="Installed" onClick={onBack} />
      {markets.length === 0 && (
        <p className="text-sm italic text-muted-foreground">
          no marketplaces registered
        </p>
      )}
      {markets.map((m) => (
        <Section
          key={m.name}
          icon={Store}
          label={m.name}
          count={m.plugins.length}
        >
          {m.plugins.map((mp) => {
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
          })}
        </Section>
      ))}
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
  onBack,
  backLabel,
}: {
  view: ClaudeDirView;
  pluginName: string;
  marketplace: string;
  installing: boolean;
  error?: string;
  onInstall: (plugin: string, marketplace: string) => void;
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

      <div className="flex items-center gap-2">
        {isInstalled ? (
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
        ) : (
          <button
            type="button"
            disabled={installing}
            onClick={() => onInstall(pluginName, marketplace)}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-background ring-1 transition text-[10px] tracking-[0.22em] uppercase disabled:opacity-40",
              error
                ? "ring-[color:var(--clay)]/40 text-[color:var(--clay)] hover:ring-[color:var(--clay)]/70"
                : "ring-border/70 text-foreground hover:ring-border"
            )}
          >
            {installing ? "installing…" : error ? "Retry install" : (
              <>
                <Plus className="w-3 h-3" strokeWidth={1.8} />
                Install
              </>
            )}
          </button>
        )}
      </div>

      {error && (
        <p className="text-[11px] leading-snug text-[color:var(--clay)]/90">
          {error}
        </p>
      )}

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

      <section>
        <div className="text-[10px] font-medium tracking-[0.22em] uppercase text-muted-foreground mb-2">
          Setup
        </div>
        {!isInstalled && (
          <p className="text-[12px] leading-relaxed text-muted-foreground italic">
            Install the plugin first to see any setup steps.
          </p>
        )}
        {isInstalled && (!installed?.credentials || installed.credentials.length === 0) && (
          <p className="text-[12px] leading-relaxed text-muted-foreground italic">
            No credentials required. Claude Code will load this plugin on its next start.
          </p>
        )}
        {isInstalled && installed?.credentials && installed.credentials.length > 0 && (
          <CredentialForm
            agentId={view.source === "global" ? "" : view.source_id || ""}
            plugin={pluginName}
            marketplace={marketplace}
            credentials={installed.credentials}
          />
        )}
      </section>
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

function BrowseEntry({
  totalAvailable,
  totalPlugins,
  onClick,
}: {
  totalAvailable: number;
  totalPlugins: number;
  onClick: () => void;
}) {
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
        <div className="text-[13px] font-medium text-foreground">
          Marketplace
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {totalAvailable} available · {totalPlugins} total
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
