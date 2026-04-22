import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Layers, Paperclip, Send, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Agent, Message } from "./types";

const POLL_MS = 2000;

export function App() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);

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

  return (
    <div className="h-screen grid grid-cols-[380px_1fr] bg-background text-foreground">
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <Detail
        agent={selected}
        messages={messages}
        onBack={() => setSelectedId(null)}
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
  onBack,
}: {
  agent: Agent | null;
  messages: Message[];
  onBack: () => void;
}) {
  if (!agent) {
    return (
      <div className="flex items-center justify-center text-muted-foreground text-sm italic">
        select one
      </div>
    );
  }
  return (
    <section className="flex flex-col h-full min-h-0">
      <TopNav onBack={onBack} />
      <MessageStream agent={agent} messages={messages} />
      <NotifyBox agentId={agent.id} />
    </section>
  );
}

function TopNav({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center justify-between px-10 pt-8 pb-2">
      <button
        type="button"
        onClick={onBack}
        className="text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase hover:text-foreground transition-colors"
      >
        Back
      </button>
      <span className="text-[11px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
        Thread
      </span>
    </div>
  );
}

// ─── messages ────────────────────────────────────────────────────

function MessageStream({ agent, messages }: { agent: Agent; messages: Message[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  const filtered = messages.filter((m) => !m.thinking);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-10 pt-4 pb-6">
      <div className="max-w-3xl mx-auto">
        {/* Big serif display title — from description, or id as fallback */}
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

        {filtered.length === 0 ? (
          <div className="text-muted-foreground text-sm italic py-8">
            no messages yet — send one below
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((m, i) => (
              <MessageRow key={i} m={m} agent={agent} />
            ))}
          </div>
        )}
        <div ref={bottomRef} />
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
  if (m.role === "tool_use") {
    const preview = toolPreview(m);
    return (
      <div className="flex justify-center">
        <div className="inline-flex items-center gap-2.5 rounded-full bg-[color:var(--ochre-soft)]/60 border border-[color:var(--ochre-soft)] px-4 py-1.5 text-[12px] font-mono text-[color:var(--primary)]">
          <span className="font-semibold tracking-tight">{m.tool}</span>
          {preview && (
            <span className="text-foreground/60 truncate max-w-md">{preview}</span>
          )}
        </div>
      </div>
    );
  }
  if (m.role === "tool_result") {
    const out = trimOutput(m.output);
    if (!out.trim()) return null;
    return (
      <div className="flex justify-center">
        <div className="max-w-xl rounded-xl bg-muted/60 border border-border/60 px-4 py-2 text-[12px] font-mono text-muted-foreground whitespace-pre-wrap break-words leading-snug">
          {out}
        </div>
      </div>
    );
  }
  return null;
}

function cleanUserText(text?: string): string {
  if (!text) return "";
  return text.replace(/^\[from [^\]]+\]\n\n/, "").trim();
}

function toolPreview(m: Message): string {
  const inp = m.input;
  if (!inp || typeof inp !== "object") return "";
  const rec = inp as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query"]) {
    const v = rec[k];
    if (typeof v === "string") return v;
  }
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.length < 160) return v;
  }
  return "";
}

function trimOutput(out?: string): string {
  if (!out) return "";
  const max = 400;
  return out.length <= max ? out : out.slice(0, max) + "…";
}

// ─── notify ──────────────────────────────────────────────────────

function NotifyBox({ agentId }: { agentId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    if (!text.trim()) return;
    setSending(true);
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
  }, [agentId, text]);

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
