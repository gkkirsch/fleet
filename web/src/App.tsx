import { useCallback, useEffect, useMemo, useState } from "react";
import type { Agent, Message } from "./types";

const POLL_MS = 2000;

export function App() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Poll /api/fleet every 2s.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/fleet");
        if (!res.ok) throw new Error(`fleet: ${res.status}`);
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

  // When selection or time changes, refresh messages.
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/agents/${selectedId}/messages`);
        if (!res.ok) throw new Error(`messages: ${res.status}`);
        const data = (await res.json()) as Message[] | null;
        if (!cancelled) setMessages(data ?? []);
      } catch {
        /* ignore transient errors */
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
    <div className="layout">
      {error && <div className="banner">backend error: {error}</div>}
      <Sidebar
        agents={agents}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
      <Detail agent={selected} messages={messages} />
    </div>
  );
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
  // Build parent → children map for the tree.
  const tree = useMemo(() => buildTree(agents ?? []), [agents]);
  return (
    <div className="sidebar">
      <h1>Fleet{agents ? ` · ${agents.length}` : ""}</h1>
      {agents === null && <div className="empty">loading…</div>}
      {agents !== null && agents.length === 0 && (
        <div className="empty">
          no agents registered.
          <br />
          <small>run `roster spawn …`</small>
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
  );
}

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
      <div
        className={`agent ${isSelected ? "selected" : ""}`}
        onClick={() => onSelect(agent.id)}
      >
        <div className={`dot ${agent.status}`} />
        <div className="meta">
          <div>
            <span className="id">{agent.id}</span>
            <span className="kind">{agent.kind}</span>
          </div>
          {agent.description && <div className="desc">{agent.description}</div>}
        </div>
      </div>
      {kids.length > 0 && (
        <div className="tree-child">
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

function Detail({
  agent,
  messages,
}: {
  agent: Agent | null;
  messages: Message[];
}) {
  if (!agent) {
    return (
      <div className="detail">
        <div className="empty">select an agent</div>
      </div>
    );
  }
  return (
    <div className="detail">
      <div className="detail-header">
        <div>
          <span className="id">{agent.id}</span>{" "}
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            {agent.kind} · {agent.status}
          </span>
        </div>
        <div className="sub">
          {agent.parent && <>parent: <code>{agent.parent}</code> · </>}
          {agent.target && <>target: <code>{agent.target}</code> · </>}
          {agent.session_uuid && (
            <>uuid: <code>{agent.session_uuid.slice(0, 8)}…</code></>
          )}
        </div>
        {agent.description && <div className="desc">{agent.description}</div>}
      </div>
      <MessageStream messages={messages} />
      <NotifyBox agentId={agent.id} />
    </div>
  );
}

function MessageStream({ messages }: { messages: Message[] }) {
  if (!messages || messages.length === 0) {
    return (
      <div className="messages">
        <div className="empty">no messages yet</div>
      </div>
    );
  }
  return (
    <div className="messages">
      {messages.map((m, i) => (
        <MessageRow key={i} m={m} />
      ))}
    </div>
  );
}

function MessageRow({ m }: { m: Message }) {
  const cls = m.thinking ? "thinking" : m.role;
  let body: React.ReactNode = m.text ?? "";
  if (m.role === "tool_use") {
    body = (
      <>
        <div>
          <strong>{m.tool}</strong>(
        </div>
        <pre style={{ margin: 0, fontSize: 11 }}>
          {JSON.stringify(m.input, null, 2)}
        </pre>
        <div>)</div>
      </>
    );
  }
  if (m.role === "tool_result") {
    body = m.output ?? "";
  }
  return (
    <div className={`msg ${cls}`}>
      <div className="role">
        {m.thinking ? "thinking" : m.role}
        {m.tool && <span className="tool-name">{m.tool}</span>}
        <span className="ts">{fmtTime(m.time)}</span>
      </div>
      {body}
    </div>
  );
}

function fmtTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

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
    <div className="notify">
      <textarea
        placeholder={`message ${agentId}…`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
        }}
        disabled={sending}
      />
      <button onClick={send} disabled={sending || !text.trim()}>
        {sending ? "…" : "send"}
      </button>
      {err && (
        <div style={{ color: "var(--err)", fontSize: 12, alignSelf: "center" }}>
          {err}
        </div>
      )}
    </div>
  );
}
