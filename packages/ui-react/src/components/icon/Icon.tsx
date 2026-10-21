import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleQuestionMark,
  Clock,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FileJson,
  Files,
  FolderOpen,
  Funnel,
  GitCompareArrows,
  HelpCircle,
  Inbox,
  Info,
  KeyRound,
  ListTree,
  Minus,
  Monitor,
  MonitorCog,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  UserPlus,
  UserRound,
  X,
  createLucideIcon,
  type LucideProps,
} from "lucide-react";

// A 270° arc instead of Lucide's loader-circle, so a spinner paused by reduced motion still reads as loading.
const LoaderCircle = createLucideIcon("loader-circle", [
  ["path", { d: "M12 3a9 9 0 1 1-9 9", key: "arc" }],
]);

const icons = {
  arrow_down: ArrowDown,
  arrow_left: ArrowLeft,
  arrow_up: ArrowUp,
  arrow_up_right: ArrowUpRight,
  bell: Bell,
  braces: Braces,
  check: Check,
  chevron_down: ChevronDown,
  chevron_left: ChevronLeft,
  chevron_right: ChevronRight,
  chevron_up: ChevronUp,
  chevrons_up_down: ChevronsUpDown,
  circle_alert: CircleAlert,
  circle_check: CircleCheck,
  circle_question_mark: CircleQuestionMark,
  clock: Clock,
  copy: Copy,
  download: Download,
  ellipsis: Ellipsis,
  eye: Eye,
  eye_off: EyeOff,
  external_link: ExternalLink,
  file_json: FileJson,
  files: Files,
  folder_open: FolderOpen,
  funnel: Funnel,
  git_compare_arrows: GitCompareArrows,
  help_circle: HelpCircle,
  inbox: Inbox,
  info: Info,
  key_round: KeyRound,
  loader_circle: LoaderCircle,
  list_tree: ListTree,
  minus: Minus,
  monitor: Monitor,
  monitor_cog: MonitorCog,
  pause: Pause,
  pencil: Pencil,
  play: Play,
  plus: Plus,
  refresh_cw: RefreshCw,
  rotate_ccw: RotateCcw,
  save: Save,
  search: Search,
  settings: Settings,
  shield_alert: ShieldAlert,
  sliders_horizontal: SlidersHorizontal,
  trash_2: Trash2,
  triangle_alert: TriangleAlert,
  user_plus: UserPlus,
  user_round: UserRound,
  x: X,
} as const;

export type IconName = keyof typeof icons;

const isIconName = (name: string): name is IconName =>
  Object.hasOwn(icons, name);

export const iconNames: ReadonlyArray<IconName> =
  Object.keys(icons).filter(isIconName);

const sizes = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;

export type IconSize = keyof typeof sizes | number;

export interface IconProps extends Omit<LucideProps, "ref" | "size"> {
  readonly icon: IconName;
  readonly size?: IconSize;
}

export function Icon({ icon, size = "xl", ...props }: IconProps) {
  const Glyph = icons[icon];
  return (
    <Glyph {...props} size={typeof size === "number" ? size : sizes[size]} />
  );
}
