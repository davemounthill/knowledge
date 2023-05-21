var Obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
    folder: "smart prompts",
    auto_submit: true,
    initial_prompt: "You are role-playing as Socrates, please help me with an Issue in my life. Please ask me questions to try to understand what my issue is and help me unpack it. You can start the conversation however you feel is best. Please end your responses with /e.",
    initial_prompt_enabled: true,
    file_focus_prompt: "",
    auto_prompt_on_file_focus: false,
    file_focus_exceptions: "",
};
class SmartPromptsPlugin extends Obsidian.Plugin {
    // constructor
    constructor() {
        super(...arguments);
        this.selection = null;
        this.file_focus_prompt_template = null;
        this.status_bar = null;
        this.countdown_ct = 10;
        this.countdown_interval = null;
        this.file_focus_exceptions = [];
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        // get file from name in settings.file_focus_prompt
        if (this.settings.file_focus_prompt != "") {
            let path = this.settings.folder + "/" + this.settings.file_focus_prompt;
            // add .md if it is not already there
            if (!path.endsWith(".md")) {
                path += ".md";
            }
            const file = await this.app.vault.getAbstractFileByPath(path);
            if (file instanceof Obsidian.TFile) {
                this.file_focus_prompt_template = file;
            }
        }
        // if file_focus_exceptions is not empty
        if (this.settings.file_focus_exceptions.length > 0) {
            // split the string by commas
            // trim each element
            // remove empty elements
            this.file_focus_exceptions = this.settings.file_focus_exceptions.split(",").map((e) => e.trim()).filter((e) => e != "");
        }
    }

    async save_settings() {
        await this.saveData(this.settings);
        // re-load settings into memory
        await this.loadSettings();
    }

    async onload() {
        this.modal = new SmartPromptsModal(this.app, this);
        console.log("loading plugin");

        this.addCommand({
            id: "sp-find-prompts",
            name: "Open Smart Prompts Selector",
            icon: "bot",
            hotkeys: [{
                modifiers: ["Alt"],
                key: "j"
            }],
            editorCallback: (editor) => {
                // get the selection from the active context
                this.selection = editor.getSelection();
                // if no selection, use the whole note
                if (!this.selection) {
                    this.selection = editor.getValue();
                }
                this.modal.open();
            }
        });

        // register smart prompts selector that uses the current selection from clipboard
        this.addCommand({
            id: "sp-find-prompts-clipboard",
            name: "Open Smart Prompts Selector (Clipboard)",
            icon: "bot",
            hotkeys: [{
                modifiers: ["Alt"],
                key: "g"
            }],
            callback: async () => {
                // get the selection from the clipboard
                this.selection = await navigator.clipboard.readText();
                this.modal.open();
            }
        });

        this.addSettingTab(new SmartPromptsSettingsTab(this.app, this));

        // register command to open the ChatGPT view
        this.addCommand({
            id: "sp-open-chatgpt",
            name: "Open Smart ChatGPT",
            callback: () => {
                this.app.workspace.getRightLeaf(false).setViewState({
                    type: SMART_CHATGPT_VIEW_TYPE,
                    active: true,
                });
                this.app.workspace.revealLeaf(this.app.workspace.getLeavesOfType(SMART_CHATGPT_VIEW_TYPE)[0]);
            }
        });

        // register command to toggle this.plugin.settings.auto_submit
        this.addCommand({
            id: "sp-toggle-auto-submit",
            name: "Toggle Auto-Submit",
            callback: () => {
                this.settings.auto_submit = !this.settings.auto_submit;
                this.save_settings();
                new Obsidian.Notice("Auto-Submit is now " + (this.settings.auto_submit ? "on" : "off"));
            }
        });

        this.addCommand({
            id: "sp-cancel-file-focus-prompt",
            name: "Cancel File Focus Prompt (when in progress)",
            hotkeys: [{
                modifiers: ["Ctrl"],
                key: "q"
            }],
            callback: () => {
                this.clear_focus();
            }
        });
        // initialize when the layout is ready
        this.app.workspace.onLayoutReady(this.initialize.bind(this));
    }
    async initialize() {
        // load settings
        await this.loadSettings();
        // initiate smart prompts folder if this.settings.folder is smart prompts and it is not already created
        if (this.settings.folder == "smart prompts" && !(await this.app.vault.adapter.exists("smart prompts"))) {
            await this.initiate_template_folder();
            new Obsidian.Notice("Smart Prompts folder created.");
        }
        // register views
        this.registerView(SMART_CHATGPT_VIEW_TYPE, (leaf) => (new SmartChatGPTView(leaf, this)));
        // register file-open event to automatically run if the file is open and focused for more than 10 seconds
        this.registerEvent(this.app.workspace.on("file-open", (file) => {
            // if no file is open, do nothing
            if (!file) {
                this.clear_focus();
                return;
            }
            if (!this.settings.auto_prompt_on_file_focus) {
                return;
            }
            // skip if SMART_CHATGPT_VIEW_TYPE is not open
            if (this.app.workspace.getLeavesOfType(SMART_CHATGPT_VIEW_TYPE).length == 0) {
                console.log("Smart Prompts: File Focus Prompt skipped because Smart ChatGPT is not open.");
                return;
            }
            // if settings.file_focus_prompt is not set, do nothing
            if (!this.file_focus_prompt_template) {
                if (this.settings.file_focus_prompt != "") {
                    new Obsidian.Notice("Smart Prompts: File Focus Prompt Template not found.");
                }
                return;
            }
            // if the file matches pattern in the file_focus_exceptions list
            for (let i = 0; i < this.file_focus_exceptions.length; i++) {
                if (file.path.indexOf(this.file_focus_exceptions[i]) > -1) {
                    if (this.countdown_interval) {
                        this.clear_focus();
                    }
                    console.log("Smart Prompts: File Focus Prompt excluded for " + file.path);
                    return;
                }
            }
            this.countdown_ct = 10;
            if (!this.countdown_interval) {
                this.countdown_interval = setInterval(this.focusCountdown.bind(this, file), 1000);
            }
        }));
        new Obsidian.Notice("Smart Prompts initialized.");
    }
    clear_focus() {
        clearInterval(this.countdown_interval);
        this.countdown_interval = null;
        this.status_bar.empty();
    }
    async focusCountdown(file) {
        // console.log(this.countdown_ct);
        if (this.status_bar == null) {
            this.status_bar = this.addStatusBarItem();
        }
        // countdown in the status bar
        this.status_bar.empty();
        this.status_bar.createEl("span", {
            text: "Smart Prompts: File Focus Prompt in " + this.countdown_ct + " seconds"
        });
        this.countdown_ct--;
        // clear the status bar when the countdown is done
        if (this.countdown_ct < 0) {
            this.clear_focus();
            // get the contents of file
            this.selection = await this.app.vault.cachedRead(file);
            await this.build_prompt(this.file_focus_prompt_template);
        }
    }
    async initiate_template_folder() {
        await this.app.vault.adapter.mkdir("smart prompts");
        // initiate prompt for critiquing a note
        let critic_prompt = "Please critique the following NOTE:";
        critic_prompt += "\n---START NOTE---";
        critic_prompt += "\n# {{TITLE}}";
        critic_prompt += "\n{{CURRENT}}";
        critic_prompt += "\n---END NOTE---";
        critic_prompt += "\nBEGIN Critique:";
        await this.app.vault.adapter.write("smart prompts/critique.md", critic_prompt);
        // initiate prompt for generating an outline for a note
        let outline_prompt = "Here are some notes for a piece I'm working on. Can you help me reorganize them into an outline?";
        outline_prompt += "\n---START NOTE---";
        outline_prompt += "\n# {{TITLE}}";
        outline_prompt += "\n{{CURRENT}}";
        outline_prompt += "\n---END NOTE---";
        outline_prompt += "\nBEGIN Outline:";
        await this.app.vault.adapter.write("smart prompts/outline.md", outline_prompt);
        // initiate prompt for generating a summary for a note
        let summary_prompt = "Here are some notes for a piece I'm working on. Can you help me summarize them?";
        summary_prompt += "\n---START NOTE---";
        summary_prompt += "\n# {{TITLE}}";
        summary_prompt += "\n{{CURRENT}}";
        summary_prompt += "\n---END NOTE---";
        summary_prompt += "\nBEGIN Summary:";
        await this.app.vault.adapter.write("smart prompts/summary.md", summary_prompt);
    }
    async build_prompt(prompt_template) {
        console.log("prompt chosen", prompt_template);
        // get the template contents
        let smart_prompt = await this.app.vault.cachedRead(prompt_template);
        // if template contains a double bracket
        if (smart_prompt.indexOf("{{") > -1) {
            // if {{CURRENT}} is in the template (case-insensitive)
            if (smart_prompt.toLowerCase().indexOf("{{current}}") > -1) {
                // replace {{CURRENT}} (case-insensitive) with selection.trim()
                smart_prompt = smart_prompt.replace(/{{CURRENT}}/gi, this.selection);
            }
            // if {{TITLE}} or {{FILE_NAME}} is in the template (case-insensitive)
            if (smart_prompt.toLowerCase().indexOf("{{title}}") > -1 || smart_prompt.toLowerCase().indexOf("{{file_name}}") > -1) {
                // get the current note title
                let title = this.app.workspace.getActiveFile().basename;
                // replace {{TITLE}} (case-insensitive) with title
                smart_prompt = smart_prompt.replace(/{{TITLE}}/gi, title);
                // replace {{FILE_NAME}} (case-insensitive) with title
                smart_prompt = smart_prompt.replace(/{{FILE_NAME}}/gi, title);
            }
        }
        // if still contains a double bracket get all context variables and replace them using this.getPropertyValue()
        if (smart_prompt.indexOf("{{") > -1) {
            let active_file = this.app.workspace.getActiveFile();
            await this.awaitDataViewPage(active_file.path);
            // get all variables from inside the double brackets
            let contexts = smart_prompt.match(/{{(.*?)}}/g);
            // for each variable
            for (let i = 0; i < contexts.length; i++) {
                // get the variable name
                let context = contexts[i].replace(/{{|}}/g, "");
                // get the value of the variable
                let value = this.getPropertyValue(context, active_file);
                // replace the variable with the value
                smart_prompt = smart_prompt.replace(new RegExp("{{" + context + "}}", "g"), value);
            }
        }
        // if still contains a double bracket, remove them and the text between them
        if (smart_prompt.indexOf("{{") > -1) {
            smart_prompt = smart_prompt.replace(/{{(.*?)}}/g, "");
        }
        // open a markdown view if none is open to 'focus the editor'
        let temp_view = null;
        if (!this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)) {
            this.app.workspace.getLeaf(false).setViewState({
                type: Obsidian.MarkdownView,
                active: true
            });
        } else {
            // focus the editor
            this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView).editor.focus();
        }
        // save the current clipboard
        let clipboard = await navigator.clipboard.readText();
        // copy to the clipboard
        await navigator.clipboard.writeText(smart_prompt);
        if (temp_view) {
            // close the temp view
            temp_view.close();
        }
        // clear the selection
        this.selection = null;
        /**
         * Smart ChatGPT
         * ---
         * If SmartChatGPTView is open, send the prompt to the view
         */
        const smartChatGPTView = this.app.workspace.getLeavesOfType(SMART_CHATGPT_VIEW_TYPE)[0];
        if (smartChatGPTView) {
            // focus the smartChatGPTView
            // this.app.workspace.setActiveLeaf(smartChatGPTView);
            console.log("sending prompt to SmartChatGPTView");
            await smartChatGPTView.view.paste_prompt();
            // restore the clipboard
            await navigator.clipboard.writeText(clipboard);
        } else {
            new Obsidian.Notice("Smart Prompt: Copied to clipboard");
        }
    }
}

class SmartPromptsSidebar extends Obsidian.ItemView {
    constructor(containerEl, plugin) {
        this.containerEl = containerEl;
        this.plugin = plugin;

        // Create input field
        const inputContainerEl = this.containerEl.createDiv({ cls: "smart-prompts-input-container" });
        const inputEl = inputContainerEl.createEl("input", {
            cls: "smart-prompts-input",
            attr: { type: "text", placeholder: "Search prompts..." },
        });
        inputEl.addEventListener("input", () => {
            this.applyFilter();
        });
        this.inputEl = inputEl;

        // Create controls and prompts container
        const controlsEl = this.containerEl.createDiv({ cls: "smart-prompts-controls" });
        controlsEl.createDiv({ cls: "smart-prompts-folder-label", text: "Folder" });

        // Create a folder selector instance
        this.folderSelector = new FolderSelector(controlsEl)
            .setPlaceholder("All Notes")
            .onChange(async (folder) => {
                this.activeFolder = folder;
                await this.loadPrompts();
            });

        if (this.plugin.settings.enableTagFiltering) {
            controlsEl.createDiv({ cls: "smart-prompts-tag-label", text: "Tag" });

            // Create a tag selector instance
            this.tagSelector = new TagSelector(controlsEl)
                .setPlaceholder("All Tags")
                .setDisabled(true)
                .onChange(async (tag) => {
                    this.activeTag = tag;
                    await this.loadPrompts();
                });
        }

        const promptsContainerEl = this.containerEl.createDiv({ cls: "smart-prompts-container" });

        // Load prompts on startup
        this.loadPrompts();
    }

    async loadPrompts() {
        let prompts = await this.getPrompts();

        if (this.plugin.settings.enableFolderOrganization) {
            // Filter prompts by folder
            if (this.activeFolder) {
                const folderPath = this.activeFolder.split("/");
                prompts = prompts.filter((prompt) => {
                    const notePath = prompt.sourceNote.path.split("/");
                    return folderPath.every((folder, index) => folder === notePath[index]);
                });
            }
        }

        if (this.plugin.settings.enableTagFiltering) {
            // Filter prompts by tag
            if (this.activeTag) {
                prompts = prompts.filter((prompt) => {
                    const tags = prompt.sourceNote.getTags().map((tag) => tag.slice(1));
                    return tags.includes(this.activeTag);
                });
            }
        }

        this.prompts = prompts;

        // Render prompts
        this.renderPrompts();
    }

    async getPrompts() {
        const vault = this.plugin.app.vault;
        const noteFiles = await vault.getMarkdownFiles();

        const prompts = [];

        for (let noteFile of noteFiles) {
            const note = await vault.read(noteFile);
            const frontmatter = fm(note);
            if (frontmatter.smartPrompt) {
                prompts.push({
                    sourceNote: noteFile,
                    name: frontmatter.smartPrompt,
                });
            }
        }

        return prompts;
    }

    applyFilter() {
        const filter = this.inputEl.value.toLowerCase();

        const filteredPrompts = this.prompts.filter((prompt) =>
            prompt.name.toLowerCase().includes(filter)
        );

        this.renderPrompts(filteredPrompts);
    }

    renderPrompts(prompts) {
        const container = this.containerEl.querySelector(".smart-prompts-container");
        container.empty();

        for (let prompt of prompts || this.prompts) {
            const promptEl = container.createDiv({
                cls: "smart-prompt",
                text: prompt.name, attr: { "data-source-note": prompt.sourceNote.path },
                onClick: () => {
                    this.plugin.openPrompt(prompt.sourceNote.path);
                },
                onContextMenu: (evt) => {
                    this.plugin.openContextMenu(evt, prompt);
                },
            });
            promptEl.createEl("span", { cls: "smart-prompt-note-title", text: prompt.sourceNote.basename });
        }


    }


    onload() {
        this.addRibbonIcon('bot', 'Smart Prompts', () => {
            this.openView();
        });
        this.registerCommands();
        this.addWorkspaceLeaf();
    }

    registerCommands() {
        this.addCommand({
            id: 'open-smart-prompts',
            name: 'Open Smart Prompts',
            callback: () => this.openView()
        });
    }

    openView() {
        const leaf = this.app.workspace.getRightLeaf(false);
        if (leaf && leaf.getViewState && leaf.getViewState().type === 'smart-prompts') {
            this.app.workspace.revealLeaf(leaf);
            return;
        }

        const view = new SmartPromptsView(this.app, this);
        this.app.workspace.openLeaf(view);
    }
}

class SmartPromptsView extends Obsidian.LeafView {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.containerEl = null;
        this.fileItems = [];
        this.filteredItems = [];
        this.folderSelector = null;
        this.tagSelector = null;
        this.listEl = null;
        this.inputEl = null;
        this.lastInput = "";

        this.loadItems();
    }

    async loadItems() {
        if (!this.plugin.settings.folder) {
            this.fileItems = this.app.vault.getMarkdownFiles();
        } else {
            const folder = this.app.vault.getAbstractFileByPath(this.plugin.settings.folder);
            let files = [];
            Obsidian.Vault.recurseChildren(folder, (file) => {
                if (file instanceof Obsidian.TFile) {
                    files.push(file);
                }
            });
            files.sort((a, b) => {
                return a.basename.localeCompare(b.basename);
            });
            if (files) {
                this.fileItems = files;
            }
        }
        this.fileItems = await this.filterItems(this.fileItems);
        this.render();
    }

    async filterItems(items) {
        const tags = await this.getTags();
        if (tags.length === 0) return items;
        return items.filter((item) => {
            const cache = this.app.metadataCache.getFileCache(item);
            if (!cache?.frontmatter) return false;
            const fileTags = cache.frontmatter.tags ?? [];
            return tags.every(tag => fileTags.includes(tag));
        });
    }

    async getTags() {
        const tagsStr = this.tagSelector.getValue().trim();
        if (tagsStr.length === 0) return [];
        return tagsStr.split(",").map(tag => tag.trim());
    }

    async onLoad() {
        this.containerEl = this.createDiv({ cls: "smart-prompts-view" });

        this.listEl = this.containerEl.createDiv({ cls: "smart-prompts-list" });
        this.listEl.style.height = "calc(100% - 120px)";
        this.listEl.on("click", (evt) => {
            const clickedEl = evt.target;
            const file = clickedEl.closest("[data-path]");
            if (file) {
                this.onSelectFile(file.dataset.path);
            }
        });

        this.inputEl = this.containerEl.createEl("input", { cls: "smart-prompts-input" });
        this.inputEl.type = "text";
        this.inputEl.placeholder = "Type name of a prompt...";
        this.inputEl.on("input", () => {
            this.applyFilter();
        });

        const controlsEl = this.containerEl.createDiv({ cls: "smart-prompts-controls" });
        controlsEl.createDiv({ cls: "smart-prompts-folder-label", text: "Folder" });

        // Create a folder selector instance
        this.folderSelector = new FolderSelector(controlsEl)
            .setPlaceholder("All Notes")
            .onChange(async (folder) => {
                this.activeFolder = folder;
                await this.loadPrompts();
            });

        if (this.plugin.settings.enableTagFiltering) {
            controlsEl.createDiv({ cls: "smart-prompts-tag-label", text: "Tag" });

            // Create a tag selector instance
            this.tagSelector = new TagSelector(controlsEl)
                .setPlaceholder("All Tags")
                .setDisabled(true)
                .onChange(async (tag) => {
                    this.activeTag = tag;
                    await this.loadPrompts();
                });
        }

        const promptsContainerEl = this.containerEl.
            createDiv({ cls: "smart-prompts-container" });

        // Load prompts on startup
        this.loadPrompts();
    }

    async loadPrompts() {
        const prompts = await this.getPrompts();

        if (this.plugin.settings.enableFolderOrganization) {
            // Filter prompts by folder
            if (this.activeFolder) {
                const folderPath = this.activeFolder.split("/");
                prompts = prompts.filter((prompt) => {
                    const notePath = prompt.sourceNote.path.split("/");
                    return folderPath.every((folder, index) => folder === notePath[index]);
                });
            }
        }

        if (this.plugin.settings.enableTagFiltering) {
            // Filter prompts by tag
            if (this.activeTag) {
                prompts = prompts.filter((prompt) => {
                    const tags = prompt.sourceNote.getTags().map((tag) => tag.slice(1));
                    return tags.includes(this.activeTag);
                });
            }
        }

        this.prompts = prompts;

        // Render prompts
        this.renderPrompts();
    }

    // Rest of the class methods...
}





module.exports = SmartPromptsSidebar;




class SmartPromptsSettingsTab extends Obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Smart Prompts Settings" });

        new Obsidian.Setting(this.containerEl)
            .setName('Enable Folder-based Organization')
            .setDesc('Organize prompts in the sidebar view based on their file paths.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableFolderOrganization)
                .onChange(async (value) => {
                    this.plugin.settings.enableFolderOrganization = value;
                    await this.plugin.saveSettings();
                }));

        new Obsidian.Setting(this.containerEl)
            .setName('Enable Tag Filtering')
            .setDesc('Allow filtering of prompts in the sidebar view based on tags.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableTagFiltering)
                .onChange(async (value) => {
                    this.plugin.settings.enableTagFiltering = value;
                    await this.plugin.saveSettings();
                }));

        new Obsidian.Setting(this.containerEl)
            .setName('Folder location')
            .setDesc('Files in this folder will be available as Smart Prompts template pallete.')
            .addText(cb => cb
                .setPlaceholder('smart prompts')
                .setValue(this.plugin.settings.folder)
                .onChange(async new_folder => {
                    this.plugin.settings.folder = new_folder;
                    await this.plugin.saveSettings();
                }));

        new Obsidian.Setting(this.containerEl)
            .setName('Auto Submit')
            .setDesc('Automatically submit the prompt if the ChatGPT window is open.')
            .addToggle(cb => cb
                .setValue(this.plugin.settings.auto_submit)
                .onChange(async value => {
                    this.plugin.settings.auto_submit = value;
                    await this.plugin.saveSettings();
                }));

        new Obsidian.Setting(this.containerEl)
            .setName('Initial Prompt')
            .setDesc('Enter an initial prompt when opening ChatGPT (good for using it as a journal)')
            .addToggle(cb => cb
                .setValue(this.plugin.settings.initial_prompt_enabled)
                .onChange(async value => {
                    this.plugin.settings.initial_prompt_enabled = value;
                    await this.plugin.saveSettings();
                }));

        new Obsidian.Setting(this.containerEl)
            .setName('Initial Prompt Text')
            .setDesc('The initial prompt to enter when opening the ChatGPT window.')
            .addTextArea(cb => cb
                .setPlaceholder('initial prompt')
                .setValue(this.plugin.settings.initial_prompt)
                .onChange(async new_prompt => {
                    this.plugin.settings.initial_prompt = new_prompt;
                    await this.plugin.saveSettings();
                }));

        new Obsidian.Setting(this.containerEl)
            .setName('File Focus Prompt')
            .setDesc('The prompt to enter when a file is focused for 10 seconds or more.')
            .addText(cb => cb
                .setPlaceholder('file focus prompt')
                .setValue(this.plugin.settings.file_focus_prompt)
                .onChange(async new_prompt => {
                    this.plugin.settings.file_focus_prompt = new_prompt;
                    await this.plugin.saveSettings();
                }));

        new Obsidian.Setting(this.containerEl)
            .setName('Auto Prompt on File Focus')
            .setDesc('Automatically prompt when a file is focused for 10 seconds or more.')
            .addToggle(cb => cb
                .setValue(this.plugin.settings.auto_prompt_on_file_focus)
                .onChange(async value => {
                    this.plugin.settings.auto_prompt_on_file_focus = value;
                    await this.plugin.saveSettings
                }));
    };
}

module.exports = SmartPromptsPlugin;


const SMART_CHATGPT_VIEW_TYPE = "smart_chatgpt";

class SmartChatGPTView extends Obsidian.ItemView {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    getViewType() {
        return SMART_CHATGPT_VIEW_TYPE;
    }

    getDisplayText() {
        return "Smart ChatGPT";
    }

    getIcon() {
        return "bot";
    }

    async onload() {
        console.log("loading view");
        this.containerEl.empty();
        this.initializeSidebar(); // Initialize sidebar and load prompts
        this.containerEl.appendChild(this.create()); // Add UI for ChatGPT here...
    }

    create() {
        this.frame = document.createElement("webview");
        // this.frame = document.createElement("iframe");
        this.frame.setAttribute("allowpopups", "");
        this.frame.addEventListener("dom-ready", () => {
            if (this.plugin.settings.initial_prompt_enabled) {
                this.frame.addEventListener("found-in-page", async (e) => {
                    // wait for one second
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    await this.frame.executeJavaScript(`document.querySelector("textarea").focus()`);
                    await this.frame.executeJavaScript(`document.querySelector("textarea").value = "${this.plugin.settings.initial_prompt}"`);
                    // enter
                    await this.frame.executeJavaScript(`document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter"}))`);
                });
                this.frame.findInPage("textarea");
            }
        });
        // add 100% height and width to the webview
        this.frame.style.width = "100%";
        this.frame.style.height = "100%";
        this.frame.setAttribute("src", "https://chat.openai.com/chat");
        return this.frame;
    }

    // function to execute javascript in the webview
    async paste_prompt() {
        // paste text from clipboard into textarea
        await this.frame.executeJavaScript(`document.querySelector("textarea").value = ""`);
        await this.frame.executeJavaScript(`document.querySelector("textarea").focus()`);
        await this.frame.executeJavaScript(`document.execCommand("paste")`);

        /**
         * TO ENTER/SUBMIT
         */
        if (this.plugin.settings.auto_submit) {
            await this.frame.executeJavaScript(`document.querySelector("textarea").focus()`);
            await this.frame.executeJavaScript(`document.querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown", {key: "Enter"}))`);
        }
    }

    initializeSidebar() {
        // get current leaf and set sidebar as view state
        const leaf = this.app.workspace.activeLeaf;
        this.app.workspace.setActiveLeaf(leaf);
        leaf.detach();
        leaf.setViewState({
            type: "SmartPromptsSidebar",
            state: {
                enableFolderOrganization: this.plugin.settings.enableFolderOrganization,
                enableTagFiltering: this.plugin.settings.enableTagFiltering,
            },
        });
        leaf.attach();
    }

    onunload() {
        // Clean up when the view is unloaded
    }

    // Rest of the class methods...

    // You may need to modify methods here to work with the new SmartPromptsSidebar class instead of the modal.
}
