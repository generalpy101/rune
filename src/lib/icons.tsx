/** Consistent monochrome chrome icon set.
 *
 *  All app-chrome glyphs (toolbar, headers, tool cards) come from one place so
 *  they share a family and a single size. Brand/file-type icons in the file
 *  tree still come from react-icons (`fileIcons.tsx`) — those are intentionally
 *  colorful. These inherit `currentColor` and default to 16px. */
import {
  VscAdd,
  VscClose,
  VscSearch,
  VscSettingsGear,
  VscRefresh,
  VscNewFile,
  VscNewFolder,
  VscArrowUp,
  VscArrowDown,
  VscChevronUp,
  VscChevronDown,
  VscChevronRight,
  VscDebugStop,
  VscSparkle,
  VscRobot,
  VscTerminal,
  VscOutput,
  VscEdit,
  VscReplace,
  VscFile,
  VscListSelection,
  VscMention,
  VscSend,
  VscServerProcess,
  VscListFlat,
  VscLayoutSidebarLeft,
  VscSourceControl,
  VscFolder,
  VscFilter,
  VscFiles,
  VscBookmark,
  VscBroadcast,
} from "react-icons/vsc";

export {
  VscAdd as IconPlus,
  VscClose as IconClose,
  VscSearch as IconSearch,
  VscSettingsGear as IconSettings,
  VscRefresh as IconRefresh,
  VscNewFile as IconNewFile,
  VscNewFolder as IconNewFolder,
  VscArrowUp as IconArrowUp,
  VscArrowDown as IconArrowDown,
  VscChevronUp as IconChevronUp,
  VscChevronDown as IconChevronDown,
  VscChevronRight as IconChevronRight,
  VscDebugStop as IconStop,
  VscSparkle as IconSparkle,
  VscListFlat as IconPalette,
  VscLayoutSidebarLeft as IconSidebar,
  VscSourceControl as IconGitBranch,
  VscFolder as IconFolder,
  VscFilter as IconFilter,
  VscFiles as IconCopy,
  VscBookmark as IconBookmark,
  VscBroadcast as IconBroadcast,
};

/** Per-tool glyph for AI tool-call cards. */
export const TOOL_ICON_COMPONENT: Record<
  string,
  React.ComponentType<{ size?: number }>
> = {
  run_command: VscChevronRight,
  start_server: VscServerProcess,
  read_output: VscOutput,
  read_terminal: VscTerminal,
  read_file: VscFile,
  write_file: VscEdit,
  edit_file: VscReplace,
  list_dir: VscListSelection,
  list_agents: VscMention,
  send_message: VscSend,
  spawn_agent: VscRobot,
};
