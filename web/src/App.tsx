import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Layers, Package, Paperclip, PanelRight, PanelRightClose, Plus, Send, Sparkles, Store, TerminalSquare, Users, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import { SPINNER_PHRASES } from "./spinnerVerbs";
import type { Agent, ClaudeDirView, Marketplace, MarketPlugin, Message, NamedMD, Plugin, Skill } from "./types";

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
          onBack={() => setSelectedId(null)}
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
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-8 space-y-2">
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
  onBack,
  panelOpen,
  onTogglePanel,
}: {
  agent: Agent | null;
  messages: Message[];
  isPending: boolean;
  onSent: (id: string) => void;
  onBack: () => void;
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
      <TopNav onBack={onBack} panelOpen={panelOpen} onTogglePanel={onTogglePanel} />
      <MessageStream agent={agent} messages={messages} isPending={isPending} />
      <NotifyBox agentId={agent.id} onSent={onSent} />
    </section>
  );
}

function TopNav({
  onBack,
  panelOpen,
  onTogglePanel,
}: {
  onBack: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const Icon = panelOpen ? PanelRightClose : PanelRight;
  return (
    <div className="flex items-center justify-between px-10 pt-8 pb-2">
      <button
        type="button"
        onClick={onBack}
        className="text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
      >
        Back
      </button>
      <button
        type="button"
        onClick={onTogglePanel}
        title={panelOpen ? "Hide thread panel" : "Show thread panel"}
        className="flex items-center gap-2 text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
      >
        <span>Thread</span>
        <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
      </button>
    </div>
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
    <div className="flex-1 min-h-0 overflow-y-auto px-10 pt-4 pb-6">
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
              <MessageRow key={i} m={m} agent={agent} />
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

function MessageRow({ m, agent }: { m: Message; agent: Agent }) {
  // Two sides: user on the right (our side), assistant/agent on the left.
  // Tool blocks render centered, inline, in a muted style.
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-[20px] rounded-br-md px-5 py-3 bg-secondary text-foreground text-[15px] leading-relaxed whitespace-pre-wrap break-words">
          {cleanUserText(m.text)}
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    return (
      <div className="flex items-end gap-3">
        <KindTile kind={agent.kind} size={34} />
        <div className="max-w-[78%] rounded-[20px] rounded-bl-md px-5 py-3 bg-foreground text-background text-[15px] leading-relaxed whitespace-pre-wrap break-words">
          {m.text || ""}
        </div>
      </div>
    );
  }
  return null;
}

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
      try {
        await fetch(`/api/agents/${agent.id}/plugins/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plugin: pluginName,
            marketplace,
            restart: true,
          }),
        });
      } finally {
        // Clear after a minute — the poll above picks up the real state.
        setTimeout(() => {
          setInstalling((s) => {
            const n = new Set(s);
            n.delete(key);
            return n;
          });
        }, 60_000);
      }
    },
    [agent]
  );

  return (
    <aside
      className={cn(
        "shrink-0 border-l border-border/60 bg-sidebar h-full overflow-hidden transition-[width] duration-200 ease-in-out",
        open ? "w-[340px] xl:w-[380px]" : "w-0 border-l-0"
      )}
    >
      {open && (
        <div className="h-full flex flex-col">
          <PanelHeader agent={agent} view={data} />
          <div className="flex-1 min-h-0 overflow-y-auto">
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
            {agent && data && (
              <PanelBody
                view={data}
                installing={installing}
                onInstall={install}
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
}: {
  agent: Agent | null;
  view: ClaudeDirView | null;
}) {
  const sourceLabel = !view
    ? ""
    : view.source === "own"
      ? "own .claude"
      : view.source === "inherited"
        ? `inherited · ${view.source_id}`
        : "global ~/.claude";
  return (
    <div className="px-8 pt-10 pb-5 border-b border-border/50">
      <div className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
        Installed
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

function PanelBody({
  view,
  installing,
  onInstall,
}: {
  view: ClaudeDirView;
  installing: Set<string>;
  onInstall: (plugin: string, marketplace: string) => void;
}) {
  const skills = view.skills ?? [];
  const agents = view.agents ?? [];
  const commands = view.commands ?? [];
  const plugins = view.plugins ?? [];
  const markets = view.marketplaces ?? [];
  const anything =
    skills.length + agents.length + commands.length + plugins.length + markets.length > 0 ||
    !!view.memory;
  return (
    <div className="px-8 py-6 space-y-9">
      {!anything && (
        <p className="text-sm italic text-muted-foreground">
          nothing installed yet
        </p>
      )}
      {plugins.length > 0 && (
        <Section icon={Package} label="Plugins" count={plugins.length}>
          {plugins.map((p) => (
            <PluginRow key={`${p.name}@${p.marketplace}`} plugin={p} />
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
      {markets.map((m) => (
        <Section
          key={m.name}
          icon={Store}
          label={`Marketplace · ${m.name}`}
          count={m.plugins.length}
        >
          {m.plugins.map((mp) => (
            <MarketRow
              key={mp.name}
              plugin={mp}
              marketplace={m.name}
              installing={installing.has(`${mp.name}@${m.name}`)}
              onInstall={onInstall}
            />
          ))}
        </Section>
      ))}
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

function PluginRow({ plugin }: { plugin: Plugin }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-foreground">{plugin.name}</span>
        {!plugin.enabled && (
          <span className="text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
            disabled
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
        {plugin.marketplace}
        {plugin.version ? ` · v${plugin.version}` : ""}
      </div>
      {plugin.description && (
        <p className="mt-1 text-[12px] leading-snug text-muted-foreground line-clamp-3">
          {plugin.description}
        </p>
      )}
    </div>
  );
}

function MarketRow({
  plugin,
  marketplace,
  installing,
  onInstall,
}: {
  plugin: MarketPlugin;
  marketplace: string;
  installing: boolean;
  onInstall: (plugin: string, marketplace: string) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-foreground">{plugin.name}</div>
        {plugin.description && (
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground line-clamp-2">
            {plugin.description}
          </p>
        )}
      </div>
      {plugin.installed ? (
        <span className="shrink-0 text-[9px] tracking-[0.22em] uppercase text-muted-foreground pt-1">
          installed
        </span>
      ) : (
        <button
          type="button"
          disabled={installing}
          onClick={() => onInstall(plugin.name, marketplace)}
          title={installing ? "installing…" : `Install ${plugin.name}`}
          className="shrink-0 flex items-center gap-1 h-6 px-2 rounded-md bg-background ring-1 ring-border/70 hover:ring-border transition text-[10px] tracking-[0.18em] uppercase text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {installing ? "…" : (
            <>
              <Plus className="w-3 h-3" strokeWidth={1.8} />
              Install
            </>
          )}
        </button>
      )}
    </div>
  );
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
      <div className="flex items-center gap-2 mb-3">
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
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-foreground">{skill.name}</span>
        {!skill.enabled && (
          <span className="text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
            disabled
          </span>
        )}
      </div>
      {skill.description && (
        <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground line-clamp-3">
          {skill.description}
        </p>
      )}
    </div>
  );
}

function NamedRow({ item }: { item: NamedMD }) {
  return (
    <div>
      <div className="text-[13px] font-medium text-foreground">{item.name}</div>
      {item.description && (
        <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground line-clamp-2">
          {item.description}
        </p>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
