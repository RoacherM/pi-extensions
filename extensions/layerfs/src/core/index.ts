// Harness-Agnostic LayerFS Core Engine
// Zero dependencies on @earendil-works/pi-coding-agent so any agent harness
// (Pi, Epi, Claude Code, Codex, Cursor, DSH, MCP servers, CLI) can use it directly.

export {
  assertInsideWorkspace,
  expandBraces,
  isExcludedPath,
  isOutsideSecret,
  LayerfsError,
  LayerfsSession,
  matchesToolGlob,
  rsyncExcludeArgs,
  stopNativeDaemons,
  type ApplyResult,
  type Checkpoint,
  type MergeResult,
  type OpenOptions,
  type UserBranch,
  type Workspace,
} from "../workspace.ts";

export {
  DEFAULT_EXCLUDES,
  resolveConfig,
  type LayerfsConfig,
} from "../config.ts";

export {
  BindingStore,
  nameFromFolder,
  type HostEntry,
  type HostIndex,
  type ProjectRecord,
  type SessionBinding,
} from "../bindings.ts";

export {
  formatHistory,
  hiddenPath,
  loadHistory,
  parseMessage,
  type HistoryFile,
  type HistoryRow,
  type HistoryView,
} from "../history.ts";

export {
  bothSpellings,
  buildSeatbeltProfile,
  globToSbplRegex,
  type SeatbeltOptions,
} from "../seatbelt.ts";

export {
  acquireLock,
  acquireLockSync,
  type FileLock,
} from "../lock.ts";

export {
  createProjectClient,
  ensureNativeDirs,
  type NativeSpec,
} from "./client.ts";

export {
  run,
  type RunResult,
} from "./exec-helper.ts";

export {
  cleanRelPath,
  createHarnessOperations,
  executeLayerfsAction,
  executeLayerfsApply,
  LAYERFS_APPLY_TOOL_DESCRIPTION,
  LAYERFS_APPLY_TOOL_SCHEMA,
  LAYERFS_TOOL_DESCRIPTION,
  LAYERFS_TOOL_SCHEMA,
  type LayerfsActionHooks,
  type LayerfsActionParams,
} from "./tools.ts";

