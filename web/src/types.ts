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

export interface CredentialDecl {
  key: string;
  label?: string;
  description?: string;
  required?: boolean;
  set: boolean;
}

export interface Plugin {
  name: string;
  marketplace: string;
  version?: string;
  description?: string;
  author?: string;
  enabled: boolean;
  credentials?: CredentialDecl[];
}

export interface MarketPlugin {
  name: string;
  description?: string;
  category?: string;
  installed: boolean;
}

export interface Marketplace {
  name: string;
  source?: string;
  plugins: MarketPlugin[];
}

export interface ClaudeDirView {
  source: "own" | "inherited" | "global";
  source_id?: string;
  dir: string;
  skills: Skill[] | null;
  agents: NamedMD[] | null;
  commands: NamedMD[] | null;
  plugins: Plugin[] | null;
  marketplaces: Marketplace[] | null;
  memory?: MemoryDoc;
}

export interface Artifact {
  id: string;
  type: string;
  title?: string;
  port: number;
  created: string;
  path: string;
  status: "idle" | "installing" | "starting" | "ready" | "crashed" | string;
  alive: boolean;
  error?: string;
}
