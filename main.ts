import {
  App,
  debounce,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  TextComponent,
  ToggleComponent,
} from "obsidian";

enum FolderNoteType {
  InsideFolder = "INSIDE_FOLDER",
  OutsideFolder = "OUTSIDE_FOLDER",
}

enum SortType {
  Priority = "PRIORITY",
  Natural = "NATURAL",
  Lexicographic = "LEXICOGRAPHIC",
  FoldersFirst = "FOLDERS_FIRST",
}

interface WaypointSettings {
  waypointFlag: string;
  stopScanAtFolderNotes: boolean;
  showFolderNotes: boolean;
  showNonMarkdownFiles: boolean;
  debugLogging: boolean;
  useWikiLinks: boolean;
  showEnclosingNote: boolean;
  folderNoteType: string;
  waypointPriorityKey: string;
  sortType: string;
  useSpaces: boolean;
  numSpaces: number;
  ignoredFolders: string[];
  root: string;
}

const DEFAULT_SETTINGS: WaypointSettings = {
  waypointFlag: "%% Waypoint %%",
  stopScanAtFolderNotes: false,
  showFolderNotes: false,
  showNonMarkdownFiles: false,
  debugLogging: false,
  useWikiLinks: true,
  showEnclosingNote: false,
  folderNoteType: FolderNoteType.InsideFolder,
  waypointPriorityKey: "waypointPriority",
  sortType: SortType.Natural,
  useSpaces: false,
  numSpaces: 2,
  ignoredFolders: ["Templates"],
  root: null,
};

function sortWithNaturalOrder(a: TAbstractFile, b: TAbstractFile): number {
  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function sortFoldersFirst(a: TAbstractFile, b: TAbstractFile): number {
  if (a instanceof TFolder) {
    // when b is also a folder, sort normally, otherwise a (the folder) comes first
    return b instanceof TFolder ? sortWithNaturalOrder(a, b) : -1;
  }
  // a is a file. When b is a folder, it comes first, otherwise sort both files normally
  return b instanceof TFolder ? 1 : sortWithNaturalOrder(a, b);
}

export default class Waypoint extends Plugin {
  static readonly BEGIN_WAYPOINT = "%% Begin Waypoint %%";
  static readonly END_WAYPOINT = "%% End Waypoint %%";

  foldersWithChanges = new Set<TFolder>();
  settings: WaypointSettings;

  async onload() {
    await this.loadSettings();
    this.app.workspace.onLayoutReady(async () => {
      // Register events after layout is built to avoid initial wave of 'create' events
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          this.log("create " + file.name);
          this.foldersWithChanges.add(file.parent);
          this.scheduleUpdate();
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          this.log("delete " + file.name);
          const parentFolder = this.getParentFolder(file.path);
          if (parentFolder !== null) {
            this.foldersWithChanges.add(parentFolder);
            this.scheduleUpdate();
          }
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.log("rename " + file.name);
          this.foldersWithChanges.add(file.parent);
          const parentFolder = this.getParentFolder(oldPath);
          if (parentFolder !== null) {
            this.foldersWithChanges.add(parentFolder);
          }
          this.scheduleUpdate();
        })
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          this.log("modify " + file.name);
          this.foldersWithChanges.add(file.parent);
          this.scheduleUpdate();
          this.detectWaypointFlag(file as TFile);
        })
      );
    });

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new WaypointSettingsTab(this.app, this));

    // Add in a hotkey to update the waypoint
    this.addCommand({
      id: "update-waypoint",
      name: "Update waypoint in current file",
      hotkeys: [
        {
          modifiers: ["Ctrl"],
          key: "w",
        },
      ],
      callback: () => {
        this.updateWaypoint(this.app.workspace.getActiveFile());
      },
    });
  }

  onunload() {}

  /**
   * Scan the given file for the waypoint flag. If found, update the waypoint.
   * @param file The file to scan
   */
  async detectWaypointFlag(file: TFile): Promise<void> {
    this.log("Modification on " + file.name);
    this.log("Scanning for Waypoint flags...");
    const text = await this.app.vault.cachedRead(file);

    const lines: string[] = text.split("\n");
    for (const line of lines) {
      if (line.trim() === this.settings.waypointFlag) {
        if (this.isFolderNote(file)) {
          this.log("Found waypoint flag in folder note!");
          await this.updateWaypoint(file);
          await this.updateAncestorWaypoint(file.parent, this.settings.folderNoteType === FolderNoteType.OutsideFolder);
          return;
        } else if (file.parent.isRoot()) {
          this.log("Found waypoint flag in root folder.");
          this.settings.root = file.name;
          await this.saveSettings();
          await this.updateWaypoint(file);
          return;
        } else {
          this.log("Found waypoint flag in invalid note.");
          this.printWaypointError(
            file,
            `%% Error: Cannot create a waypoint in a note that's not the folder note. For more information, check the instructions [here](https://github.com/IdreesInc/Waypoint) %%`
          );
          return;
        }
      }
    }
    this.log("No waypoint flags found.");
  }

  isFolderNote(file: TFile): boolean {
    if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
      return file.basename == file.parent.name;
    } else if (this.settings.folderNoteType === FolderNoteType.OutsideFolder && file.parent) {
      return this.getFolderForFile(file) instanceof TFolder;
    }
    return false;
  }

  getFolderForFile(file: TFile): TAbstractFile {
    return this.app.vault.getAbstractFileByPath(this.getCleanParentPath(file) + file.basename);
  }

  getFolderNoteForFolder(folder: TAbstractFile): TAbstractFile {
    if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
      return this.app.vault.getAbstractFileByPath(folder.path + "/" + folder.name + ".md");
    } else if (this.settings.folderNoteType === FolderNoteType.OutsideFolder && folder.parent) {
      return this.app.vault.getAbstractFileByPath(this.getCleanParentPath(folder) + folder.name + ".md");
    }
    return null;
  }


  getCleanParentPath(node: TAbstractFile): string {
    if (node.parent instanceof TFolder && node.parent.isRoot()) {
      return "";
    } else {
      return node.parent.path + "/";
    }
  }

  async printWaypointError(file: TFile, error: string) {
    this.log("Creating waypoint error in " + file.path);
    const text = await this.app.vault.read(file);
    let waypointIndex = -1;
    const lines: string[] = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === this.settings.waypointFlag) {
        waypointIndex = i;
      }
    }
    if (waypointIndex === -1) {
      console.error("Error: No waypoint flag found while trying to print error.");
      return;
    }
    lines.splice(waypointIndex, 1, error);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  /**
   * Given a file with a waypoint flag, generate a file tree representation and update the waypoint text.
   * @param file The file to update
   */
  async updateWaypoint(file: TFile): Promise<void> {
    this.log("Updating waypoint in " + file.path);

    let folder;
    if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
      folder = file.parent;
    } else if (this.settings.folderNoteType === FolderNoteType.OutsideFolder) {
      folder = this.getFolderForFile(file);
    }

    let fileTree;
    if (folder instanceof TFolder) {
      fileTree = await this.getFileTreeRepresentation(file.parent, folder, 0, true);
    }

    if (file.parent.isRoot()) {
      const splitFileTree = fileTree.split("\n");
      fileTree = `- **[[${file.basename}]]**\n${splitFileTree.slice(1).join("\n")}`;
    }

    const waypoint = `${Waypoint.BEGIN_WAYPOINT}\n${fileTree}\n${Waypoint.END_WAYPOINT}`;
    const text = await this.app.vault.read(file);

    const lines: string[] = text.split("\n");
    let waypointStart = -1;
    let waypointEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (waypointStart === -1 && (trimmed === this.settings.waypointFlag || trimmed === Waypoint.BEGIN_WAYPOINT)) {
        waypointStart = i;
      } else if (waypointStart !== -1 && trimmed === Waypoint.END_WAYPOINT) {
        waypointEnd = i;
        break;
      }
    }
    if (waypointStart === -1) {
      console.error("Error: No waypoint found while trying to update " + file.path);
      return;
    }

    this.log("Waypoint found at " + waypointStart + " to " + waypointEnd);

    // Get the current waypoint block from lines and join it to form a string
    const currentWaypoint = waypointEnd !== -1
      ? lines.slice(waypointStart, waypointEnd + 1).join("\n")
      : lines[waypointStart];

    // Only splice and modify if waypoint differs from the current block
    if (currentWaypoint !== waypoint) {
      this.log("Waypoint content changed, updating");
      lines.splice(waypointStart, waypointEnd !== -1 ? waypointEnd - waypointStart + 1 : 1, waypoint);
      await this.app.vault.modify(file, lines.join("\n"));
    }
  }

  /**
   * Generate a file tree representation of the given folder.
   * @param rootNode The root of the file tree that will be generated
   * @param node The current node in our recursive descent
   * @param indentLevel How many levels of indentation to draw
   * @param topLevel Whether this is the top level of the tree or not
   * @returns The string representation of the tree, or null if the node is not a file or folder
   */
  async getFileTreeRepresentation(
    rootNode: TFolder,
    node: TAbstractFile,
    indentLevel: number,
    topLevel = false
  ): Promise<string> | null {
    const indent = this.settings.useSpaces ? " ".repeat(this.settings.numSpaces) : "	";
    const bullet = indent.repeat(indentLevel) + "-";
    if (node instanceof TFile) {
      this.log(node);
      // Print the file name
      // Check for the parent being the root because otherwise the "root note" would be included in the tree
      if (node.extension == "md" && !node.parent.isRoot()) {
        if (this.settings.useWikiLinks) {
          return `${bullet} [[${node.basename}]]`;
        } else {
          return `${bullet} [${node.basename}](${this.getEncodedUri(rootNode, node)})`;
        }
      } else if (this.settings.showNonMarkdownFiles) {
        if (this.settings.useWikiLinks) {
          return `${bullet} [[${node.name}]]`;
        } else {
          return `${bullet} [${node.name}](${this.getEncodedUri(rootNode, node)})`;
        }
      }
      return null;
    } else if (node instanceof TFolder) {
      if (this.settings.ignoredFolders.includes(node.path)) {
        return null;
      }
      let text = "";
      if (!topLevel || this.settings.showEnclosingNote) {
        // Print the folder name
        text = `${bullet} **${node.name}**`;
        let folderNote;
        if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
          folderNote = this.app.vault.getAbstractFileByPath(node.path + "/" + node.name + ".md");
        } else if (this.settings.folderNoteType === FolderNoteType.OutsideFolder) {
          if (node.parent) {
            folderNote = this.app.vault.getAbstractFileByPath(node.parent.path + "/" + node.name + ".md");
          }
        }
        if (folderNote instanceof TFile) {
          if (this.settings.useWikiLinks) {
            text = `${bullet} **[[${folderNote.basename}]]**`;
          } else {
            text = `${bullet} **[${folderNote.basename}](${this.getEncodedUri(rootNode, folderNote)})**`;
          }
          if (!topLevel) {
            if (this.settings.stopScanAtFolderNotes) {
              return text;
            } else {
              const content = await this.app.vault.cachedRead(folderNote);
              if (content.includes(Waypoint.BEGIN_WAYPOINT) || content.includes(this.settings.waypointFlag)) {
                return text;
              }
            }
          }
        }
      }
      if (node.children && node.children.length > 0) {
        // Print the files and nested folders within the folder
        let children = node.children;

        switch (this.settings.sortType) {
          case SortType.Lexicographic:
            children = children.sort();
            break;
          case SortType.Priority:
            children = children.sort(this.sortWithPriority);
            break;
          case SortType.FoldersFirst:
            children = children.sort(sortFoldersFirst);
            break;
          default:
            children = children.sort(sortWithNaturalOrder);
            break;
        }

        if (!this.settings.showFolderNotes) {
          if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
            children = children.filter((child) => this.settings.showFolderNotes || child.name !== node.name + ".md");
          } else if (this.settings.folderNoteType === FolderNoteType.OutsideFolder) {
            const folderNames = new Set();
            for (const element of children) {
              if (element instanceof TFolder) {
                folderNames.add(element.name + ".md");
              }
            }
            children = children.filter((child) => child instanceof TFolder || !folderNames.has(child.name));
          }
        }

        if (children.length > 0) {
          const nextIndentLevel = topLevel && !this.settings.showEnclosingNote ? indentLevel : indentLevel + 1;
          text +=
            (text === "" ? "" : "\n") +
            (
              await Promise.all(
                children.map((child) => this.getFileTreeRepresentation(rootNode, child, nextIndentLevel))
              )
            )
              .filter(Boolean)
              .join("\n");
        }
        return text;
      } else {
        return `${bullet} **${node.name}**`;
      }
    }
    return null;
  }

  /**
   * Generate an encoded URI path to the given file that is relative to the given root.
   * @param rootNode The from which the relative path will be generated
   * @param node The node to which the path will be generated
   * @returns The encoded path
   */
  getEncodedUri(rootNode: TFolder, node: TAbstractFile) {
    if (rootNode.isRoot()) {
      return `./${encodeURI(node.path)}`;
    }
    return `./${encodeURI(node.path.substring(rootNode.path.length + 1))}`;
  }

  /**
   * Scan the changed folders and their ancestors for waypoints and update them if found.
   */
  async updateChangedFolders() {
    this.log("Updating changed folders...");
    this.foldersWithChanges.forEach((folder) => {
      this.log("Updating " + folder.path);
      this.updateAncestorWaypoint(folder, true);
    });
    this.foldersWithChanges.clear();
  }

  /**
   * Schedule an update for the changed folders after debouncing to prevent excessive updates.
   */
  scheduleUpdate = debounce(this.updateChangedFolders.bind(this), 500, true);

  /**
   * Update all ancestor waypoints (if any) of the given file/folder.
   * @param node The node to start the search from
   * @param includeCurrentNode Whether to include the given folder in the search
   */
  async updateAncestorWaypoint(node: TAbstractFile, includeCurrentNode: boolean): Promise<void> {
    const parentWaypoint = await this.locateParentWaypoint(node, includeCurrentNode);
    if (parentWaypoint !== null) {
      this.updateWaypoint(parentWaypoint);
    }
  }

  /**
   * Locate the ancestor waypoint (if any) of the given file/folder.
   * @param node The node to start the search from
   * @param includeCurrentNode Whether to include the given folder in the search
   * @returns The ancestor waypoint, or null if none was found
   */
  async locateParentWaypoint(node: TAbstractFile, includeCurrentNode: boolean): Promise<TFile> {
    this.log("Locating all ancestor waypoints of " + node.name);
    let folder = includeCurrentNode ? node : node.parent;
    // When there's a root-level folder note
    if (node.parent?.isRoot() && this.settings.root !== null) {
      const file = this.app.vault.getAbstractFileByPath(this.settings.root);
      if (file instanceof TFile) {
        this.log("Found folder note: " + file.path);
        const text = await this.app.vault.cachedRead(file);
        if (text.includes(Waypoint.BEGIN_WAYPOINT) || text.includes(this.settings.waypointFlag)) {
          this.log("Found parent waypoint!");
          return file;
        }
      }
    } else {
      while (folder) {
        const folderNote = this.getFolderNoteForFolder(folder);
        if (folderNote instanceof TFile) {
          this.log("Found folder note: " + folderNote.path);
          const text = await this.app.vault.cachedRead(folderNote);
          if (text.includes(Waypoint.BEGIN_WAYPOINT) || text.includes(this.settings.waypointFlag)) {
            this.log("Found parent waypoint!");
            return folderNote;
          }
        }
        folder = folder.parent;
      }
    }
    this.log("No parent waypoint found.");
    return null;
  }

  /**
   * Get the parent folder of the given filepath if it exists.
   * @param path The filepath to search
   * @returns The parent folder, or null if none exists
   */
  getParentFolder(path: string): TFolder {
    const abstractFile = this.app.vault.getAbstractFileByPath(path.split("/").slice(0, -1).join("/"));
    return (abstractFile instanceof TFolder) ? abstractFile : null;
  }

  log(message?: string | TFile) {
    if (this.settings.debugLogging) {
      console.log(message);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getWaypointPriority(file: TAbstractFile): number | null {
    if (file instanceof TFile) {
      const { waypointPriorityKey } = this.settings;
      const fileCache = this.app.metadataCache.getFileCache(file as TFile);
      if (typeof fileCache?.frontmatter?.[waypointPriorityKey] === "number") {
        return fileCache.frontmatter[waypointPriorityKey];
      } else {
        return null;
      }
    } else if (file instanceof TFolder) {
      if (this.settings.folderNoteType === FolderNoteType.InsideFolder) {
        // If file is a folder and folder note is an inside note, attempt to find a child note with the same name.
        const foldernote: TAbstractFile | null = file.children.find(
          (child) => child instanceof TFile && child.basename === file.name
        );
        return foldernote ? this.getWaypointPriority(foldernote) : null;
      } else if (this.settings.folderNoteType === FolderNoteType.OutsideFolder) {
        // If file is a folder and folder note is an outside note, attempt to find a sibling note with the same name.
        if (!file.isRoot()) {
          const foldernote: TAbstractFile | null = file.parent.children.find(
            (child) => child instanceof TFile && child.basename === file.name
          );
          return foldernote ? this.getWaypointPriority(foldernote) : null;
        } else {
          return null; // Handle case when the file is the root folder.
        }
      }
      return null;
    }
  }

  sortWithPriority = (a: TAbstractFile, b: TAbstractFile): number => {
    const aPriority = this.getWaypointPriority(a);
    const bPriority = this.getWaypointPriority(b);
    if (aPriority !== null && bPriority !== null) {
      // If both have waypointPriority, the one with a lower priority number should come first.
      return aPriority - bPriority;
    } else if (aPriority !== null) {
      // If only `a` has waypointPriority, `a` should come first.
      return -1;
    } else if (bPriority !== null) {
      // If only `b` has waypointPriority, `b` should come first.
      return 1;
    } else {
      // If neither has priority, sort alphabetically.
      return sortWithNaturalOrder(a, b);
    }
  };
}

class WaypointSettingsTab extends PluginSettingTab {
  plugin: Waypoint;

  constructor(app: App, plugin: Waypoint) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Waypoint Settings" });
    new Setting(this.containerEl)
      .setName("Folder Note Style")
      .setDesc("Select the style of folder note used.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption(FolderNoteType.InsideFolder, "Folder Name Inside")
          .addOption(FolderNoteType.OutsideFolder, "Folder Name Outside")
          .setValue(this.plugin.settings.folderNoteType)
          .onChange(async (value) => {
            this.plugin.settings.folderNoteType = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );
    new Setting(containerEl)
      .setName("Show Folder Notes")
      .setDesc("If enabled, folder notes will be listed alongside other notes in the generated waypoints.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showFolderNotes).onChange(async (value) => {
          this.plugin.settings.showFolderNotes = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Show Non-Markdown Files")
      .setDesc("If enabled, non-Markdown files will be listed alongside other notes in the generated waypoints.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showNonMarkdownFiles).onChange(async (value) => {
          this.plugin.settings.showNonMarkdownFiles = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Show Enclosing Note")
      .setDesc(
        "If enabled, the name of the folder note containing the waypoint will be listed at the top of the generated waypoints."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showEnclosingNote).onChange(async (value) => {
          this.plugin.settings.showEnclosingNote = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Stop Scan at Folder Notes")
      .setDesc(
        "If enabled, the waypoint generator will stop scanning nested folders when it encounters a folder note. Otherwise, it will only stop if the folder note contains a waypoint."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.stopScanAtFolderNotes).onChange(async (value) => {
          this.plugin.settings.stopScanAtFolderNotes = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Use WikiLinks")
      .setDesc("If enabled, links will be generated like [[My Page]] instead of [My Page](../Folder/My%Page.md).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.useWikiLinks).onChange(async (value) => {
          this.plugin.settings.useWikiLinks = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Use Spaces for Indentation")
      .setDesc("If enabled, the waypoint list will be indented with spaces rather than with tabs.")
      .addToggle((toggle: ToggleComponent) =>
        toggle.setValue(this.plugin.settings.useSpaces).onChange(async (value: boolean) => {
          this.plugin.settings.useSpaces = value;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Number of Spaces for Indentation")
      .setDesc("If use spaces is enabled, this is the number of spaces that will be used for indentation")
      .addText((text: TextComponent) =>
        text
          .setPlaceholder("2")
          .setValue("" + this.plugin.settings.numSpaces)
          .onChange(async (value: string) => {
            let num = parseInt(value, 10);
            if (isNaN(num)) return;
            this.plugin.settings.numSpaces = num;
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl)
      .setName("Waypoint Flag")
      .setDesc(
        "Text flag that triggers waypoint generation in a folder note. Must be surrounded by double-percent signs."
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.waypointFlag)
          .setValue(this.plugin.settings.waypointFlag)
          .onChange(async (value) => {
            if (
              value &&
              value.startsWith("%%") &&
              value.endsWith("%%") &&
              value !== "%%" &&
              value !== "%%%" &&
              value !== "%%%%"
            ) {
              this.plugin.settings.waypointFlag = value;
            } else {
              this.plugin.settings.waypointFlag = DEFAULT_SETTINGS.waypointFlag;
              console.error("Error: Waypoint flag must be surrounded by double-percent signs.");
            }
            await this.plugin.saveSettings();
          })
      );
    new Setting(this.containerEl)
      .setName("Sorting Method")
      .setDesc("Select how you would like to have your waypoint lists sorted.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption(SortType.Natural, "Natural")
          .addOption(SortType.Priority, "Prioritized")
          .addOption(SortType.Lexicographic, "Lexicographic")
          .addOption(SortType.FoldersFirst, "Folders First")
          .setValue(this.plugin.settings.sortType)
          .onChange(async (value) => {
            this.plugin.settings.sortType = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );
    new Setting(containerEl)
      .setName("Frontmatter key for note priority")
      .setDesc("The frontmatter key to set the note order piority when listed in a Waypoint.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.waypointPriorityKey)
          .setValue(this.plugin.settings.waypointPriorityKey)
          .onChange(async (value) => {
            this.plugin.settings.waypointPriorityKey = value;
            await this.plugin.saveSettings();
          })
      )
      .setDisabled(this.plugin.settings.sortType !== SortType.Priority);
    new Setting(containerEl)
      .setName("Ignored folders")
      .setDesc("Folders that Waypoint should ignore")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.ignoredFolders.join(","))
          .setValue(this.plugin.settings.ignoredFolders.join(", "))
          .onChange(async (value) => {
            const previous = this.plugin.settings.ignoredFolders;
            this.plugin.settings.ignoredFolders = value.split(/\s*,\s*/);
            await this.plugin.saveSettings();

            // Get a list of all new and old folders that need updating
            const allFolders = [...new Set([...previous, ...this.plugin.settings.ignoredFolders])];

            // Trigger updates in order to remove those folders from existing waypoints
            for (let i = 0; i < allFolders.length; i++) {
              const file = this.app.vault.getAbstractFileByPath(allFolders[i]);
              if (file === null) {
                continue;
              }
              await this.plugin.locateParentWaypoint(file, false).then((file) => {
                if (file !== null) {
                  this.plugin.updateWaypoint(file);
                }
              });
            }
          })
      );
    const postscriptElement = containerEl.createEl("div", {
      cls: "setting-item",
    });
    const descriptionElement = postscriptElement.createDiv({
      cls: "setting-item-description",
    });
    descriptionElement.createSpan({
      text: "For instructions on how to use this plugin, check out the README on ",
    });
    descriptionElement.createEl("a", {
      attr: { href: "https://github.com/IdreesInc/Waypoint" },
      text: "GitHub",
    });
    descriptionElement.createSpan({
      text: " or get in touch with the author ",
    });
    descriptionElement.createEl("a", {
      attr: { href: "https://twitter.com/IdreesInc" },
      text: "@IdreesInc",
    });
    postscriptElement.appendChild(descriptionElement);
  }
}
