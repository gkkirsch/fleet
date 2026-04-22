export interface Agent {
  id: string;
  kind: "dispatcher" | "orchestrator" | "worker" | string;
  parent?: string;
  description?: string;
  session_uuid?: string;
  target?: string;
  cwd?: string;
  created: string;
  last_seen?: string;
  status: string;
  jsonl_path?: string;
}

export interface Message {
  time: string;
  role: "user" | "assistant" | "tool_use" | "tool_result" | string;
  text?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  tool_id?: string;
  thinking?: boolean;
}

export interface Skill {
  name: string;
  description?: string;
  dir: string;
  enabled: boolean;
}

export interface NamedMD {
  name: string;
  description?: string;
}

export interface MemoryDoc {
  bytes: number;
  preview?: string;
}

export interface ClaudeDirView {
  source: "own" | "inherited" | "global";
  source_id?: string;
  dir: string;
  skills: Skill[] | null;
  agents: NamedMD[] | null;
  commands: NamedMD[] | null;
  memory?: MemoryDoc;
}
