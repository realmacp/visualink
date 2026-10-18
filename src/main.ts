import { Events, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath, MarkdownRenderChild } from "obsidian";
import { Collection, CollectionId, DEFAULT_SETTINGS, LinkCard, PluginData, VisualinkSettings } from "./types";
import { OfflineError, domainOf, downloadImage, extractUrls, fetchMetadata, normalizeUrl, suggestTitle } from "./metadata";
import { RIBBON_ICON, VIEW_TYPE_VISUALINK, VisualinkView, renderCard } from "./view";
import { AddLinkModal, ImportModal, OfflineTitleModal } from "./modals";
import { ImportError, ImportPlan, applyImport, buildExport, pickFile, planImport, saveExport } from "./transfer";
import { VisualinkSettingTab } from "./settings";
import { LanguageSetting, setLanguage, t } from "./i18n";

export default class VisualinkPlugin extends Plugin {
  settings: VisualinkSettings = { ...DEFAULT_SETTINGS };
  cards: LinkCard[] = [];
  collections: Collection[] = [];
  events = new Events();
  private inflight = new Set<string>();
  private ribbonEl: HTMLElement | null = null;
  private settingTab: VisualinkSettingTab | null = null;

  async onload() {
    await this.loadAll();
    setLanguage(this.settings.language);

    this.registerView(VIEW_TYPE_VISUALINK, (leaf) => new VisualinkView(leaf, this));

    this.ribbonEl = this.addRibbonIcon(RIBBON_ICON, t("ribbon.open"), () => void this.activateView());
    this.registerCommands();

    // obsidian://visualink?url=https://...
    this.registerObsidianProtocolHandler("visualink", async (params) => {
      const url = params.url ? normalizeUrl(params.url) : null;
      if (!url) return new Notice(t("notice.invalidLink"));
      await this.addUrls([url], params.tags ? params.tags.split(",") : []);
      await this.activateView();
    });

    this.registerMarkdownCodeBlockProcessor("visualink", (source, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      ctx.addChild(child);
      const draw = () => {
        el.empty();
        const wrap = el.createDiv({ cls: "visualink-embed visualink-grid" });
        const cards = this.queryForBlock(source);
        if (!cards.length) wrap.createDiv({ cls: "vl-empty-mini", text: t("embed.empty") });
        for (const c of cards) renderCard(wrap, c, this, { compactActions: true });
      };
      draw();
      const ref = this.events.on("changed", draw);
      child.register(() => this.events.offref(ref));
    });

    this.settingTab = new VisualinkSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    this.registerDomEvent(window, "online", () => this.retryPending(false));
    this.app.workspace.onLayoutReady(() => this.retryPending(false));
  }

  onunload() {}

  private registerCommands() {
    this.addCommand({ id: "open", name: t("cmd.open"), callback: () => void this.activateView() });
    this.addCommand({ id: "add-link", name: t("cmd.addLink"), callback: () => new AddLinkModal(this.app, this).open() });
    this.addCommand({
      id: "add-from-clipboard",
      name: t("cmd.addFromClipboard"),
      callback: async () => {
        const text = await navigator.clipboard.readText().catch(() => "");
        const urls = extractUrls(text);
        if (!urls.length) return new Notice(t("notice.noClipboardLink"));
        await this.addUrls(urls);
      },
    });
    this.addCommand({ id: "refetch-failed", name: t("cmd.retryFailed"), callback: () => this.retryPending(true) });
    this.addCommand({ id: "export-links", name: t("cmd.export"), callback: () => void this.exportLinks() });
    this.addCommand({ id: "import-links", name: t("cmd.import"), callback: () => void this.importLinks() });
  }

  async changeLanguage(lang: LanguageSetting) {
    this.settings.language = lang;
    await this.saveSettings();
    this.applyLanguage();
    this.settingTab?.update();
  }

  /** Switches the UI language live: commands, ribbon tooltip, open views and embedded blocks. */
  applyLanguage() {
    setLanguage(this.settings.language);
    for (const id of ["open", "add-link", "add-from-clipboard", "refetch-failed", "export-links", "import-links"]) this.removeCommand(id);
    this.registerCommands();
    this.ribbonEl?.setAttr("aria-label", t("ribbon.open"));
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_VISUALINK)) {
      if (leaf.view instanceof VisualinkView) leaf.view.buildUi();
    }
    this.events.trigger("changed");
  }

  async loadAll() {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.collections = data.collections ?? [];
    const known = new Set(this.collections.map((c) => c.id));
    this.cards = (data.cards ?? []).map((c) => ({
      ...c,
      tags: c.tags ?? [],
      note: c.note ?? "",
      pinned: !!c.pinned,
      archived: !!c.archived,
      collection: c.collection && known.has(c.collection) ? c.collection : undefined,
    }));
  }

  async persist() {
    await this.saveData({ settings: this.settings, cards: this.cards, collections: this.collections } satisfies PluginData);
    this.events.trigger("changed");
  }

  async saveSettings() {
    await this.persist();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_VISUALINK)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_VISUALINK, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  getCard(id: string) {
    return this.cards.find((c) => c.id === id);
  }

  async addUrls(urls: string[], tags: string[] = [], collection?: CollectionId): Promise<LinkCard[]> {
    const added: LinkCard[] = [];
    const offline = !navigator.onLine;
    for (const url of urls) {
      const existing = this.cards.find((c) => c.url === url);
      if (existing) {
        existing.archived = false;
        existing.updatedAt = Date.now();
        new Notice(t("notice.alreadySaved", { title: existing.title || existing.domain }));
        continue;
      }
      // Offline: ask for a title; the card is saved without a cover.
      let title = domainOf(url);
      if (offline) title = await new OfflineTitleModal(this.app, url, suggestTitle(url)).ask();
      const now = Date.now();
      const card: LinkCard = {
        id: now.toString(36) + Math.random().toString(36).slice(2, 7),
        url,
        title,
        description: "",
        siteName: "",
        domain: domainOf(url),
        tags: tags.map((t) => t.trim().replace(/^#/, "")).filter(Boolean),
        note: "",
        pinned: false,
        archived: false,
        collection,
        status: offline ? "manual" : "pending",
        createdAt: now,
        updatedAt: now,
      };
      this.cards.unshift(card);
      added.push(card);
    }
    await this.persist();
    if (offline) {
      if (added.length) new Notice(added.length === 1 ? t("notice.savedOffline") : t("notice.savedOfflineMany", { n: added.length }));
    } else {
      // Metadata is fetched in the background so the card appears immediately.
      for (const c of added) void this.enrich(c.id, { justAdded: true });
    }
    return added;
  }

  async updateCard(id: string, patch: Partial<LinkCard>) {
    const c = this.getCard(id);
    if (!c) return;
    Object.assign(c, patch, { updatedAt: Date.now() });
    await this.persist();
  }

  /** Moves a card before or after another one. The custom order is the order of `cards`. */
  async moveCard(id: string, targetId: string, place: "before" | "after") {
    const from = this.cards.findIndex((c) => c.id === id);
    if (from < 0 || id === targetId) return;
    const [card] = this.cards.splice(from, 1);
    const to = this.cards.findIndex((c) => c.id === targetId);
    this.cards.splice(to < 0 ? this.cards.length : place === "before" ? to : to + 1, 0, card);
    this.settings.sort = "manual";
    await this.persist();
  }

  /** Swaps the positions of two cards. */
  async swapCards(id: string, otherId: string) {
    const a = this.cards.findIndex((c) => c.id === id);
    const b = this.cards.findIndex((c) => c.id === otherId);
    if (a < 0 || b < 0 || a === b) return;
    [this.cards[a], this.cards[b]] = [this.cards[b], this.cards[a]];
    this.settings.sort = "manual";
    await this.persist();
  }

  getCollection(id: string | undefined) {
    return this.collections.find((c) => c.id === id);
  }

  async addCollection(name: string): Promise<Collection> {
    const col: Collection = { id: `col_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name };
    this.collections.push(col);
    await this.persist();
    return col;
  }

  async renameCollection(id: CollectionId, name: string) {
    const col = this.getCollection(id);
    if (!col) return;
    col.name = name;
    await this.persist();
  }

  /** Removes a collection. Its cards are kept and return to My list. */
  async deleteCollection(id: CollectionId) {
    this.collections = this.collections.filter((c) => c.id !== id);
    for (const c of this.cards) if (c.collection === id) c.collection = undefined;
    await this.persist();
  }

  // Export and import

  /** Saves all links, or one collection, as a JSON file. */
  async exportLinks(collection?: CollectionId) {
    const data = buildExport(this, collection);
    if (!data.cards.length) {
      new Notice(t("transfer.empty"));
      return;
    }
    const name = collection ? this.getCollection(collection)?.name.replace(/[\\/:*?"<>|]/g, "-") : undefined;
    const saved = await saveExport(this, data, name ? `Visualink - ${name}` : "Visualink export");
    if (saved) new Notice(t("notice.exported", { path: saved }));
  }

  /** Lets the user pick an export file, shows a summary and adds the new links. */
  async importLinks() {
    const text = await pickFile();
    if (text === null) return;
    let plan: ImportPlan;
    try {
      plan = planImport(this, text);
    } catch (e) {
      new Notice(e instanceof ImportError && e.reason === "newer" ? t("transfer.newer") : t("transfer.invalid"));
      return;
    }
    if (!plan.cards.length) {
      new Notice(t("transfer.nothing"));
      return;
    }
    new ImportModal(this.app, plan, async () => {
      const added = await applyImport(this, plan);
      new Notice(t("transfer.imported", { n: added.length }));
      void this.completeImported(added);
    }).open();
  }

  /** Fetches missing metadata and caches covers for imported cards in the background. */
  private async completeImported(cards: LinkCard[]) {
    if (!navigator.onLine) return;
    for (const c of cards) {
      if (c.status === "pending") await this.enrich(c.id);
      else if (this.settings.cacheImages && (c.image || c.favicon)) await this.cacheAssets(c);
    }
    await this.persist();
  }

  async deleteCard(id: string) {
    const c = this.getCard(id);
    if (!c) return;
    for (const p of [c.imageLocal, c.faviconLocal]) {
      const f = p ? this.app.vault.getFileByPath(p) : null;
      if (f) await this.app.fileManager.trashFile(f).catch(() => {});
    }
    this.cards = this.cards.filter((x) => x.id !== id);
    await this.persist();
  }

  /**
   * Fetches metadata for a card.
   * - force: also replaces the title.
   * - justAdded: if the network turns out to be unavailable, asks for a title.
   */
  async enrich(id: string, opts: { force?: boolean; justAdded?: boolean } = {}) {
    const card = this.getCard(id);
    if (!card || this.inflight.has(id)) return;
    const prevStatus = card.status;
    if (!navigator.onLine) {
      if (card.status === "pending") card.status = "manual";
      await this.persist();
      return;
    }
    this.inflight.add(id);
    try {
      const meta = await fetchMetadata(card.url);
      // Keep titles the user entered (offline or edited) unless forced.
      const userTitle = prevStatus === "manual" || (prevStatus === "ok" && card.title !== card.domain);
      const keepTitle = !opts.force && userTitle;
      card.title = keepTitle ? card.title : meta.title || card.domain;
      card.description = meta.description;
      card.siteName = meta.siteName;
      card.image = meta.image;
      card.favicon = meta.favicon;
      card.status = "ok";
      if (this.settings.cacheImages) await this.cacheAssets(card);
    } catch (e) {
      if (e instanceof OfflineError) {
        // navigator.onLine can report true without a working connection.
        card.status = "manual";
        if (opts.justAdded) {
          this.inflight.delete(id);
          card.title = await new OfflineTitleModal(this.app, card.url, suggestTitle(card.url)).ask();
        }
      } else card.status = prevStatus === "manual" ? "manual" : "error";
    } finally {
      card.updatedAt = Date.now();
      this.inflight.delete(id);
      await this.persist();
    }
  }

  /** Stores the cover and favicon in the vault for offline use. */
  async cacheAssets(card: LinkCard) {
    const folder = normalizePath(this.settings.assetsFolder || DEFAULT_SETTINGS.assetsFolder);
    await this.ensureFolder(folder);
    const save = async (remote: string | undefined, suffix: string): Promise<string | undefined> => {
      if (!remote) return undefined;
      const img = await downloadImage(remote);
      if (!img) return undefined;
      const path = normalizePath(`${folder}/${card.id}${suffix}.${img.ext}`);
      const existing = this.app.vault.getFileByPath(path);
      if (existing) await this.app.vault.modifyBinary(existing, img.data);
      else await this.app.vault.createBinary(path, img.data);
      return path;
    };
    card.imageLocal = (await save(card.image, "")) ?? card.imageLocal;
    card.faviconLocal = (await save(card.favicon, "-icon")) ?? card.faviconLocal;
  }

  async ensureFolder(path: string) {
    const parts = path.split("/");
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur).catch(() => {});
    }
  }

  async retryPending(includeErrors: boolean) {
    const todo = this.cards.filter((c) => c.status === "pending" || (includeErrors && c.status === "error"));
    if (!todo.length) {
      if (includeErrors) new Notice(t("notice.noPending"));
      return;
    }
    for (const c of todo) await this.enrich(c.id);
  }

  /** Resource URL for an image: the local copy if present, otherwise the remote one. */
  resource(local?: string, remote?: string): string | undefined {
    const f = local ? this.app.vault.getFileByPath(local) : null;
    if (f instanceof TFile) return this.app.vault.getResourcePath(f);
    if (remote && navigator.onLine) return remote;
    return undefined;
  }

  allTags(): string[] {
    const s = new Set<string>();
    this.cards.forEach((c) => c.tags.forEach((t) => s.add(t)));
    return [...s].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Code block syntax:
   *   collection: Work
   *   tag: reading
   *   search: design
   *   pinned
   *   limit: 6
   *   https://example.com/article
   */
  queryForBlock(source: string): LinkCard[] {
    const lines = source.split("\n").map((l) => l.trim()).filter(Boolean);
    const urls = lines.filter((l) => /^https?:\/\//i.test(l)).map((l) => normalizeUrl(l)).filter((u): u is string => !!u);
    if (urls.length) return urls.map((u) => this.cards.find((c) => c.url === u)).filter((c): c is LinkCard => !!c);
    let res = this.cards.filter((c) => !c.archived);
    let limit = 0;
    for (const l of lines) {
      const [k, ...rest] = l.split(":");
      const v = rest.join(":").trim().toLowerCase();
      switch (k.trim().toLowerCase()) {
        case "tag":
          res = res.filter((c) => c.tags.some((t) => t.toLowerCase() === v.replace(/^#/, "")));
          break;
        case "search":
          res = res.filter((c) => `${c.title} ${c.description} ${c.domain}`.toLowerCase().includes(v));
          break;
        case "collection":
          res = res.filter((c) => this.getCollection(c.collection)?.name.toLowerCase() === v);
          break;
        case "domain":
          res = res.filter((c) => c.domain.includes(v));
          break;
        case "pinned":
          res = res.filter((c) => c.pinned);
          break;
        case "limit":
          limit = parseInt(v) || 0;
          break;
      }
    }
    return limit ? res.slice(0, limit) : res;
  }
}
