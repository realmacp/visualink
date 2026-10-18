/** "manual": saved offline with a user-provided title and no cover. */
export type CardStatus = "pending" | "ok" | "error" | "manual";
export type Layout = "grid" | "list" | "compact";
export type CollectionId = `col_${string}`;
/** Built-in sections, or a user collection. */
export type Section = "all" | "pinned" | "archive" | CollectionId;
/** "manual" uses the order of the cards array. */
export type SortMode = "manual" | "newest" | "oldest" | "title" | "domain";

/** User-defined group of cards. */
export interface Collection {
  id: CollectionId;
  name: string;
}

export interface LinkCard {
  id: string;
  url: string;
  title: string;
  description: string;
  siteName: string;
  domain: string;
  /** Remote image URL (og:image). */
  image?: string;
  /** Vault path of the cached image. */
  imageLocal?: string;
  favicon?: string;
  faviconLocal?: string;
  tags: string[];
  note: string;
  pinned: boolean;
  archived: boolean;
  collection?: CollectionId;
  status: CardStatus;
  createdAt: number;
  updatedAt: number;
}

import type { LanguageSetting } from "./i18n";

export interface VisualinkSettings {
  language: LanguageSetting;
  assetsFolder: string;
  cacheImages: boolean;
  defaultLayout: Layout;
  sort: SortMode;
  openInNewTab: boolean;
  confirmDelete: boolean;
  showDescriptions: boolean;
  accent: string;
}

export const DEFAULT_SETTINGS: VisualinkSettings = {
  language: "auto",
  assetsFolder: "Visualink/assets",
  cacheImages: true,
  defaultLayout: "grid",
  sort: "manual",
  openInNewTab: true,
  confirmDelete: true,
  showDescriptions: true,
  accent: "",
};

export interface PluginData {
  settings: VisualinkSettings;
  cards: LinkCard[];
  collections: Collection[];
}

export interface FetchedMeta {
  url: string;
  title: string;
  description: string;
  siteName: string;
  image?: string;
  favicon?: string;
}
