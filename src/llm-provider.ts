/**
 * LLM Provider — abstraction over execution backends.
 * Brain and workers both use this interface.
 */

// =============================================================================
// Content Blocks — generic, supports any media type
// =============================================================================

/** Text content */
export interface TextContent {
  type: 'text';
  text: string;
}

/** Binary/media content — images, audio, video, documents, anything */
export interface MediaContent {
  type: 'media';
  /** MIME type: image/png, audio/mp3, video/mp4, application/pdf, etc. */
  mediaType: string;
  /** How data is provided */
  source:
    | { type: 'base64'; data: string }
    | { type: 'url'; url: string }
    | { type: 'file'; path: string };
  /** Optional label/description */
  label?: string;
}

/** Stream content — real-time data (audio stream, video feed, SSE) */
export interface StreamContent {
  type: 'stream';
  /** MIME type of stream data */
  mediaType: string;
  /** Stream source URL (WebSocket, SSE, RTMP, etc.) */
  url: string;
  /** Stream protocol hint */
  protocol?: 'ws' | 'sse' | 'rtmp' | 'http-chunked';
  label?: string;
}

/** Reference to existing resource (file on disk, URL, database record) */
export interface RefContent {
  type: 'ref';
  /** URI: file:///path, https://url, db://table/id, etc. */
  uri: string;
  mediaType?: string;
  label?: string;
}

/** Any content block */
export type ContentBlock = TextContent | MediaContent | StreamContent | RefContent;

// =============================================================================
// Prompt & Response
// =============================================================================

/** Prompt: simple string or array of content blocks (any media) */
export type Prompt = string | ContentBlock[];

/** Structured response — text + any attachments */
export interface StructuredResponse {
  /** Primary text response */
  text: string;
  /** Output content blocks (created files, generated media, etc.) */
  outputs?: ContentBlock[];
  /** Metadata (token usage, duration, model, cost) */
  metadata?: Record<string, unknown>;
}

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Per-call runtime overrides — lets caller scope a single think() to a specific
 * filesystem context without rebuilding the provider.
 *
 * Today: `cwd` for filesystem-touching backends (sdk, shell). Other providers
 * ignore unknown fields. Expand carefully — every field here widens the trust
 * surface for /dispatch callers.
 */
/**
 * ToolUseEvent — surfaced from the underlying provider whenever the model
 * invokes a tool. Used by callers (e.g. middleware /dispatch) to enrich
 * TaskRecord.metadata.toolUseSummary for cross-agent observability.
 * Issue #1 (federation observability gap).
 */
export interface ToolUseEvent {
  /** Tool name (e.g. 'Read', 'Bash', 'Edit') */
  name: string;
  /** Compact target/argument hint — best-effort extraction from input shape */
  target?: string;
  /** True if a tool_result with is_error=false was observed; undefined if pending */
  ok?: boolean;
  /** Provider-specific tool_use id, used to correlate with tool_result */
  id?: string;
  /** Wall-clock timestamp when tool_use was emitted */
  ts: number;
}

export interface RuntimeOptions {
  /** Absolute workdir for this call. Validated at dispatch boundary (must exist + be directory). */
  cwd?: string;
  /** Abort signal — provider stops iteration + returns if aborted. */
  signal?: AbortSignal;
  /** Called on each observable activity (e.g. SDK message yield) for progress-based timeout. */
  onActivity?: () => void;
  /**
   * Called whenever the underlying provider observes a tool_use event from the model.
   * Fired once per tool invocation (best-effort, after the initial assistant message
   * with the tool_use block). For providers that subsequently see a matching
   * tool_result block, the same event is fired again with `ok` populated.
   */
  onToolUse?: (event: ToolUseEvent) => void;
}

export interface LLMProvider {
  think(prompt: Prompt, systemPrompt: string, opts?: RuntimeOptions): Promise<string>;
  /** Extended: return structured response with multimodal output */
  thinkStructured?(prompt: Prompt, systemPrompt: string, opts?: RuntimeOptions): Promise<StructuredResponse>;
  /** Streaming: yield partial results as they arrive */
  thinkStream?(prompt: Prompt, systemPrompt: string, opts?: RuntimeOptions): AsyncIterable<StreamChunk>;
}

/** Chunk emitted during streaming */
export interface StreamChunk {
  type: 'text_delta' | 'content_block' | 'tool_use' | 'done' | 'error';
  /** Partial text for text_delta */
  text?: string;
  /** Complete content block for content_block */
  content?: ContentBlock;
  /** Metadata on done */
  metadata?: Record<string, unknown>;
  /** Error message */
  error?: string;
}

// =============================================================================
// Backward compat aliases
// =============================================================================

/** @deprecated Use MediaContent instead */
export type ImageSource = { type: 'base64' | 'url'; mediaType: string; data: string };
