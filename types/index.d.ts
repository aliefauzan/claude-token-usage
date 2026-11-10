/** Token counts in the order the API reports them: input, output, cache read, cache write. */
export type Quad = [number, number, number, number]

/**
 * One local day of usage, counted as /stats counts it: a session's whole
 * usage under the day it started, every saved line of a reply counted.
 */
export type Day = {
  /** Tokens. */
  t: Quad
  /** Messages, as /stats counts them. */
  msgs: number
  /** Sessions started that day. */
  sess: number
  /** Sessions started by local hour, "0" to "23". */
  h: Record<string, number>
  /** Tokens by model. */
  m: Record<string, Quad>
  /** Estimated USD at Anthropic API list prices. */
  c: number
  /** Estimated USD by model. */
  mc: Record<string, number>
  /**
   * Transcript tokens by feature (Chats, Subagents, Scheduled), project and
   * surface: shares of the day, as the cache file keeps no such split. Absent
   * on days whose transcripts are gone.
   */
  f?: Record<string, number>
  p?: Record<string, number>
  s?: Record<string, number>
  /** Tool calls by tool; MCP tools grouped by server. */
  tl?: Record<string, number>
  /** Claude's replies by model. */
  r?: Record<string, number>
}

/** One chat: a main session with its subagents, filed under the day it started. */
export type Chat = {
  id: string
  title: string
  project: string
  surface: string
  day: string
  /** The model with the most tokens. */
  model: string
  tokens: number
  cost: number
  subagents: number
  msgs: number
}

export type Meta = {
  /** Local date of the first session, YYYY-MM-DD. */
  firstDay: string | null
  /** ISO time of the first session. */
  firstSessionAt: string | null
  longestSessionMs: number
  /** Sessions started by local hour, all time. */
  hours: Record<string, number>
  /** The last day ~/.claude/stats-cache.json covers; later days come from transcripts. */
  statsThrough: string
}

export type Usage = {
  /** Local date the figures were summed on, YYYY-MM-DD. */
  today: string
  meta: Meta
  days: Record<string, Day>
  /** Every chat of the last 31 days and the largest before them, largest first. */
  chats: Chat[]
  /** Epoch ms of the refresh. */
  updatedAt: number
}

export type Status = { isLoading: boolean; error: string | null }
export type Tab = 'overview' | 'models' | 'analytics'
export type Breakdown = 'feature' | 'model' | 'project' | 'surface'
export type Range = 'all' | '30d' | '7d'

declare module 'claude-code' {
  interface PluginState {
    'token-usage': {
      usage: Shaped<Usage | null>
      status: Status
      tab: Tab
      range: Range
      breakdown: Breakdown
      /** The project whose chats are open in Top projects. */
      openProject: string | null
      /** How many rows Top projects shows. */
      projectRows: number
    }
  }
}
