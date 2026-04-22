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
