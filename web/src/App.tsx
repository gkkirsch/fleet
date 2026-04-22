import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
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
      const res = await fetch("/api/fleet").catch(() => null);
      if (stop || !res || !res.ok) return;
      setAgents(((await res.json()) as Agent[] | null) ?? []);
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
      const res = await fetch(`/api/agents/${selectedId}/messages`).catch(() => null);
      if (stop || !res || !res.ok) return;
      setMessages(((await res.json()) as Message[] | null) ?? []);
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
    <div className="h-screen grid grid-cols-[320px_1fr] bg-background text-foreground">
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <Detail agent={selected} messages={messages} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────

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
    <aside className="border-r border-border bg-sidebar flex flex-col h-full min-h-0">
      <div className="px-7 pt-8 pb-4">
        <h1 className="text-[13px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
          Fleet
        </h1>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-3 pb-6 space-y-1">
          {agents === null && (
            <p className="text-muted-foreground text-sm px-4 py-6 italic">
              loading…
            </p>
          )}
          {agents !== null && agents.length === 0 && (
            <p className="text-muted-foreground text-sm px-4 py-6">
              no agents yet
            </p>
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
      </ScrollArea>
    </aside>
  );
}

function AgentNode({
  agent,
  tree,
  selectedId,
  onSelect,
}: {
  agent: Agent;
  tree: Tree;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const kids = tree.children.get(agent.id) ?? [];
  const isSelected = agent.id === selectedId;
  // Only surface non-default statuses — ready is the assumed norm, no chrome.
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
          "w-full text-left px-4 py-3 rounded-2xl transition-colors duration-150",
          isSelected
            ? "bg-card ring-1 ring-border/60"
            : "hover:bg-sidebar-accent/50"
        )}
      >
        <div
          className={cn(
            "text-[14px] leading-snug",
            agent.status === "stopped" ? "text-muted-foreground" : "text-foreground/90"
          )}
        >
          {agent.description || agent.id}
        </div>
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
      </button>
      {kids.length > 0 && (
        <div className="ml-5 mt-1 space-y-1">
          {kids.map((k) => (
            <AgentNode
              key={k.id}
              agent={k}
              tree={tree}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────

function Detail({
  agent,
  messages,
}: {
  agent: Agent | null;
  messages: Message[];
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
      <header className="px-12 pt-10 pb-6">
        <h2 className="text-[15px] leading-relaxed text-foreground max-w-2xl">
          {agent.description || agent.id}
        </h2>
      </header>
      <MessageStream messages={messages} />
      <NotifyBox agentId={agent.id} />
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────

function MessageStream({ messages }: { messages: Message[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  // Skip thinking blocks — noise for this view.
  const filtered = messages.filter((m) => !m.thinking);

  if (filtered.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm italic">
        —
      </div>
    );
  }
  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="px-12 py-2 pb-8 space-y-3 max-w-3xl">
        {filtered.map((m, i) => (
          <MessageRow key={i} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

function MessageRow({ m }: { m: Message }) {
  if (m.role === "user") {
    return (
      <div className="rounded-2xl px-5 py-4 bg-[color:var(--matcha-soft)]/55 border border-[color:var(--matcha-soft)] text-[14.5px] leading-relaxed whitespace-pre-wrap break-words">
        {cleanUserText(m.text)}
      </div>
    );
  }
  if (m.role === "assistant") {
    return (
      <div className="rounded-2xl px-5 py-4 bg-card border border-border/60 text-[14.5px] leading-relaxed whitespace-pre-wrap break-words">
        {m.text || ""}
      </div>
    );
  }
  if (m.role === "tool_use") {
    return (
      <div className="rounded-xl px-4 py-2.5 bg-[color:var(--ochre-soft)]/45 border border-[color:var(--ochre-soft)]/90 font-mono text-[12.5px] text-foreground/80 leading-snug flex items-baseline gap-3">
        <span className="font-medium text-[color:var(--primary)] tracking-tight">{m.tool}</span>
        <span className="truncate opacity-80">{toolPreview(m)}</span>
      </div>
    );
  }
  if (m.role === "tool_result") {
    return (
      <div className="rounded-xl px-4 py-2.5 bg-secondary/70 font-mono text-[12.5px] text-muted-foreground leading-snug whitespace-pre-wrap break-words">
        {trimOutput(m.output)}
      </div>
    );
  }
  return null;
}

// Strip the "[from xxx]\n\n" prefix we prepend in notify; the user doesn't
// want to read their own UI wrapper back every time.
function cleanUserText(text?: string): string {
  if (!text) return "";
  return text.replace(/^\[from [^\]]+\]\n\n/, "");
}

function toolPreview(m: Message): string {
  const inp = m.input;
  if (!inp || typeof inp !== "object") return "";
  const rec = inp as Record<string, unknown>;
  for (const k of ["command", "file_path", "path", "pattern", "url", "query"]) {
    const v = rec[k];
    if (typeof v === "string") return v;
  }
  // Fallback: first short string value, else nothing.
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.length < 160) return v;
  }
  return "";
}

function trimOutput(out?: string): string {
  if (!out) return "";
  const max = 600;
  return out.length <= max ? out : out.slice(0, max) + "\n…";
}

// ─────────────────────────────────────────────────────────────────

function NotifyBox({ agentId }: { agentId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = useCallback(async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, from: "ui" }),
      });
      if (res.ok) setText("");
    } finally {
      setSending(false);
    }
  }, [agentId, text]);

  return (
    <div className="px-12 pt-4 pb-8">
      <div className="max-w-3xl flex gap-3 items-end">
        <Textarea
          className="rounded-3xl border-border/70 bg-card text-[14.5px] resize-none min-h-[64px] px-5 py-3.5 shadow-none focus-visible:ring-1 focus-visible:ring-ring/50 leading-relaxed"
          placeholder="message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          disabled={sending}
        />
        <Button
          onClick={send}
          disabled={sending || !text.trim()}
          className="rounded-full h-[64px] px-7 shadow-none"
        >
          send
        </Button>
      </div>
    </div>
  );
}
