// import * as azdata from 'azdata';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  HACKATIME_CLIENT_ID,
  AI_RECENT_PASTES_TIME_MS,
  ALLOWED_SCHEMES,
  COMMAND_DASHBOARD,
  Heartbeat,
  LogLevel,
  SEND_BUFFER_SECONDS,
  SYNC_AI_HEARTBEATS_DEBOUNCE_SECONDS,
} from './constants';
import { FileSelectionMap, HumanTypingMap, LineCounts, LinesInFiles } from './types';
import { Utils } from './utils';
import { Options, Setting } from './options';

import { Dependencies } from './dependencies';
import { Desktop } from './desktop';
import { Logger } from './logger';

export class Hackatime {
  private static readonly MAX_PROJECT_SEARCH_DEPTH = 500;

  private editorName: string;
  private extension: any;
  private statusBar?: vscode.StatusBarItem = undefined;
  private statusBarTeamYou?: vscode.StatusBarItem = undefined;
  private statusBarTeamOther?: vscode.StatusBarItem = undefined;
  private disposable: vscode.Disposable;
  private lastFile: string;
  private lastHeartbeat: number = 0;
  private lastDebug: boolean = false;
  private lastCompile: boolean = false;
  private lastAICodeGenerating: boolean = false;
  private lastCodeReviewing: boolean = false;
  private dedupe: FileSelectionMap = {};
  private debounceId: any = null;
  private debounceMs = 50;
  private AIDebounceId: any = null;
  private AIdebounceMs = 1000;
  private AIdebounceCount = 0;
  private AIrecentPastes: number[] = [];
  private dependencies: Dependencies;
  private options: Options;
  private logger: Logger;
  private fetchTodayInterval: number = 60000;
  private lastFetchToday: number = 0;
  private showStatusBar: boolean;
  private showCodingActivity: boolean;
  private showStatusBarTeam: boolean;
  private hasTeamFeatures: boolean;
  private disabled: boolean = true;
  private extensionPath: string;
  private isCompiling: boolean = false;
  private isDebugging: boolean = false;
  private isAICodeGenerating: boolean = false;
  private hasAICapabilities: boolean = false;
  private currentlyFocusedFile: string;
  private teamDevsForFileCache = {};
  private resourcesLocation: string;
  private lastApiKeyPrompted: number = 0;
  private isMetricsEnabled: boolean = false;
  private heartbeats: Heartbeat[] = [];
  private lastSent: number = 0;
  private linesInFiles: LinesInFiles = {};
  private lineChanges: LineCounts = { ai: {}, human: {} };
  private syncAIHeartbeatsDebounce?: NodeJS.Timeout = undefined;
  private filesWithHumanTyping: HumanTypingMap = {};
  private httpServer: http.Server | null = null;
  private state: vscode.Memento;
  
  private pendingMissingGitRepoPrompt?: string = undefined;

  constructor(logger: Logger, context: vscode.ExtensionContext) {
    this.extensionPath = context.extensionPath;
    this.logger = logger;
    this.state = context.globalState;
    this.setResourcesLocation();
    this.options = new Options(logger, this.resourcesLocation);
  }

  public initialize(): void {
    this.options.getSetting('settings', 'debug', false, (setting: Setting) => {
      if (setting.value === 'true') {
        this.logger.setLevel(LogLevel.DEBUG);
      }
      this.options.getSetting('settings', 'metrics', false, (metrics: Setting) => {
        if (metrics.value === 'true') {
          this.isMetricsEnabled = true;
        }

        this.dependencies = new Dependencies(this.options, this.logger, this.resourcesLocation);

        const extension = vscode.extensions.getExtension('hackatime.hackatime-time-tracker');
        this.extension = (extension != undefined && extension.packageJSON) || { version: '0.0.0' };
        this.editorName = Utils.getEditorName();

        this.hasAICapabilities = Utils.hasAIExtensions();

        this.options.getSetting('settings', 'disabled', false, (disabled: Setting) => {
          this.disabled = disabled.value === 'true';
          if (this.disabled) {
            this.dispose();
            return;
          }

          this.initializeDependencies();
        });
      });
    });
  }

  public dispose() {
    if (this.syncAIHeartbeatsDebounce) {
      clearTimeout(this.syncAIHeartbeatsDebounce);
      this.syncAIHeartbeatsDebounce = undefined;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
    this.sendHeartbeats();
    this.statusBar?.dispose();
    this.statusBarTeamYou?.dispose();
    this.statusBarTeamOther?.dispose();
    this.disposable?.dispose();
  }

  private setResourcesLocation() {
    const home = Desktop.getHomeDirectory();
    const folder = path.join(home, '.wakatime');

    try {
      fs.mkdirSync(folder, { recursive: true });
      this.resourcesLocation = folder;
    } catch (e) {
      this.resourcesLocation = this.extensionPath;
    }
  }

  public initializeDependencies(): void {
    this.logger.debug(`Initializing Hackatime v${this.extension.version}`);

    const align = this.options.getStatusBarAlignment();
    const priority = this.options.getStatusBarPriority();

    this.statusBar = vscode.window.createStatusBarItem(
      'com.hackatime.statusbar',
      align,
      priority + 2,
    );
    this.statusBar.name = 'Hackatime';
    this.statusBar.command = COMMAND_DASHBOARD;

    this.statusBarTeamYou = vscode.window.createStatusBarItem(
      'com.hackatime.teamyou',
      align,
      priority + 1,
    );
    this.statusBarTeamYou.name = 'Hackatime Top dev';

    this.statusBarTeamOther = vscode.window.createStatusBarItem(
      'com.hackatime.teamother',
      align,
      priority,
    );
    this.statusBarTeamOther.name = 'Hackatime Team Total';

    this.options.getSetting('settings', 'status_bar_team', false, (statusBarTeam: Setting) => {
      this.showStatusBarTeam = statusBarTeam.value !== 'false';
      this.options.getSetting(
        'settings',
        'status_bar_enabled',
        false,
        (statusBarEnabled: Setting) => {
          this.showStatusBar = statusBarEnabled.value !== 'false';
          this.setStatusBarVisibility(this.showStatusBar);
          this.updateStatusBarText('Hackatime Initializing...');

          this.checkApiKey();
          this.checkUnauthorizedSettings();

          this.setupEventListeners();

          this.options.getSetting(
            'settings',
            'status_bar_coding_activity',
            false,
            (showCodingActivity: Setting) => {
              this.showCodingActivity = showCodingActivity.value !== 'false';

              this.dependencies.checkAndInstallCli(() => {
                this.logger.debug('Hackatime initialized');
                this.updateStatusBarText();
                this.updateStatusBarTooltip('Hackatime: Initialized');
                this.getCodingActivity();
              });
            },
          );
        },
      );
    });
  }

  private updateStatusBarText(text?: string): void {
    if (!this.statusBar) return;
    if (!text) {
      this.statusBar.text = '$(clock)';
    } else {
      this.statusBar.text = '$(clock) ' + text;
    }
  }

  private updateStatusBarTooltip(tooltipText: string): void {
    if (!this.statusBar) return;
    this.statusBar.tooltip = tooltipText;
  }

  private statusBarShowingError(): boolean {
    if (!this.statusBar) return false;
    return this.statusBar.text.indexOf('Error') != -1;
  }

  private updateTeamStatusBarTextForCurrentUser(text?: string): void {
    if (!this.statusBarTeamYou) return;
    if (!text) {
      this.statusBarTeamYou.text = '';
    } else {
      this.statusBarTeamYou.text = text;
    }
  }

  private updateStatusBarTooltipForCurrentUser(tooltipText: string): void {
    if (!this.statusBarTeamYou) return;
    this.statusBarTeamYou.tooltip = tooltipText;
  }

  private updateTeamStatusBarTextForOther(text?: string): void {
    if (!this.statusBarTeamOther) return;
    if (!text) {
      this.statusBarTeamOther.text = '';
    } else {
      this.statusBarTeamOther.text = text;
      this.statusBarTeamOther.tooltip = 'Developer with the most time spent in this file';
    }
  }

  private updateStatusBarTooltipForOther(tooltipText: string): void {
    if (!this.statusBarTeamOther) return;
    this.statusBarTeamOther.tooltip = tooltipText;
  }

  public async loginWithHackatime(): Promise<void> {
    const redirectUri = `http://localhost:54321/callback`;

    const choice = await vscode.window.showInformationMessage(
      'Hackatime needs to open your browser to sign in. Continue?',
      { modal: true },
      'Open Browser',
      'Enter API Key Manually',
    );

    if (choice === 'Enter API Key Manually') {
      this.promptForApiKey();
      return;
    }

    if (choice !== 'Open Browser') {
      this.logger.debug('User cancelled Hackatime OAuth flow');
      return;
    }

    this.logger.debug('Starting Hackatime OAuth flow');

    this.startCallbackServer(54321, (authCode: string) => {
      this.exchangeCodeForApiKey(authCode);
    });

    const authUrl = `https://hackatime.hackclub.com/oauth/authorize?client_id=${HACKATIME_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
    vscode.env.openExternal(vscode.Uri.parse(authUrl));
  }

  private startCallbackServer(port: number, onCode: (code: string) => void): void {
    this.httpServer = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      if (!req.url) {
        res.writeHead(400);
        res.end('Invalid request');
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        this.logger.error(`OAuth error: ${error}`);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(`<h1>Authorization Failed</h1><p>Error: ${error}</p>`);
        this.httpServer?.close();
        this.httpServer = null;
        return;
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end('<h1>✓ Authorization successful!</h1><p>You can now close this page...</p>');

        this.logger.debug('Received authorization code');
        onCode(code);

        setTimeout(() => {
          this.httpServer?.close();
          this.httpServer = null;
        }, 100);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end('<h1>Authorization Failed</h1><p>No authorization code received</p>');
      }
    });

    this.httpServer.on('error', (err) => {
      this.logger.error(`OAuth server error: ${err}`);
      vscode.window.showErrorMessage('Failed to start OAuth callback server');
    });

    this.httpServer.listen(port, () => {
      this.logger.debug(`OAuth callback server listening on port ${port}`);
    });
  }

  private async exchangeCodeForApiKey(authCode: string): Promise<void> {
    try {
      const apiUrl = 'https://hackatime.hackclub.com';
      const redirectUri = 'http://localhost:54321/callback';

      this.logger.debug('Exchanging authorization code for access token');
      const token = await Utils.exchangeCodeForToken(apiUrl, authCode, redirectUri);

      this.logger.debug('Fetching API key using access token');
      const apiKey = await Utils.fetchApiKeyWithToken(apiUrl, token);

      this.logger.debug('Successfully obtained API key from OAuth');
      this.options.setSetting('settings', 'api_url', apiUrl + '/api/hackatime/v1', false);
      this.options.setSetting('settings', 'api_key', apiKey, false);
      this.options.setSetting('settings', 'heartbeat_rate_limit_seconds', '30', false);
      this.options.setSetting('settings', 'exclude_unknown_project', 'true', false);
      vscode.window.showInformationMessage('Successfully logged in to Hackatime!');
      this.updateStatusBarText('Hackatime: Logged in!');
    } catch (error) {
      this.logger.error(`OAuth login failed: ${error}`);
      vscode.window.showErrorMessage(
        `Failed to complete login: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public async promptForApiKey(hidden: boolean = true): Promise<void> {
    const apiKeyUrl = 'https://hackatime.hackclub.com/api-key';
    const choice = await vscode.window.showInformationMessage(
      'You need a Hackatime API key to continue. Open the setup page in your browser to get one?',
      { modal: true },
      'Get API Key',
      'I Have My API Key',
    );

    if (choice === undefined) {
      vscode.window.setStatusBarMessage('Hackatime api key not provided');
      return;
    }

    if (choice === 'Get API Key') {
      await vscode.env.openExternal(vscode.Uri.parse(apiKeyUrl));
    }

    let defaultVal = await this.options.getApiKey();
    if (Utils.apiKeyInvalid(defaultVal ?? undefined)) defaultVal = '';
    const promptOptions = {
      prompt: 'Hackatime Api Key',
      placeHolder: `Enter your api key from ${apiKeyUrl}`,
      value: defaultVal!,
      ignoreFocusOut: true,
      password: hidden,
      validateInput: Utils.apiKeyInvalid.bind(this),
    };
    vscode.window.showInputBox(promptOptions).then((val) => {
      if (val != undefined) {
        const invalid = Utils.apiKeyInvalid(val);
        if (!invalid) {
          this.options.setSetting('settings', 'api_key', val, false);
        } else vscode.window.setStatusBarMessage(invalid);
      } else vscode.window.setStatusBarMessage('Hackatime api key not provided');
    });
  }

  public async promptForApiUrl(): Promise<void> {
    const apiUrl = await this.options.getApiUrl(true);
    const promptOptions = {
      prompt: 'Hackatime Api Url (Defaults to https://hackatime.hackclub.com/api/hackatime/v1)',
      placeHolder: 'https://hackatime.hackclub.com/api/hackatime/v1',
      value: apiUrl,
      ignoreFocusOut: true,
      validateInput: Utils.validateApiUrl.bind(this),
    };
    vscode.window.showInputBox(promptOptions).then((val) => {
      if (val) {
        this.options.setSetting('settings', 'api_url', val, false);
      }
    });
  }

  public promptForProxy(): void {
    this.options.getSetting('settings', 'proxy', false, (proxy: Setting) => {
      let defaultVal = proxy.value;
      if (!defaultVal) defaultVal = '';
      const promptOptions = {
        prompt: 'Hackatime Proxy',
        placeHolder: `Proxy format is https://user:pass@host:port (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
        validateInput: Utils.validateProxy.bind(this),
      };
      vscode.window.showInputBox(promptOptions).then((val) => {
        if (val || val === '') this.options.setSetting('settings', 'proxy', val, false);
      });
    });
  }

  public promptForDebug(): void {
    this.options.getSetting('settings', 'debug', false, (debug: Setting) => {
      let defaultVal = debug.value;
      if (!defaultVal || defaultVal !== 'true') defaultVal = 'false';
      const items: string[] = ['true', 'false'];
      const promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal == null) return;
        this.options.setSetting('settings', 'debug', newVal, false);
        if (newVal === 'true') {
          this.logger.setLevel(LogLevel.DEBUG);
          this.logger.debug('Debug enabled');
        } else {
          this.logger.setLevel(LogLevel.INFO);
        }
      });
    });
  }

  public promptToDisable(): void {
    this.options.getSetting('settings', 'disabled', false, (setting: Setting) => {
      const previousValue = this.disabled;
      let currentVal = setting.value;
      if (!currentVal || currentVal !== 'true') currentVal = 'false';
      const items: string[] = ['disable', 'enable'];
      const helperText = currentVal === 'true' ? 'disabled' : 'enabled';
      const promptOptions = {
        placeHolder: `disable or enable (extension is currently "${helperText}")`,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal !== 'enable' && newVal !== 'disable') return;
        this.disabled = newVal === 'disable';
        if (this.disabled != previousValue) {
          if (this.disabled) {
            this.options.setSetting('settings', 'disabled', 'true', false);
            this.logger.debug('Extension disabled, will not report code stats to dashboard');
            this.dispose();
          } else {
            this.options.setSetting('settings', 'disabled', 'false', false);
            this.initializeDependencies();
          }
        }
      });
    });
  }

  public promptStatusBarIcon(): void {
    this.options.getSetting('settings', 'status_bar_enabled', false, (setting: Setting) => {
      let defaultVal = setting.value;
      if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
      const items: string[] = ['true', 'false'];
      const promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal !== 'true' && newVal !== 'false') return;
        this.options.setSetting('settings', 'status_bar_enabled', newVal, false);
        this.showStatusBar = newVal === 'true'; // cache setting to prevent reading from disc too often
        this.setStatusBarVisibility(this.showStatusBar);
      });
    });
  }

  public promptStatusBarCodingActivity(): void {
    this.options.getSetting('settings', 'status_bar_coding_activity', false, (setting: Setting) => {
      let defaultVal = setting.value;
      if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
      const items: string[] = ['true', 'false'];
      const promptOptions = {
        placeHolder: `true or false (current value \"${defaultVal}\")`,
        value: defaultVal,
        ignoreFocusOut: true,
      };
      vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
        if (newVal !== 'true' && newVal !== 'false') return;
        this.options.setSetting('settings', 'status_bar_coding_activity', newVal, false);
        if (newVal === 'true') {
          this.logger.debug('Coding activity in status bar has been enabled');
          this.showCodingActivity = true;
          this.getCodingActivity();
        } else {
          this.logger.debug('Coding activity in status bar has been disabled');
          this.showCodingActivity = false;
          if (!this.statusBarShowingError()) {
            this.updateStatusBarText();
          }
        }
      });
    });
  }

  public async openDashboardWebsite(): Promise<void> {
    const apiUrl = await this.options.getApiUrl(true);
    const dashboardUrl = Utils.apiUrlToDashboardUrl(apiUrl);
    vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
  }

  public openConfigFile(): void {
    const path = this.options.getConfigFile(false);
    if (path) {
      const uri = vscode.Uri.file(path);
      vscode.window.showTextDocument(uri);
    }
  }

  public openLogFile(): void {
    const path = this.options.getLogFile();
    if (path) {
      const uri = vscode.Uri.file(path);
      vscode.window.showTextDocument(uri);
    }
  }

  private checkApiKey(): void {
    this.options.hasApiKey((hasApiKey) => {
      if (!hasApiKey) this.loginWithHackatime();
    });
  }

  private checkUnauthorizedSettings(): void {
    const unauthorizedSettings = [
      'hide_file_names',
      'hide_project_names'
    ]

    let found: string[] = [];
    for (const settingName of unauthorizedSettings) {
      this.options.getSetting('settings', settingName, false, (setting: Setting) => {
        if (setting.value === 'true') {
          found.push(settingName);
        }
      })
    }

    if (found.length > 0) {
      vscode.window.showWarningMessage(
        `The following settings are not allowed by Hack Club programs:\n - ${found.join('\n - ')}`,
        { modal: true },
        'Ignore (NOT RECOMMENDED)',
        'Fix Settings',
      ).then((choice) => {
        if (choice === 'Fix Settings') {
          for (const settingName of found) {
            this.options.setSetting('settings', settingName, 'false', false);
          }
          vscode.window.showInformationMessage('Fixed unauthorized settings!');
        } else {
          this.logger.warn(`User chose to ignore unauthorized settings: ${found.join(', ')}`);
        }
      });
    }
  }

  private setStatusBarVisibility(isVisible: boolean): void {
    if (isVisible) {
      this.statusBar?.show();
      this.statusBarTeamYou?.show();
      this.statusBarTeamOther?.show();
      this.logger.debug('Status bar icon enabled.');
    } else {
      this.statusBar?.hide();
      this.statusBarTeamYou?.hide();
      this.statusBarTeamOther?.hide();
      this.logger.debug('Status bar icon disabled.');
    }
  }

  private setupEventListeners(): void {
    // subscribe to selection change and editor activation events
    const subscriptions: vscode.Disposable[] = [];
    vscode.window.onDidChangeTextEditorSelection(this.onChangeSelection, this, subscriptions);
    vscode.window.onDidChangeTextEditorVisibleRanges(
      this.onDidChangeTextEditorVisibleRanges,
      this,
      subscriptions,
    );
    vscode.workspace.onDidChangeTextDocument(this.onChangeTextDocument, this, subscriptions);
    vscode.window.onDidChangeActiveTextEditor(this.onChangeTab, this, subscriptions);
    vscode.window.onDidChangeVisibleTextEditors(
      this.onDidChangeVisibleTextEditors,
      this,
      subscriptions,
    );
    vscode.window.tabGroups.onDidChangeTabs(this.onDidChangeTabs, this, subscriptions);
    vscode.window.onDidChangeWindowState(this.onDidChangeWindowState, this, subscriptions);
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, subscriptions);

    vscode.workspace.onDidChangeNotebookDocument(this.onChangeNotebook, this, subscriptions);
    vscode.window.onDidChangeNotebookEditorSelection(
      this.onDidChangeNotebookEditorSelection,
      this,
      subscriptions,
    );
    vscode.workspace.onDidSaveNotebookDocument(this.onSaveNotebook, this, subscriptions);

    vscode.window.onDidChangeActiveTerminal(this.onDidChangeActiveTerminal, this, subscriptions);
    vscode.window.onDidOpenTerminal(this.onDidOpenTerminal, this, subscriptions);

    vscode.tasks.onDidStartTask(this.onDidStartTask, this, subscriptions);
    vscode.tasks.onDidEndTask(this.onDidEndTask, this, subscriptions);

    vscode.debug.onDidChangeActiveDebugSession(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidChangeBreakpoints(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession, this, subscriptions);
    vscode.debug.onDidTerminateDebugSession(this.onDidTerminateDebugSession, this, subscriptions);
    vscode.lm.onDidChangeChatModels(this.onDidChangeChatModels, this, subscriptions);

    // create a combined disposable for all event subscriptions
    this.disposable = vscode.Disposable.from(...subscriptions);
  }

  private onDebuggingChanged(): void {
    this.logger.debug('onDebuggingChanged');
    this.syncAIHeartbeatsDebounced();
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidStartDebugSession(): void {
    this.logger.debug('onDidStartDebugSession');
    this.syncAIHeartbeatsDebounced();
    this.isDebugging = true;
    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidTerminateDebugSession(): void {
    this.logger.debug('onDidTerminateDebugSession');
    this.syncAIHeartbeatsDebounced();
    this.isDebugging = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidStartTask(e: vscode.TaskStartEvent): void {
    this.logger.debug('onDidStartTask');
    this.syncAIHeartbeatsDebounced();
    if (e.execution.task.isBackground) return;
    if (e.execution.task.detail && e.execution.task.detail.indexOf('watch') !== -1) return;
    this.isCompiling = true;
    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidEndTask(): void {
    this.logger.debug('onDidEndTask');
    this.syncAIHeartbeatsDebounced();
    this.isCompiling = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onChangeSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    this.syncAIHeartbeatsDebounced();
    if (!ALLOWED_SCHEMES.includes(e.textEditor?.document?.uri?.scheme)) return;
    if (e.kind === vscode.TextEditorSelectionChangeKind.Command) return;
    this.logger.debug('onChangeSelection');
    if (Utils.isAIChatSidebar(e.textEditor?.document?.uri)) {
      this.isAICodeGenerating = true;
    }
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onChangeTextDocument(e: vscode.TextDocumentChangeEvent): void {
    this.syncAIHeartbeatsDebounced();
    if (!ALLOWED_SCHEMES.includes(e.document?.uri?.scheme)) return;
    this.logger.debug('onChangeTextDocument');

    if (e.contentChanges.find((v) => v.text.length === 1)) {
      const file = Utils.getFocusedFile(e.document);
      if (file) {
        this.filesWithHumanTyping[file] = true;
      }
    }

    if (Utils.isAIChatSidebar(e.document?.uri)) {
      this.isAICodeGenerating = true;
      this.AIdebounceCount = 0;
    } else if (Utils.isPossibleAICodeInsert(e)) {
      const now = Date.now();
      if (this.recentlyAIPasted(now) && this.hasAICapabilities) {
        this.isAICodeGenerating = true;
        this.AIdebounceCount = 0;
      }
      this.AIrecentPastes.push(now);
    } else if (Utils.isPossibleHumanCodeInsert(e)) {
      this.AIrecentPastes = [];
      if (this.isAICodeGenerating) {
        this.AIdebounceCount++;
        clearTimeout(this.AIDebounceId);
        this.AIDebounceId = setTimeout(() => {
          if (this.AIdebounceCount > 1) {
            this.isAICodeGenerating = false;
          }
        }, this.AIdebounceMs);
      }
    } else if (this.isAICodeGenerating) {
      this.AIdebounceCount = 0;
      clearTimeout(this.AIDebounceId);
      this.updateLineNumbers();
    }

    if (!this.isAICodeGenerating) return;

    this.onEvent(false);
  }

  private onChangeTab(e: vscode.TextEditor | undefined): void {
    this.syncAIHeartbeatsDebounced();
    if (!ALLOWED_SCHEMES.includes(e?.document?.uri?.scheme ?? '')) return;
    this.logger.debug('onChangeTab');
    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onDidChangeTabs(e: vscode.TabChangeEvent): void {
    this.logger.debug('onDidChangeTabs');
    this.syncAIHeartbeatsDebounced();
    if (Utils.isCodexCodeReview(e)) {
      this.appendCodeReviewHeartbeat();
      return;
    }
    if (!this.isAICodeGenerating) return;
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private async appendCodeReviewHeartbeat(): Promise<void> {
    if (this.disabled) return;
    if (!this.dependencies.isCliInstalled()) return;

    const time = Date.now();
    if (this.lastCodeReviewing && !Utils.enoughTimePassed(this.lastHeartbeat, time)) return;

    const editor = vscode.window.activeTextEditor;
    const doc = editor?.document;
    const file = doc ? Utils.getFocusedFile(doc) : undefined;
    const entity = file ?? 'Codex Diff';

    const heartbeat: Heartbeat = {
      entity,
      time: time / 1000,
      is_write: false,
      category: 'code reviewing',
    };

    if (doc) {
      heartbeat.lines_in_file = doc.lineCount;
      if (editor) {
        heartbeat.lineno = editor.selection.start.line + 1;
        heartbeat.cursorpos = editor.selection.start.character + 1;
      }
      const project = this.getProjectName(doc.uri);
      if (project) heartbeat.alternate_project = project;
      const folder = this.getProjectFolder(doc.uri);
      if (folder) heartbeat.project_folder = folder;
      if (doc.isUntitled) heartbeat.is_unsaved_entity = true;
    } else {
      heartbeat.entity_type = 'app';
      const wsf = vscode.workspace.workspaceFolders?.[0];
      if (wsf) {
        heartbeat.alternate_project = wsf.name;
        heartbeat.project_folder = wsf.uri.fsPath;
      }
    }

    this.lastFile = entity;
    this.lastHeartbeat = time;
    this.lastCodeReviewing = true;

    this.logger.debug(
      `Appending code-reviewing heartbeat to local buffer: ${JSON.stringify(heartbeat, null, 2)}`,
    );
    this.heartbeats.push(heartbeat);

    await this.sendHeartbeatsIfNecessary();
  }

  private onSave(e: vscode.TextDocument | undefined): void {
    this.logger.debug('onSave');

    const file = Utils.getFocusedFile(e);
    if (file) {
      this.filesWithHumanTyping[file] = true;
    }

    this.syncAIHeartbeatsDebounced();
    this.isAICodeGenerating = false;
    this.updateLineNumbers();
    this.onEvent(true);
  }

  private onChangeNotebook(_e: vscode.NotebookDocumentChangeEvent): void {
    this.logger.debug('onChangeNotebook');
    this.syncAIHeartbeatsDebounced();
    this.updateLineNumbers();
    this.onEvent(false);
  }

  private onSaveNotebook(_e: vscode.NotebookDocument | undefined): void {
    this.logger.debug('onSaveNotebook');
    this.syncAIHeartbeatsDebounced();
    this.updateLineNumbers();
    this.onEvent(true);
  }

  private onDidChangeTextEditorVisibleRanges(_e: vscode.TextEditorVisibleRangesChangeEvent): void {
    this.logger.debug('onDidChangeTextEditorVisibleRanges');
    this.syncAIHeartbeatsDebounced();
  }

  private onDidChangeVisibleTextEditors(_e: readonly vscode.TextEditor[]): void {
    this.logger.debug('onDidChangeVisibleTextEditors');
    this.syncAIHeartbeatsDebounced();
  }

  private onDidChangeWindowState(e: vscode.WindowState): void {
    if (!e.focused) return;
    this.logger.debug('onDidChangeWindowState');
    this.syncAIHeartbeatsDebounced();
  }

  private onDidChangeNotebookEditorSelection(_e: vscode.NotebookEditorSelectionChangeEvent): void {
    this.logger.debug('onDidChangeNotebookEditorSelection');
    this.syncAIHeartbeatsDebounced();
  }

  private onDidChangeActiveTerminal(_e: vscode.Terminal | undefined): void {
    this.logger.debug('onDidChangeActiveTerminal');
    this.syncAIHeartbeatsDebounced();
  }

  private onDidOpenTerminal(_e: vscode.Terminal): void {
    this.logger.debug('onDidOpenTerminal');
    this.syncAIHeartbeatsDebounced();
  }

  private onDidChangeChatModels(): void {
    this.logger.debug('onDidChangeChatModels');
    this.syncAIHeartbeatsDebounced();
  }

  private updateLineNumbers(): void {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) return;
    const file = Utils.getFocusedFile(doc);
    if (!file) return;

    const now = Date.now();
    const current = doc.lineCount;
    if (this.linesInFiles[file] === undefined) {
      this.linesInFiles[file] = { lines: current, updatedAt: now };
    }

    const prev = this.linesInFiles[file] ?? { lines: current, updatedAt: now };
    let delta = current - prev.lines;

    // prevent counting large copy/paste as human typed lines of code
    if (delta > 50 && Math.abs(now - prev.updatedAt) < 60000) {
      delta = 0;
    }

    const changes = this.isAICodeGenerating ? this.lineChanges.ai : this.lineChanges.human;
    changes[file] = (changes[file] ?? 0) + delta;

    this.linesInFiles[file] = { lines: current, updatedAt: now };
  }

  private onEvent(isWrite: boolean): void {
    this.sendHeartbeatsIfNecessary();

    clearTimeout(this.debounceId);
    this.debounceId = setTimeout(() => {
      if (this.disabled) return;
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const doc = editor.document;
        if (doc) {
          const file = Utils.getFocusedFile(doc);
          if (!file) {
            return;
          }
          if (this.currentlyFocusedFile !== file) {
            this.updateTeamStatusBarFromJson();
            this.updateTeamStatusBar(doc);
          }

          const time: number = Date.now();
          if (
            isWrite ||
            Utils.enoughTimePassed(this.lastHeartbeat, time) ||
            this.lastFile !== file ||
            this.lastDebug !== this.isDebugging ||
            this.lastCompile !== this.isCompiling ||
            this.lastAICodeGenerating !== this.isAICodeGenerating
          ) {
            this.appendHeartbeat(
              doc,
              time,
              editor.selection.start,
              isWrite,
              this.isCompiling,
              this.isDebugging,
              this.isAICodeGenerating,
            );
            this.lastFile = file;
            this.lastHeartbeat = time;
            this.lastDebug = this.isDebugging;
            this.lastCompile = this.isCompiling;
            this.lastAICodeGenerating = this.isAICodeGenerating;
          }
        }
      }
    }, this.debounceMs);
  }

  private async appendHeartbeat(
    doc: vscode.TextDocument,
    time: number,
    selection: vscode.Position,
    isWrite: boolean,
    isCompiling: boolean,
    isDebugging: boolean,
    isAICoding: boolean,
  ): Promise<void> {
    if (!this.dependencies.isCliInstalled()) return;

    const file = Utils.getFocusedFile(doc);
    if (!file) return;

    // prevent sending the same heartbeat (https://github.com/hackatime/vscode-hackatime/issues/163)
    if (isWrite && this.isDuplicateHeartbeat(file, time, selection)) return;

    const now = Date.now();

    const heartbeat: Heartbeat = {
      entity: file,
      time: now / 1000,
      is_write: isWrite,
      lineno: selection.line + 1,
      cursorpos: selection.character + 1,
      lines_in_file: doc.lineCount,
      ai_line_changes: this.lineChanges.ai[file],
      human_line_changes: this.lineChanges.human[file],
    };

    // Remove human line changes if we never detected human typing
    if (!this.filesWithHumanTyping[file]) heartbeat.human_line_changes = 0;
    this.filesWithHumanTyping[file] = false;

    this.lineChanges = { ai: {}, human: {} };

    if (isDebugging) {
      heartbeat.category = 'debugging';
    } else if (isCompiling) {
      heartbeat.category = 'building';
    } else if (isAICoding) {
      heartbeat.category = 'ai coding';
    } else if (Utils.isPullRequest(doc.uri)) {
      heartbeat.category = 'code reviewing';
    }
    this.lastCodeReviewing = heartbeat.category === 'code reviewing';

    const project = this.getProjectName(doc.uri);
    if (project) heartbeat.alternate_project = project;

    const folder = this.getProjectFolder(doc.uri);
    if (folder) heartbeat.project_folder = folder;

    if (doc.isUntitled) heartbeat.is_unsaved_entity = true;

    await this.maybePromptForMissingGitRepo(folder, project);

    if (Utils.isRemoteUri(doc.uri)) {
      try {
        const tmpFile = path.join(
          os.tmpdir(),
          `hackatime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        );
        await fs.promises.writeFile(tmpFile, doc.getText(), {
          encoding: doc.encoding as BufferEncoding,
        });
        heartbeat.local_file = tmpFile;
        heartbeat.entity = doc.fileName;
      } catch (e) {
        this.logger.debugException(e);
      }
    }

    this.logger.debug(`Appending heartbeat to local buffer: ${JSON.stringify(heartbeat, null, 2)}`);
    this.heartbeats.push(heartbeat);

    await this.sendHeartbeatsIfNecessary();
  }

  private async sendHeartbeatsIfNecessary() {
    if (Date.now() - this.lastSent > SEND_BUFFER_SECONDS * 1000) {
      await this.sendHeartbeats();
    }
  }

  private async sendHeartbeats(): Promise<void> {
    const apiKey = await this.options.getApiKey();
    if (apiKey) {
      await this._sendHeartbeats();
    } else {
      await this.promptForApiKey();
    }
  }

  private syncAIHeartbeatsDebounced(): void {
    if (this.disabled) return;
    if (this.syncAIHeartbeatsDebounce) clearTimeout(this.syncAIHeartbeatsDebounce);

    this.syncAIHeartbeatsDebounce = setTimeout(() => {
      this.syncAIHeartbeatsDebounce = undefined;
      this.syncAIHeartbeats();
    }, SYNC_AI_HEARTBEATS_DEBOUNCE_SECONDS * 1000);
  }

  private async syncAIHeartbeats(): Promise<void> {
    if (!this.dependencies.isCliInstalled()) return;

    const user_agent =
      this.editorName + '/' + vscode.version + ' vscode-hackatime/' + this.extension.version;
    const args = ['--sync-ai-activity', '--plugin', Utils.quote(user_agent)];

    if (this.isMetricsEnabled) args.push('--metrics');

    const doc = vscode.window.activeTextEditor?.document;
    if (doc) {
      const project = this.getProjectName(doc.uri);
      if (project) {
        args.push('--alternate-project');
        args.push(project);
      }
      const folder = this.getProjectFolder(doc.uri);
      if (folder) {
        args.push('--project-folder');
        args.push(folder);
      }
    }

    const apiKey = await this.options.getApiKey();
    if (!Utils.apiKeyInvalid(apiKey)) args.push('--key', Utils.quote(apiKey));

    const apiUrl = await this.options.getApiUrl();
    if (apiUrl) args.push('--api-url', Utils.quote(apiUrl));

    if (Desktop.isWindows() || Desktop.isPortable()) {
      args.push(
        '--config',
        Utils.quote(this.options.getConfigFile(false)),
        '--log-file',
        Utils.quote(this.options.getLogFile()),
      );
    }

    const binary = this.dependencies.getCliLocation();
    this.logger.debug(`Syncing AI heartbeats: ${Utils.formatArguments(binary, args)}`);
    const options = Desktop.buildOptions();

    try {
      child_process.execFile(binary, args, options, (error, stdout, stderr) => {
        if (error != null) {
          if (stderr && stderr.toString() != '') this.logger.debug(stderr.toString());
          if (stdout && stdout.toString() != '') this.logger.debug(stdout.toString());
          this.logger.debug(error.toString());
        }
      });
    } catch (e) {
      this.logger.debugException(e);
    }
  }

  private async _sendHeartbeats(): Promise<void> {
    if (!this.dependencies.isCliInstalled()) return;

    const heartbeat = this.heartbeats.shift();
    if (!heartbeat) return;

    this.lastSent = Date.now();

    const args: string[] = [];

    args.push('--entity', Utils.quote(heartbeat.entity));

    if (heartbeat.entity_type) {
      args.push('--entity-type', heartbeat.entity_type);
    }

    args.push('--time', String(heartbeat.time));

    if (heartbeat.plugin) {
      args.push('--plugin', Utils.quote(heartbeat.plugin));
    } else {
      args.push(
        '--plugin',
        Utils.quote(
          Utils.buildUserAgentString(this.editorName, this.extension.version, heartbeat.agent),
        ),
      );
    }

    if (heartbeat.lineno) args.push('--lineno', String(heartbeat.lineno));
    if (heartbeat.cursorpos) args.push('--cursorpos', String(heartbeat.cursorpos));
    if (heartbeat.lines_in_file) args.push('--lines-in-file', String(heartbeat.lines_in_file));
    if (heartbeat.category) {
      args.push('--category', heartbeat.category);
    }

    if (heartbeat.ai_line_changes) {
      args.push('--ai-line-changes', String(heartbeat.ai_line_changes));
    }
    if (heartbeat.human_line_changes) {
      args.push('--human-line-changes', String(heartbeat.human_line_changes));
    }

    if (this.isMetricsEnabled) args.push('--metrics');

    const apiKey = await this.options.getApiKey();
    if (!Utils.apiKeyInvalid(apiKey)) args.push('--key', Utils.quote(apiKey));

    const apiUrl = await this.options.getApiUrl();
    if (apiUrl) args.push('--api-url', Utils.quote(apiUrl));

    if (heartbeat.alternate_project) {
      args.push('--alternate-project', Utils.quote(heartbeat.alternate_project));
    }

    if (heartbeat.project_folder) {
      args.push('--project-folder', Utils.quote(heartbeat.project_folder));
    }

    if (heartbeat.is_write) args.push('--write');

    if (Desktop.isWindows() || Desktop.isPortable()) {
      args.push(
        '--config',
        Utils.quote(this.options.getConfigFile(false)),
        '--log-file',
        Utils.quote(this.options.getLogFile()),
      );
    }

    if (heartbeat.is_unsaved_entity) args.push('--is-unsaved-entity');

    const cleanup: string[] = [];
    if (heartbeat.local_file) {
      args.push('--local-file');
      args.push(Utils.quote(heartbeat.local_file));
      cleanup.push(heartbeat.local_file);
    }

    const extraHeartbeats = this.getExtraHeartbeats();
    if (extraHeartbeats.length > 0) args.push('--extra-heartbeats');

    const binary = this.dependencies.getCliLocation();
    this.logger.debug(`Sending heartbeat: ${Utils.formatArguments(binary, args)}`);
    const options = Desktop.buildOptions(extraHeartbeats.length > 0);
    const proc = child_process.execFile(binary, args, options, (error, stdout, stderr) => {
      if (error != null) {
        if (stderr && stderr.toString() != '') this.logger.error(stderr.toString());
        if (stdout && stdout.toString() != '') this.logger.error(stdout.toString());
        this.logger.error(error.toString());
      }
    });

    // send any extra heartbeats
    if (proc.stdin) {
      proc.stdin.write(JSON.stringify(extraHeartbeats));
      proc.stdin.write('\n');
      proc.stdin.end();
      cleanup.push(...(extraHeartbeats.map((h) => h.local_file).filter(Boolean) as string[]));
    } else if (extraHeartbeats.length > 0) {
      this.logger.error('Unable to set stdio[0] to pipe');
      this.heartbeats.push(...extraHeartbeats);
    }

    proc.on('close', async (code, _signal) => {
      if (code == 0) {
        if (this.showStatusBar) this.getCodingActivity();
      } else if (code == 102 || code == 112) {
        if (this.showStatusBar) {
          if (!this.showCodingActivity) this.updateStatusBarText();
          this.updateStatusBarTooltip(
            'Hackatime: working offline... coding activity will sync next time we are online',
          );
        }
        this.logger.warn(
          `Working offline (${code}); Check your ${this.options.getLogFile()} file for more details`,
        );
      } else if (code == 103) {
        const error_msg = `Config parsing error (103); Check your ${this.options.getLogFile()} file for more details`;
        if (this.showStatusBar) {
          this.updateStatusBarText('Hackatime Error');
          this.updateStatusBarTooltip(`Hackatime: ${error_msg}`);
        }
        this.logger.error(error_msg);
      } else if (code == 104) {
        const error_msg = 'Invalid Api Key (104); Make sure your Api Key is correct!';
        if (this.showStatusBar) {
          this.updateStatusBarText('Hackatime Error');
          this.updateStatusBarTooltip(`Hackatime: ${error_msg}`);
        }
        this.logger.error(error_msg);
        const now: number = Date.now();
        if (this.lastApiKeyPrompted < now - 86400000) {
          // only prompt once per day
          await this.promptForApiKey(false);
          this.lastApiKeyPrompted = now;
        }
      } else {
        const error_msg = `Unknown Error (${code}); Check your ${this.options.getLogFile()} file for more details`;
        if (this.showStatusBar) {
          this.updateStatusBarText('Hackatime Error');
          this.updateStatusBarTooltip(`Hackatime: ${error_msg}`);
        }
        this.logger.error(error_msg);
      }

      cleanup.map((tmpfile) => {
        try {
          fs.unlinkSync(tmpfile);
        } catch (_) {}
      });
    });
  }

  private getExtraHeartbeats() {
    const heartbeats: Heartbeat[] = [];
    while (true) {
      const h = this.heartbeats.shift();
      if (!h) return heartbeats;
      heartbeats.push(h);
    }
  }

  private async getCodingActivity() {
    if (!this.showStatusBar) return;

    const cutoff = Date.now() - this.fetchTodayInterval;
    if (this.lastFetchToday > cutoff) return;

    this.lastFetchToday = Date.now();

    const apiKey = await this.options.getApiKey();
    if (!apiKey) return;

    await this._getCodingActivity();
  }

  private async _getCodingActivity() {
    if (!this.dependencies.isCliInstalled()) return;

    const user_agent =
      this.editorName + '/' + vscode.version + ' vscode-hackatime/' + this.extension.version;
    const args = ['--today', '--output', 'json', '--plugin', Utils.quote(user_agent)];

    if (this.isMetricsEnabled) args.push('--metrics');

    const apiKey = await this.options.getApiKey();
    if (!Utils.apiKeyInvalid(apiKey)) args.push('--key', Utils.quote(apiKey));

    const apiUrl = await this.options.getApiUrl();
    if (apiUrl) args.push('--api-url', Utils.quote(apiUrl));

    if (Desktop.isWindows()) {
      args.push(
        '--config',
        Utils.quote(this.options.getConfigFile(false)),
        '--logfile',
        Utils.quote(this.options.getLogFile()),
      );
    }

    const binary = this.dependencies.getCliLocation();
    this.logger.debug(
      `Fetching coding activity for Today from api: ${Utils.formatArguments(binary, args)}`,
    );
    const options = Desktop.buildOptions();

    try {
      const proc = child_process.execFile(binary, args, options, (error, stdout, stderr) => {
        if (error != null) {
          if (stderr && stderr.toString() != '') this.logger.debug(stderr.toString());
          if (stdout && stdout.toString() != '') this.logger.debug(stdout.toString());
          this.logger.debug(error.toString());
        }
      });
      let output = '';
      if (proc.stdout) {
        proc.stdout.on('data', (data: string | null) => {
          if (data) output += data;
        });
      }
      proc.on('close', (code, _signal) => {
        if (code == 0) {
          if (this.showStatusBar) {
            if (output) {
              let jsonData: any;
              try {
                jsonData = JSON.parse(output);
              } catch (e) {
                this.logger.debug(
                  `Error parsing today coding activity as json:\n${output}\nCheck your ${this.options.getLogFile()} file for more details.`,
                );
              }
              if (jsonData) this.hasTeamFeatures = jsonData?.has_team_features;
              if (jsonData?.text) {
                if (this.showCodingActivity) {
                  this.updateStatusBarText(jsonData.text.trim());
                  this.updateStatusBarTooltip(
                    'Hackatime: Today’s coding time. Click to visit dashboard.',
                  );
                } else {
                  this.updateStatusBarText();
                  this.updateStatusBarTooltip(jsonData.text.trim());
                }
              } else {
                this.updateStatusBarText();
                this.updateStatusBarTooltip(
                  'Hackatime: Calculating time spent today in background...',
                );
              }
              this.updateTeamStatusBar();
            } else {
              this.updateStatusBarText();
              this.updateStatusBarTooltip(
                'Hackatime: Calculating time spent today in background...',
              );
            }
          }
        } else if (code == 102 || code == 112) {
          // noop, working offline
        } else {
          this.logger.debug(
            `Error fetching today coding activity (${code}); Check your ${this.options.getLogFile()} file for more details.`,
          );
        }
      });
    } catch (e) {
      this.logger.debugException(e);
    }
  }

  private async updateTeamStatusBar(doc?: vscode.TextDocument) {
    if (!this.showStatusBarTeam) return;
    if (!this.hasTeamFeatures) return;
    if (!this.dependencies.isCliInstalled()) return;

    if (!doc) {
      doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
    }

    const file = Utils.getFocusedFile(doc);
    if (!file) {
      return;
    }

    this.currentlyFocusedFile = file;

    // TODO: expire cached text after some hours
    if (this.teamDevsForFileCache[file]) {
      this.updateTeamStatusBarFromJson(this.teamDevsForFileCache[file]);
      return;
    }

    const user_agent =
      this.editorName + '/' + vscode.version + ' vscode-hackatime/' + this.extension.version;
    const args = ['--output', 'json', '--plugin', Utils.quote(user_agent)];

    args.push('--file-experts', Utils.quote(file));

    args.push('--entity', Utils.quote(file));

    if (this.isMetricsEnabled) args.push('--metrics');

    const apiKey = await this.options.getApiKey();
    if (!Utils.apiKeyInvalid(apiKey)) args.push('--key', Utils.quote(apiKey));

    const apiUrl = await this.options.getApiUrl();
    if (apiUrl) args.push('--api-url', Utils.quote(apiUrl));

    const project = this.getProjectName(doc.uri);
    if (project) args.push('--alternate-project', Utils.quote(project));

    const folder = this.getProjectFolder(doc.uri);
    if (folder) args.push('--project-folder', Utils.quote(folder));

    if (Desktop.isWindows()) {
      args.push(
        '--config',
        Utils.quote(this.options.getConfigFile(false)),
        '--logfile',
        Utils.quote(this.options.getLogFile()),
      );
    }

    if (doc.isUntitled) args.push('--is-unsaved-entity');

    const binary = this.dependencies.getCliLocation();
    this.logger.debug(`Fetching devs for file from api: ${Utils.formatArguments(binary, args)}`);
    const options = Desktop.buildOptions();

    try {
      const proc = child_process.execFile(binary, args, options, (error, stdout, stderr) => {
        if (error != null) {
          if (stderr && stderr.toString() != '') this.logger.debug(stderr.toString());
          if (stdout && stdout.toString() != '') this.logger.debug(stdout.toString());
          this.logger.debug(error.toString());
        }
      });
      let output = '';
      if (proc.stdout) {
        proc.stdout.on('data', (data: string | null) => {
          if (data) output += data;
        });
      }
      proc.on('close', (code, _signal) => {
        if (code == 0) {
          if (output && output.trim()) {
            let jsonData;
            try {
              jsonData = JSON.parse(output);
            } catch (e) {
              this.logger.debug(
                `Error parsing devs for file as json:\n${output}\nCheck your ${this.options.getLogFile()} file for more details.`,
              );
            }

            if (jsonData) this.teamDevsForFileCache[file!] = jsonData;

            // make sure this file is still the currently focused file
            if (file !== this.currentlyFocusedFile) {
              return;
            }

            this.updateTeamStatusBarFromJson(jsonData);
          } else {
            this.updateTeamStatusBarTextForCurrentUser();
            this.updateTeamStatusBarTextForOther();
          }
        } else if (code == 102 || code == 112) {
          // noop, working offline
        } else {
          this.logger.debug(
            `Error fetching devs for file (${code}); Check your ${this.options.getLogFile()} file for more details.`,
          );
        }
      });
    } catch (e) {
      this.logger.debugException(e);
    }
  }

  private updateTeamStatusBarFromJson(jsonData?: any) {
    if (!jsonData) {
      this.updateTeamStatusBarTextForCurrentUser();
      this.updateTeamStatusBarTextForOther();
      return;
    }

    const you = jsonData.you;
    const other = jsonData.other;

    if (you) {
      this.updateTeamStatusBarTextForCurrentUser('You: ' + you.total.text);
      this.updateStatusBarTooltipForCurrentUser('Your total time spent in this file');
    } else {
      this.updateTeamStatusBarTextForCurrentUser();
    }
    if (other) {
      this.updateTeamStatusBarTextForOther(other.user.name + ': ' + other.total.text);
      this.updateStatusBarTooltipForOther(
        other.user.long_name + '’s total time spent in this file',
      );
    } else {
      this.updateTeamStatusBarTextForOther();
    }
  }

  private recentlyAIPasted(time: number): boolean {
    this.AIrecentPastes = this.AIrecentPastes.filter((x) => x + AI_RECENT_PASTES_TIME_MS >= time);
    return this.AIrecentPastes.length > 3;
  }

  private isDuplicateHeartbeat(file: string, time: number, selection: vscode.Position): boolean {
    let duplicate = false;
    const minutes = 10;
    const milliseconds = minutes * 60000;
    if (
      this.dedupe[file] &&
      this.dedupe[file].lastHeartbeatAt + milliseconds > time &&
      this.dedupe[file].selection.line == selection.line &&
      this.dedupe[file].selection.character == selection.character
    ) {
      duplicate = true;
    }
    this.dedupe[file] = {
      selection: selection,
      lastHeartbeatAt: time,
    };
    return duplicate;
  }

  private getProjectName(uri: vscode.Uri): string {
    if (!vscode.workspace) return '';
    const folder = this.getProjectFolder(uri);
    const projectName = this.getProjectNameFromWakatimeProject(folder);
    if (projectName) return projectName;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      try {
        return workspaceFolder.name;
      } catch (e) {}
    }
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      return vscode.workspace.workspaceFolders[0].name;
    }
    return vscode.workspace.name || '';
  }

  private getProjectFolder(uri: vscode.Uri): string {
    if (!vscode.workspace) return '';
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      try {
        return workspaceFolder.uri.fsPath;
      } catch (e) {}
    }
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    return '';
  }

  private normalizeProjectKey(folder: string): string {
    const resolved = path.resolve(folder);
    return Desktop.isWindows() ? resolved.toLowerCase() : resolved;
  }

  private getProjectNameFromWakatimeProject(folder: string): string {
    if (!folder) return '';

    const wakatimeProjectFile = path.join(folder, '.wakatime-project');
    try {
      if (!fs.existsSync(wakatimeProjectFile)) return '';

      const contents = fs.readFileSync(wakatimeProjectFile, 'utf8');
      const firstNonEmptyLine = contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      return firstNonEmptyLine || '';
    } catch (error) {
      this.logger.debug(`Unable to read .wakatime-project from ${folder}: ${error}`);
      return '';
    }
  }

  private getDismissedUnknownProjectFolders(): string[] {
    return this.state.get<string[]>('hackatime.unknownProjectPrompt.dismissedProjects', []);
  }

  private isUnknownProjectPromptDisabled(): boolean {
    return this.state.get<boolean>('hackatime.unknownProjectPrompt.disabled', false);
  }
  private async maybePromptForMissingGitRepo(folder: string, project: string): Promise<void> {
    if (!folder || !project) return;
    if (this.isUnknownProjectPromptDisabled()) return;

    const projectKey = this.normalizeProjectKey(folder);
    if (this.getDismissedUnknownProjectFolders().includes(projectKey)) return;

    if (this.hasGitRepository(folder) || this.hasWakatimeProjectFile(folder)) return;

    if (this.pendingMissingGitRepoPrompt === projectKey) return;
    this.pendingMissingGitRepoPrompt = projectKey;

    try {
      const choice = await vscode.window.showInformationMessage(
        `Hackatime is not properly tracking time in ${project} because no git repository was found.`,
        'Initialize git',
        'Ignore for project',
        'Disable alerts',
      );

      if (choice === 'Initialize git') {
        await this.initGitRepository(folder);
        if (this.hasGitRepository(folder)) {
           await this.dismissUnknownProjectPromptForProject(projectKey);
        }
        return;
      }

      if (choice === 'Ignore for project') {
        await this.dismissUnknownProjectPromptForProject(projectKey);
        return;
      }

      if (choice === 'Disable alerts') {
        await this.state.update('hackatime.unknownProjectPrompt.disabled', true);
      }
    } finally {
      if (this.pendingMissingGitRepoPrompt === projectKey) {
        this.pendingMissingGitRepoPrompt = undefined;
      }
    }
  }

  private hasGitRepository(folder: string): boolean {
    let current = path.resolve(folder);
    let depth = 0;

    while (depth < Hackatime.MAX_PROJECT_SEARCH_DEPTH) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return true;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
      depth += 1;
    }

    return false;
  }

  private hasWakatimeProjectFile(folder: string): boolean {
    let current = path.resolve(folder);
    let depth = 0;

    while (depth < Hackatime.MAX_PROJECT_SEARCH_DEPTH) {
      if (fs.existsSync(path.join(current, '.wakatime-project'))) {
        return true;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      current = parent;
      depth += 1;
    }

    return false;
  }

  private async initGitRepository(folder: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => {
        child_process.execFile('git', ['init'], { cwd: folder }, (error, stdout, stderr) => {
          if (stdout && stdout.toString().trim()) {
            this.logger.debug(stdout.toString().trim());
          }
          if (stderr && stderr.toString().trim()) {
            this.logger.debug(stderr.toString().trim());
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      vscode.window.showInformationMessage('Initialized git repository for this project.');
    } catch (error) {
      this.logger.error(`Failed to initialize git repository: ${error}`);
      vscode.window.showErrorMessage(
        `Failed to initialize git repository: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async dismissUnknownProjectPromptForProject(projectKey: string): Promise<void> {
    const dismissed = this.getDismissedUnknownProjectFolders();
    if (!dismissed.includes(projectKey)) {
      dismissed.push(projectKey);
      await this.state.update('hackatime.unknownProjectPrompt.dismissedProjects', dismissed);
    }
  }
}
