import {
  BookOpen,
  Briefcase,
  Calendar,
  ClipboardList,
  Compass,
  Flag,
  GraduationCap,
  Handshake,
  Lightbulb,
  MessageCircle,
  Phone,
  Presentation,
  Rocket,
  RotateCcw,
  Scale,
  Search,
  Shield,
  Target,
  TrendingUp,
  UserRound,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";

/**
 * THE icon vocabulary for scenarios / meeting kinds.
 *
 * Scenarios used to carry a free-typed emoji, which meant every list rendered
 * at a different optical weight and colour — loud next to the quiet lucide
 * strokes the rest of the app is drawn with. A scenario icon is a CATEGORY
 * MARK (ten rows in one dropdown, told apart at a glance), not decoration, so
 * it stays — but it is now picked from a fixed set instead of typed.
 *
 * Keys are the stable strings written to the bundle file and accepted over
 * MCP; renaming one silently re-skins every scenario that stored it, so treat
 * them as data, not labels. Icons are imported BY NAME on purpose: a dynamic
 * `import("lucide-react")[name]` would defeat tree-shaking and pull ~1500
 * components into the bundle.
 */
export const ICON_REGISTRY: Record<string, LucideIcon> = {
  handshake: Handshake,
  scale: Scale,
  rocket: Rocket,
  target: Target,
  "rotate-ccw": RotateCcw,
  "graduation-cap": GraduationCap,
  users: Users,
  "user-round": UserRound,
  phone: Phone,
  video: Video,
  calendar: Calendar,
  "clipboard-list": ClipboardList,
  "message-circle": MessageCircle,
  briefcase: Briefcase,
  presentation: Presentation,
  lightbulb: Lightbulb,
  compass: Compass,
  flag: Flag,
  "book-open": BookOpen,
  search: Search,
  shield: Shield,
  "trending-up": TrendingUp,
};

/** Registry keys in declaration order — what the picker grid renders. */
export const ICON_NAMES: readonly string[] = Object.keys(ICON_REGISTRY);

/** Fallback for anything unnamed or unrecognised. */
export const DEFAULT_ICON_NAME = "target";

/**
 * Emoji written by older builds (and by MCP callers that still send one) mapped
 * onto registry names. Scenarios live in a user-owned file on disk that we
 * never migrate in place, so these strings keep arriving forever — resolving
 * them here is the whole reason nothing has to be rewritten on read.
 *
 * Some emoji exist both with and without the U+FE0F variation selector; the
 * stored string is whatever the user's keyboard produced, so both are listed.
 */
export const LEGACY_EMOJI_MAP: Record<string, string> = {
  "🎯": "target",
  "🤝": "handshake",
  "⚖️": "scale",
  "⚖": "scale",
  "🚀": "rocket",
  "🔁": "rotate-ccw",
  "🎓": "graduation-cap",
  "👥": "users",
  "👤": "user-round",
  "📞": "phone",
  "☎️": "phone",
  "☎": "phone",
  "📹": "video",
  "🎥": "video",
  "📅": "calendar",
  "🗓️": "calendar",
  "🗓": "calendar",
  "📋": "clipboard-list",
  "💬": "message-circle",
  "💼": "briefcase",
  "📊": "presentation",
  "💡": "lightbulb",
  "🧭": "compass",
  "🚩": "flag",
  "📖": "book-open",
  "📚": "book-open",
  "🔍": "search",
  "🛡️": "shield",
  "🛡": "shield",
  "📈": "trending-up",
};

/**
 * Registry name (or legacy emoji, or junk) -> a component that always renders.
 * Never throws and never returns undefined: a scenario is not worth breaking a
 * list over, and a blank cell reads as a bug rather than as a default.
 */
export function resolveIcon(name: string | undefined): LucideIcon {
  const fallback = ICON_REGISTRY[DEFAULT_ICON_NAME] as LucideIcon;
  const key = name?.trim();
  if (!key) return fallback;
  const direct = ICON_REGISTRY[key];
  if (direct) return direct;
  const legacy = LEGACY_EMOJI_MAP[key];
  if (legacy && ICON_REGISTRY[legacy]) return ICON_REGISTRY[legacy];
  return fallback;
}
