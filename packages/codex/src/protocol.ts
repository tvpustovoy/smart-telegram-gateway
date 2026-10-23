// Типы app-server Codex, которые нужны адаптеру — руками по исходникам Codex rust-v0.163.0
// (codex-rs/app-server-protocol/src/protocol/v2/*.rs): в выгружаемой схеме TS экспериментальных полей (dynamicTools) нет.
// Сообщения — JSON по одному в строке, без поля "jsonrpc": запрос {id, method, params}, ответ {id, result | error},
// уведомление {method, params}. Сервер тоже шлёт запросы (item/tool/call, одобрения) — с method и id.

/** Версия Codex, на которой адаптер проверен. Другая — предупреждение в журнал, не отказ. */
export const CHECKED_CODEX_VERSION = '0.163';

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: { experimentalApi: boolean };
}

export interface InitializeResponse {
  /** «<имя клиента>/<версия Codex> (…)». */
  userAgent?: string;
  codexHome?: string;
  platformOs?: string;
}

export interface AccountReadResponse {
  account: { type: string; planType?: string | null } | null;
  requiresOpenaiAuth?: boolean;
}

/** Наш инструмент для Codex — DynamicToolFunctionSpec (protocol/src/dynamic_tools.rs). */
export interface DynamicToolSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';

/** Общее у thread/start и thread/resume. */
export interface ThreadSettings {
  cwd: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  developerInstructions: string;
  /** Поверх config.toml, как ключи `-c`: «sandbox_workspace_write.writable_roots» и т. п. */
  config?: Record<string, unknown>;
}

export interface ThreadStartParams extends ThreadSettings {
  dynamicTools: DynamicToolSpec[];
}

export interface ThreadResumeParams extends ThreadSettings {
  threadId: string;
  /** Без истории в ответе: полная выдача истории при resume устарела (deprecationNotice в 0.163). */
  excludeTurns: boolean;
}

export interface ThreadResponse {
  thread: { id: string };
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: { type: string; writableRoots?: string[]; networkAccess?: boolean };
  /** Файлы инструкций, которые Codex подхватил для треда (AGENTS.md папки агента, общий AGENTS.md пользователя). */
  instructionSources?: string[];
}

export interface UserInputText {
  type: 'text';
  text: string;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInputText[];
  /** Возвращается в истории полем clientId элемента userMessage. */
  clientUserMessageId: string;
}

export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';

/**
 * CodexErrorInfo (v2/shared.rs): единичные варианты — строкой («usageLimitExceeded»), с полями — объектом
 * ({"httpConnectionFailed": {"httpStatusCode": 502}}).
 */
export type CodexErrorInfo = string | Record<string, unknown>;

export interface TurnError {
  message: string;
  codexErrorInfo?: CodexErrorInfo | null;
  additionalDetails?: string | null;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  error?: TurnError | null;
  durationMs?: number | null;
}

/**
 * Ответ turn/start. Хода нет — новый ход; ход идёт — Codex добавляет ввод в него и отвечает тем же turn.id (признака
 * «Steered» наружу нет: опыт О2, 22.10).
 */
export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

/** Запрос сервера item/tool/call (v2/item.rs). */
export interface ToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: string | null;
  tool: string;
  arguments: unknown;
}

export type DynamicContentItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string };

export interface ToolCallResponse {
  contentItems: DynamicContentItem[];
  success: boolean;
}

/** Элементы хода, которые адаптер показывает в ленте (ThreadItem, v2/item.rs; поле type — camelCase). */
export type ThreadItem =
  | { type: 'userMessage'; id: string; clientId?: string | null }
  | { type: 'agentMessage'; id: string; text: string; phase?: string | null }
  | { type: 'reasoning'; id: string; summary?: string[]; content?: string[] }
  | { type: 'commandExecution'; id: string; command: string; cwd?: string; status?: string; exitCode?: number | null; durationMs?: number | null }
  | { type: 'fileChange'; id: string; changes: Array<{ path: string; kind?: { type?: string } | string }>; status?: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status?: string }
  | { type: 'dynamicToolCall'; id: string; tool: string; status?: string; success?: boolean | null }
  | { type: 'webSearch'; id: string; query?: string }
  | { type: 'contextCompaction'; id: string }
  /**
   * Картинка (ext/items/src/image_generation.rs, ImageGenerationItem): item/started — status «in_progress», item/completed
   * — «completed» (result — base64, savedPath — куда Codex её сохранил) или «failed».
   */
  | { type: 'imageGeneration'; id: string; status: string; revisedPrompt?: string | null; result?: string; savedPath?: string | null }
  | { type: string; id: string };

export interface ItemNotification {
  threadId: string;
  turnId: string;
  item: ThreadItem;
}

export interface TokenUsageNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
    last?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
    modelContextWindow?: number | null;
  };
}

/** Запросы сервера на одобрение: при approvalPolicy "never" их быть не должно; если придут — «decline». */
export const APPROVAL_REQUESTS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
