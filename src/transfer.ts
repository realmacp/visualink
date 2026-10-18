import { Platform, normalizePath } from "obsidian";
import type VisualinkPlugin from "./main";
import { CardStatus, Collection, CollectionId, LinkCard } from "./types";
import { domainOf, normalizeUrl } from "./metadata";

export const EXPORT_FORMAT = "visualink-export";
export const EXPORT_VERSION = 1;

/** Card fields that travel between vaults. Cached image paths are vault-specific and stay behind. */
type ExportedCard = Omit<LinkCard, "id" | "imageLocal" | "faviconLocal" | "collection"> & { collection?: string };

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  collections: string[];
  cards: ExportedCard[];
}

export interface ImportPlan {
  cards: ExportedCard[];
  newCollections: string[];
  skipped: number;
}

export class ImportError extends Error {
  constructor(readonly reason: "invalid" | "newer") {
    super(reason);
  }
}

/** Builds the export for every card, or for a single collection. */
export function buildExport(plugin: VisualinkPlugin, collection?: CollectionId): ExportFile {
  const cards = collection ? plugin.cards.filter((c) => c.collection === collection) : plugin.cards;
  const names = new Map(plugin.collections.map((c) => [c.id, c.name]));
  const used = new Set(cards.map((c) => c.collection).filter((id): id is CollectionId => !!id));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    collections: plugin.collections.filter((c) => used.has(c.id)).map((c) => c.name),
    cards: cards.map((c) => toExported(c, c.collection ? names.get(c.collection) : undefined)),
  };
}

function toExported(c: LinkCard, collection: string | undefined): ExportedCard {
  return {
    url: c.url,
    title: c.title,
    description: c.description,
    siteName: c.siteName,
    domain: c.domain,
    image: c.image,
    favicon: c.favicon,
    tags: c.tags,
    note: c.note,
    pinned: c.pinned,
    archived: c.archived,
    collection,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

interface SaveFileHandle {
  name: string;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

type SaveFilePicker = (options: {
  suggestedName: string;
  startIn?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<SaveFileHandle>;

/**
 * Saves the export outside the vault on desktop: a save dialog that opens in Downloads, or a plain
 * download where the dialog isn't available. On mobile the file goes into the vault.
 * Resolves with the saved file's name or path, or null if the user cancelled.
 */
export async function saveExport(plugin: VisualinkPlugin, data: ExportFile, label: string): Promise<string | null> {
  const json = JSON.stringify(data, null, 2);
  const fileName = `${label} ${new Date().toISOString().slice(0, 10)}.json`;
  if (!Platform.isDesktopApp) return writeToVault(plugin, json, fileName);

  const win = activeWindow as unknown as { showSaveFilePicker?: SaveFilePicker };
  if (win.showSaveFilePicker) {
    try {
      const handle = await win.showSaveFilePicker({
        suggestedName: fileName,
        startIn: "downloads",
        types: [{ description: "Visualink export", accept: { "application/json": [".json"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return handle.name;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return null;
    }
  }
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  createEl("a", { attr: { href: url, download: fileName } }).click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return fileName;
}

async function writeToVault(plugin: VisualinkPlugin, json: string, fileName: string): Promise<string> {
  const folder = "Visualink";
  await plugin.ensureFolder(folder);
  const base = normalizePath(`${folder}/${fileName.replace(/\.json$/, "")}`);
  let path = `${base}.json`;
  for (let i = 2; plugin.app.vault.getAbstractFileByPath(path); i++) path = `${base} (${i}).json`;
  await plugin.app.vault.create(path, json);
  return path;
}

/** Opens the system file picker and resolves with the chosen file's text, or null if cancelled. */
export function pickFile(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = createEl("input", { type: "file", attr: { accept: ".json,application/json" } });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      file.text().then(resolve, () => resolve(null));
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

const STATUSES: CardStatus[] = ["pending", "ok", "error", "manual"];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const time = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Date.now());

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Validates one card from a file. Returns null for entries without a usable URL. */
function readCard(raw: unknown): ExportedCard | null {
  if (!isRecord(raw)) return null;
  const url = normalizeUrl(str(raw.url));
  if (!url) return null;
  const status = STATUSES.find((s) => s === raw.status) ?? "pending";
  return {
    url,
    title: str(raw.title) || domainOf(url),
    description: str(raw.description),
    siteName: str(raw.siteName),
    domain: domainOf(url),
    image: optStr(raw.image),
    favicon: optStr(raw.favicon),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string" && !!t.trim()) : [],
    note: str(raw.note),
    pinned: raw.pinned === true,
    archived: raw.archived === true,
    collection: optStr(raw.collection)?.trim() || undefined,
    status: status === "error" ? "pending" : status,
    createdAt: time(raw.createdAt),
    updatedAt: time(raw.updatedAt),
  };
}

/** Parses an export file and works out what importing it would add. */
export function planImport(plugin: VisualinkPlugin, text: string): ImportPlan {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ImportError("invalid");
  }
  if (!isRecord(data) || data.format !== EXPORT_FORMAT || !Array.isArray(data.cards)) throw new ImportError("invalid");
  if (typeof data.version !== "number" || data.version > EXPORT_VERSION) throw new ImportError("newer");

  const existing = new Set(plugin.cards.map((c) => c.url));
  const cards: ExportedCard[] = [];
  let skipped = 0;
  for (const raw of data.cards) {
    const card = readCard(raw);
    if (!card) continue;
    if (existing.has(card.url)) skipped++;
    else {
      existing.add(card.url);
      cards.push(card);
    }
  }
  const known = new Set(plugin.collections.map((c) => c.name.toLowerCase()));
  const newCollections = [...new Set(cards.map((c) => c.collection).filter((n): n is string => !!n))].filter(
    (n) => !known.has(n.toLowerCase()),
  );
  return { cards, newCollections, skipped };
}

/** Adds the planned cards after the existing ones, creating missing collections by name. */
export async function applyImport(plugin: VisualinkPlugin, plan: ImportPlan): Promise<LinkCard[]> {
  for (const name of plan.newCollections) await plugin.addCollection(name);
  const byName = new Map<string, Collection>(plugin.collections.map((c) => [c.name.toLowerCase(), c]));
  const added = plan.cards.map((c, i): LinkCard => ({
    ...c,
    id: `${Date.now().toString(36)}${i.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    collection: c.collection ? byName.get(c.collection.toLowerCase())?.id : undefined,
  }));
  plugin.cards.push(...added);
  await plugin.persist();
  return added;
}
