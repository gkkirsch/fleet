import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Agent, Message } from "./types";

const POLL_MS = 2000;

export function App() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/fleet");
        if (!res.ok) throw new Error(`fleet ${res.status}`);
        const data = (await res.json()) as Agent[] | null;
        if (!cancelled) {
          setAgents(data ?? []);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(String((e as Error).message));
      }
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/agents/${selectedId}/messages`);
        if (!res.ok) throw new Error();
        const data = (await res.json()) as Message[] | null;
        if (!cancelled) setMessages(data ?? []);
      } catch {
        /* swallow */
      }
    };
    tick();
    const h = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [selectedId]);

  const selected = agents?.find((a) => a.id === selectedId) ?? null;

  return (
    <div className="h-screen grid grid-cols-[360px_1fr] bg-background text-foreground">
      {error && (
        <div className="col-span-2 bg-destructive/20 text-destructive text-xs px-3 py-1">
          backend: {error}
        </div>
      )}
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
  byId: Map<string, Agent>;
  children: Map<string, Agent[]>;
  roots: Agent[];
};

function buildTree(agents: Agent[]): Tree {
  const byId = new Map<string, Agent>();
  const children = new Map<string, Agent[]>();
  agents.forEach((a) => byId.set(a.id, a));
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
  return { byId, children, roots };
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
    <div className="border-r border-border bg-sidebar flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h1 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          Fleet
        </h1>
        {agents && (
          <Badge variant="secondary" className="text-xs">
            {agents.length}
          </Badge>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2">
          {agents === null && (
            <div className="text-muted-foreground text-sm p-3">loading…</div>
          )}
          {agents !== null && agents.length === 0 && (
            <div className="text-muted-foreground text-sm p-3">
              no agents registered.
              <div className="text-xs mt-1 opacity-70">
                run <code>roster spawn …</code>
              </div>
            </div>
          )}
          {tree.roots.map((a) => (
            <AgentNode
              key={a.id}
              agent={a}
              tree={tree}
              depth={0}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "streaming":
      return "bg-amber-400 animate-pulse";
    case "stopped":
      return "bg-muted-foreground/40";
    case "starting":
      return "bg-sky-400";
    case "trust-dialog":
    case "permission-dialog":
      return "bg-rose-500";
    case "not-found":
    case "dead":
      return "bg-rose-700";
    default:
      return "bg-muted-foreground/40";
  }
}

function AgentNode({
  agent,
  tree,
  depth,
  selectedId,
  onSelect,
}: {
  agent: Agent;
  tree: Tree;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const kids = tree.children.get(agent.id) ?? [];
  const isSelected = agent.id === selectedId;
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(agent.id)}
        className={cn(
          "w-full text-left flex items-start gap-2 px-2 py-2 rounded-md border border-transparent transition-colors",
          isSelected
            ? "bg-accent border-border"
            : "hover:bg-accent/40"
        )}
      >
        <div
          className={cn(
            "mt-1.5 h-2.5 w-2.5 rounded-full flex-shrink-0",
            statusColor(agent.status)
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-sm font-medium truncate">
              {agent.id}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {agent.kind}
            </span>
          </div>
          {agent.description && (
            <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
              {agent.description}
            </div>
          )}
        </div>
      </button>
      {kids.length > 0 && (
        <div className="ml-4 pl-2 border-l border-dashed border-border">
          {kids.map((k) => (
            <AgentNode
              key={k.id}
              agent={k}
              tree={tree}
              depth={depth + 1}
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
      <div className="flex items-center justify-center text-muted-foreground">
        select an agent
      </div>
    );
  }
  return (
    <div className="flex flex-col h-full min-h-0">
      <DetailHeader agent={agent} />
      <MessageStream messages={messages} />
      <NotifyBox agentId={agent.id} />
    </div>
  );
}

function DetailHeader({ agent }: { agent: Agent }) {
  return (
    <div className="border-b border-border px-5 py-4 bg-sidebar/40">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-lg font-semibold">{agent.id}</span>
        <Badge variant="secondary" className="uppercase tracking-wider text-[10px]">
          {agent.kind}
        </Badge>
        <StatusBadge status={agent.status} />
      </div>
      <div className="text-xs text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
        {agent.parent && <span>parent: {agent.parent}</span>}
        {agent.target && <span>target: {agent.target}</span>}
        {agent.session_uuid && (
          <span title={agent.session_uuid}>
            uuid: {agent.session_uuid.slice(0, 8)}…
          </span>
        )}
        {agent.cwd && <span>cwd: {agent.cwd}</span>}
      </div>
      {agent.description && (
        <div className="mt-3 text-sm text-foreground/90">
          {agent.description}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className="text-[10px] uppercase tracking-wider gap-1.5 border-border"
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", statusColor(status))} />
      {status}
    </Badge>
  );
}

// ─────────────────────────────────────────────────────────────────

function MessageStream({ messages }: { messages: Message[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to bottom when new messages arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  if (!messages || messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        no messages yet
      </div>
    );
  }
  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="px-5 py-4 space-y-2.5">
        {messages.map((m, i) => (
          <MessageRow key={i} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}

function MessageRow({ m }: { m: Message }) {
  const roleLabel = m.thinking ? "thinking" : m.role;
  const tone = toneFor(m);
  return (
    <Card
      className={cn(
        "px-3.5 py-2.5 gap-0 shadow-none text-sm whitespace-pre-wrap break-words",
        tone
      )}
    >
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
        <div className="flex items-center gap-2">
          <span>{roleLabel}</span>
          {m.tool && (
            <span className="font-mono text-[11px] normal-case tracking-normal text-emerald-400">
              {m.tool}
            </span>
          )}
        </div>
        <span className="font-mono opacity-60">{fmtTime(m.time)}</span>
      </div>
      <MessageBody m={m} />
    </Card>
  );
}

function toneFor(m: Message): string {
  if (m.thinking) return "bg-muted/40 border-dashed italic opacity-80";
  switch (m.role) {
    case "user":
      return "bg-blue-950/40 border-blue-900/50";
    case "assistant":
      return "bg-card";
    case "tool_use":
      return "bg-emerald-950/30 border-emerald-900/50 font-mono text-[12.5px]";
    case "tool_result":
      return "bg-muted/30 font-mono text-[12.5px] text-muted-foreground";
    default:
      return "bg-card";
  }
}

function MessageBody({ m }: { m: Message }) {
  if (m.role === "tool_use") {
    return (
      <pre className="text-[11.5px] m-0 overflow-x-auto whitespace-pre-wrap">
        {JSON.stringify(m.input, null, 2)}
      </pre>
    );
  }
  if (m.role === "tool_result") {
    return <>{m.output || ""}</>;
  }
  return <>{m.text || ""}</>;
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─────────────────────────────────────────────────────────────────

function NotifyBox({ agentId }: { agentId: string }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = useCallback(async () => {
    if (!text.trim()) return;
    setSending(true);
    setErr(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, from: "ui" }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || `HTTP ${res.status}`);
      }
      setText("");
    } catch (e: unknown) {
      setErr(String((e as Error).message));
    } finally {
      setSending(false);
    }
  }, [agentId, text]);

  return (
    <>
      <Separator />
      <div className="p-4 bg-sidebar/40">
        <div className="flex gap-2 items-end">
          <Textarea
            className="font-mono text-sm bg-background resize-none min-h-[60px]"
            placeholder={`message ${agentId}…  (⌘⏎ to send)`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
            disabled={sending}
          />
          <Button onClick={send} disabled={sending || !text.trim()}>
            {sending ? "…" : "send"}
          </Button>
        </div>
        {err && (
          <div className="text-destructive text-xs mt-2">{err}</div>
        )}
      </div>
    </>
  );
}
