import type { IconType } from "react-icons";
import {
  SiTypescript,
  SiJavascript,
  SiReact,
  SiRust,
  SiPython,
  SiHtml5,
  SiCss,
  SiSass,
  SiLess,
  SiPostcss,
  SiTailwindcss,
  SiGo,
  SiRuby,
  SiVuedotjs,
  SiSvelte,
  SiPhp,
  SiSwift,
  SiKotlin,
  SiDocker,
  SiGit,
  SiMarkdown,
  SiJson,
  SiYaml,
  SiToml,
  SiNpm,
  SiGnubash,
  SiCplusplus,
  SiC,
  SiDotnet,
  SiOpenjdk,
  SiClojure,
  SiZig,
  SiLua,
  SiPerl,
  SiScala,
  SiDart,
  SiElixir,
  SiHaskell,
  SiGraphql,
  SiGooglefonts,
} from "react-icons/si";
import { FaJava, FaImage, FaFilePdf, FaFileZipper } from "react-icons/fa6";
import {
  VscFile,
  VscFolder,
  VscFolderOpened,
  VscGear,
  VscLock,
  VscDatabase,
  VscBook,
  VscFileMedia,
} from "react-icons/vsc";

interface Spec {
  Icon: IconType;
  color: string;
}

// Exact filename matches take priority (VS Code does the same).
const BY_NAME: Record<string, Spec> = {
  "package.json": { Icon: SiNpm, color: "#cb3837" },
  "package-lock.json": { Icon: SiNpm, color: "#cb3837" },
  "tsconfig.json": { Icon: SiTypescript, color: "#3178c6" },
  "cargo.toml": { Icon: SiRust, color: "#dea584" },
  "cargo.lock": { Icon: SiRust, color: "#dea584" },
  dockerfile: { Icon: SiDocker, color: "#2496ed" },
  ".gitignore": { Icon: SiGit, color: "#f05133" },
  ".gitattributes": { Icon: SiGit, color: "#f05133" },
  ".gitmodules": { Icon: SiGit, color: "#f05133" },
  "tailwind.config.js": { Icon: SiTailwindcss, color: "#38bdf8" },
  "tailwind.config.ts": { Icon: SiTailwindcss, color: "#38bdf8" },
};

const BY_EXT: Record<string, Spec> = {
  ts: { Icon: SiTypescript, color: "#3178c6" },
  mts: { Icon: SiTypescript, color: "#3178c6" },
  cts: { Icon: SiTypescript, color: "#3178c6" },
  tsx: { Icon: SiReact, color: "#61dafb" },
  js: { Icon: SiJavascript, color: "#f7df1e" },
  mjs: { Icon: SiJavascript, color: "#f7df1e" },
  cjs: { Icon: SiJavascript, color: "#f7df1e" },
  jsx: { Icon: SiReact, color: "#61dafb" },
  json: { Icon: SiJson, color: "#cbcb41" },
  jsonc: { Icon: SiJson, color: "#cbcb41" },
  html: { Icon: SiHtml5, color: "#e34c26" },
  htm: { Icon: SiHtml5, color: "#e34c26" },
  css: { Icon: SiCss, color: "#1572b6" },
  scss: { Icon: SiSass, color: "#cc6699" },
  sass: { Icon: SiSass, color: "#cc6699" },
  less: { Icon: SiLess, color: "#1d365d" },
  pcss: { Icon: SiPostcss, color: "#dd3a0a" },
  md: { Icon: SiMarkdown, color: "#9399b2" },
  markdown: { Icon: SiMarkdown, color: "#9399b2" },
  mdx: { Icon: SiMarkdown, color: "#9399b2" },
  rs: { Icon: SiRust, color: "#dea584" },
  py: { Icon: SiPython, color: "#3776ab" },
  pyw: { Icon: SiPython, color: "#3776ab" },
  go: { Icon: SiGo, color: "#00add8" },
  rb: { Icon: SiRuby, color: "#cc342d" },
  vue: { Icon: SiVuedotjs, color: "#42b883" },
  svelte: { Icon: SiSvelte, color: "#ff3e00" },
  php: { Icon: SiPhp, color: "#777bb4" },
  swift: { Icon: SiSwift, color: "#f05138" },
  kt: { Icon: SiKotlin, color: "#7f52ff" },
  kts: { Icon: SiKotlin, color: "#7f52ff" },
  java: { Icon: FaJava, color: "#f89820" },
  jar: { Icon: SiOpenjdk, color: "#f89820" },
  c: { Icon: SiC, color: "#5586a4" },
  h: { Icon: SiC, color: "#5586a4" },
  cpp: { Icon: SiCplusplus, color: "#00599c" },
  cc: { Icon: SiCplusplus, color: "#00599c" },
  cxx: { Icon: SiCplusplus, color: "#00599c" },
  hpp: { Icon: SiCplusplus, color: "#00599c" },
  cs: { Icon: SiDotnet, color: "#512bd4" },
  clj: { Icon: SiClojure, color: "#5881d8" },
  zig: { Icon: SiZig, color: "#f7a41d" },
  lua: { Icon: SiLua, color: "#2c2d72" },
  pl: { Icon: SiPerl, color: "#39457e" },
  scala: { Icon: SiScala, color: "#dc322f" },
  dart: { Icon: SiDart, color: "#0175c2" },
  ex: { Icon: SiElixir, color: "#4b275f" },
  exs: { Icon: SiElixir, color: "#4b275f" },
  hs: { Icon: SiHaskell, color: "#5e5086" },
  graphql: { Icon: SiGraphql, color: "#e10098" },
  gql: { Icon: SiGraphql, color: "#e10098" },
  sh: { Icon: SiGnubash, color: "#4eaa25" },
  bash: { Icon: SiGnubash, color: "#4eaa25" },
  zsh: { Icon: SiGnubash, color: "#4eaa25" },
  fish: { Icon: SiGnubash, color: "#4eaa25" },
  yaml: { Icon: SiYaml, color: "#cb171e" },
  yml: { Icon: SiYaml, color: "#cb171e" },
  toml: { Icon: SiToml, color: "#9c4221" },
  png: { Icon: FaImage, color: "#a6e3a1" },
  jpg: { Icon: FaImage, color: "#a6e3a1" },
  jpeg: { Icon: FaImage, color: "#a6e3a1" },
  gif: { Icon: FaImage, color: "#a6e3a1" },
  webp: { Icon: FaImage, color: "#a6e3a1" },
  bmp: { Icon: FaImage, color: "#a6e3a1" },
  ico: { Icon: VscFileMedia, color: "#a6e3a1" },
  svg: { Icon: VscFileMedia, color: "#ffb86c" },
  pdf: { Icon: FaFilePdf, color: "#f38ba8" },
  zip: { Icon: FaFileZipper, color: "#f9e2af" },
  tar: { Icon: FaFileZipper, color: "#f9e2af" },
  gz: { Icon: FaFileZipper, color: "#f9e2af" },
  tgz: { Icon: FaFileZipper, color: "#f9e2af" },
  bz2: { Icon: FaFileZipper, color: "#f9e2af" },
  xz: { Icon: FaFileZipper, color: "#f9e2af" },
  "7z": { Icon: FaFileZipper, color: "#f9e2af" },
  rar: { Icon: FaFileZipper, color: "#f9e2af" },
  ttf: { Icon: SiGooglefonts, color: "#ea4335" },
  otf: { Icon: SiGooglefonts, color: "#ea4335" },
  woff: { Icon: SiGooglefonts, color: "#ea4335" },
  woff2: { Icon: SiGooglefonts, color: "#ea4335" },
  db: { Icon: VscDatabase, color: "#cdd6f4" },
  sqlite: { Icon: VscDatabase, color: "#cdd6f4" },
  sql: { Icon: VscDatabase, color: "#cdd6f4" },
  lock: { Icon: VscLock, color: "#9399b2" },
};

const DEFAULT: Spec = { Icon: VscFile, color: "#9399b2" };

function specFor(name: string): Spec {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  // README, LICENSE, CHANGELOG → book.
  if (/^(readme|license|licence|changelog|contributing)/.test(lower)) {
    return { Icon: VscBook, color: "#89b4fa" };
  }
  // Dotfiles like .env, .babelrc → gear.
  const dot = lower.startsWith(".");
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (BY_EXT[ext]) return BY_EXT[ext];
  if (dot) return { Icon: VscGear, color: "#9399b2" };
  return DEFAULT;
}

/** VS Code-style colored icon for a file or folder. */
export function FileIcon({
  name,
  isDir,
  open,
}: {
  name: string;
  isDir: boolean;
  open?: boolean;
}) {
  if (isDir) {
    const Icon = open ? VscFolderOpened : VscFolder;
    // currentColor → inherits the themed accent set on .fb-icon.
    return <Icon color="currentColor" />;
  }
  const { Icon, color } = specFor(name);
  return <Icon color={color} />;
}
