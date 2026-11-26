// SPDX-License-Identifier: BSD-3-Clause
// Copyright (C) 2026 Hackatime Contributors

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DetectedIde } from './ideDetector';
import { DaemonIpcClient } from './ipcClient';

interface LineInterval {
  startLine: number;
  endLine: number;
  createdMs: number;
}

const AI_INTERVAL_TTL_MS = 10 * 60 * 1000; // 10 minutes
const FORMAT_GATE_MS = 750;
const GIT_RELOAD_GATE_MS = 2500;
const SELF_SAVE_GATE_MS = 4000;
const HUMAN_FILE_CREATE_GATE_MS = 5000;
const MIN_EXTERNAL_AI_WRITE_BYTES = 120;
const MIN_EXTERNAL_AI_WRITE_LINES = 4;
const AUTONOMOUS_AI_GRACE_MS = 20_000;

/**
 * Multi-Factor Cross-IDE AI vs. Human Attribution Engine:
 * - Zero state.vscdb hacks, zero naive >40-char false triggers
 * - Excludes formatters (onWillSaveTextDocument), undo/redo, clipboard pastes, Git checkouts
 * - Tracks AI edits from both WorkspaceEdit/inline completions AND external agent disk writes
 *   (Antigravity Agent, Cursor Composer, Windsurf Cascade, Claude Code, Aider)
 */
export class MultiFactorAttributionEngine implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly aiIntervals = new Map<string, LineInterval[]>();
  private readonly formattingUntil = new Map<string, number>();
  private readonly selfSavedUntil = new Map<string, number>();
  private readonly lastLineCounts = new Map<string, number>();
  private readonly lastSavedTextHash = new Map<string, number>();
  private readonly editedLinesSinceSave = new Map<string, Set<number>>();
  private readonly lastScrollState = new Map<string, { line: number; ts: number }>();

  private gitReloadUntilMs = 0;
  private manualCharsBuffer = 0;
  private manualBurstsCount = 0;
  private lastManualKeystrokeMs = 0;
  private lastManualEmitMs = 0;
  private lastExploreEmitMs = 0;
  private lastDiffScrollEmitMs = 0;
  private lastAiWriteMs = 0;
  private lastHumanEditMs = 0;
  private recentTabSwitches = 0;
  private lastFileUri = '';
  private undoStreakAfterError = 0;
  private hasActiveDiagnosticsErrors = false;

  constructor(
    private readonly ipc: DaemonIpcClient,
    private readonly ide: DetectedIde
  ) {
    this.registerListeners();
  }

  public setHasActiveErrors(active: boolean): void {
    this.hasActiveDiagnosticsErrors = active;
  }

  /**
   * Returns true if the most recent code edit was an autonomous AI write (disk write or
   * multi-hunk WorkspaceEdit / completion) with zero subsequent human typing/saves.
   */
  public wasLastEditAutonomousAi(now: number = Date.now()): boolean {
    return this.lastAiWriteMs > this.lastHumanEditMs && now - this.lastAiWriteMs <= AUTONOMOUS_AI_GRACE_MS;
  }

  private resolveProjectRoot(uri: vscode.Uri): string {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return folder.uri.fsPath;
    }
    const first = vscode.workspace.workspaceFolders?.[0];
    return first ? first.uri.fsPath : path.dirname(uri.fsPath);
  }

  private registerListeners(): void {
    // 1. Exclude formatting edits triggered on save (clang-format, Prettier, rustfmt)
    this.disposables.push(
      vscode.workspace.onWillSaveTextDocument((event) => {
        const key = event.document.uri.toString();
        const now = Date.now();
        this.formattingUntil.set(key, now + FORMAT_GATE_MS);
        this.selfSavedUntil.set(key, now + SELF_SAVE_GATE_MS);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const key = doc.uri.toString();
        const now = Date.now();
        this.selfSavedUntil.set(key, now + SELF_SAVE_GATE_MS);
        this.lastLineCounts.set(key, doc.lineCount);

        // Compute persisted non-trivial diff line count on actual disk save (cross-signal persistence gate)
        const text = doc.getText();
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
          h ^= text.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        const newHash = h >>> 0;
        const prevHash = this.lastSavedTextHash.get(key);
        const touched = this.editedLinesSinceSave.get(key);
        const persistedLines = prevHash !== newHash && touched ? touched.size : 0;
        this.lastSavedTextHash.set(key, newHash);
        this.editedLinesSinceSave.delete(key);

        if (persistedLines > 0) {
          this.lastHumanEditMs = now;
          const isAiTouched = this.pruneIntervals(key, now).length > 0;
          const pts = isAiTouched
            ? Math.min(5.0, Math.max(2.5, persistedLines * 0.6))
            : Math.min(4.0, Math.max(1.5, persistedLines * 0.5));
          void this.ipc.send('struggle.emit', {
            source: 'vscode',
            project_root: this.resolveProjectRoot(doc.uri),
            event_type: isAiTouched ? 'SIG_DIFF_SURGERY' : 'SIG_MANUAL_CODE',
            points_hint: pts,
            persisted_diff_lines: persistedLines,
            file_path: vscode.workspace.asRelativePath(doc.uri, false),
            language: doc.languageId,
            ai_harness: this.ide.aiHarness,
            timestamp_ms: now,
          });
        }
      })
    );

    // 2. Suppress false AI attribution during Git branch checkouts / merges
    const gitHeadWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
    const markGitCheckout = (): void => {
      this.gitReloadUntilMs = Date.now() + GIT_RELOAD_GATE_MS;
    };
    gitHeadWatcher.onDidChange(markGitCheckout);
    gitHeadWatcher.onDidCreate(markGitCheckout);
    this.disposables.push(gitHeadWatcher);

    // 2b. Exclude files created directly by the human inside the VS Code Explorer UI
    this.disposables.push(
      vscode.workspace.onDidCreateFiles((event) => {
        const until = Date.now() + HUMAN_FILE_CREATE_GATE_MS;
        for (const uri of event.files) {
          this.selfSavedUntil.set(uri.toString(), until);
        }
      })
    );

    // 3. External disk-write correlation for agentic IDEs & CLI agents writing directly to disk
    const codeWatcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{ts,tsx,js,jsx,mjs,cjs,css,scss,html,svelte,vue,cpp,hpp,cc,c,h,py,rb,rs,go,java,cs,gd,glsl,wgsl,sql,json,yaml,yml,toml,sh,ps1,bat,prisma,graphql,md}'
    );
    codeWatcher.onDidChange((uri) => this.handleExternalDiskWrite(uri));
    codeWatcher.onDidCreate((uri) => this.handleExternalDiskWrite(uri));
    this.disposables.push(codeWatcher);

    // 4. Primary document change observer (WorkspaceEdit, inline completions, manual typing, diff surgery)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.handleTextDocumentChange(event))
    );

    // 5. Viewport scrolling & multi-file exploration (SIG_CODE_EXPLORE & reading-pace SIG_DIFF_SURGERY)
    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => this.handleVisibleRangeChange(event))
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this.handleActiveEditorChange(editor))
    );
  }

  private pruneIntervals(key: string, now: number): LineInterval[] {
    const existing = this.aiIntervals.get(key);
    if (!existing) {
      return [];
    }
    const fresh = existing.filter((iv) => now - iv.createdMs <= AI_INTERVAL_TTL_MS);
    if (fresh.length === 0) {
      this.aiIntervals.delete(key);
    } else {
      this.aiIntervals.set(key, fresh);
    }
    return fresh;
  }

  private addAiInterval(key: string, startLine: number, endLine: number, now: number): void {
    const list = this.pruneIntervals(key, now);
    list.push({ startLine, endLine: Math.max(startLine, endLine), createdMs: now });
    this.aiIntervals.set(key, list);
  }

  private intersectsAiInterval(key: string, line: number, now: number): boolean {
    const list = this.pruneIntervals(key, now);
    for (const iv of list) {
      if (line >= iv.startLine - 5 && line <= iv.endLine + 5) {
        return true;
      }
    }
    return false;
  }

  private handleExternalDiskWrite(uri: vscode.Uri): void {
    if (uri.scheme !== 'file') {
      return;
    }
    const now = Date.now();
    if (now <= this.gitReloadUntilMs) {
      return; // Ignore Git branch switch waves
    }
    const key = uri.toString();
    if ((this.selfSavedUntil.get(key) ?? 0) >= now) {
      return; // Ignore human editor save or human-created new file
    }

    // Ignore build / dependency directories
    const fsPath = uri.fsPath.replace(/\\/g, '/');
    if (
      fsPath.includes('/node_modules/') ||
      fsPath.includes('/.git/') ||
      fsPath.includes('/build/') ||
      fsPath.includes('/dist/') ||
      fsPath.includes('/out/')
    ) {
      return;
    }

    // Ignore empty or tiny new files (e.g. human creating a blank file from Explorer/terminal)
    // and files the user is actively typing in inside the editor right now!
    const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (openDoc && (openDoc.isDirty || now - this.lastHumanEditMs <= 3000)) {
      return;
    }

    let fileBytes = 0;
    let nonEmptyLines = 0;
    try {
      const stat = fs.statSync(uri.fsPath);
      fileBytes = stat.size;
      if (fileBytes < MIN_EXTERNAL_AI_WRITE_BYTES) {
        return; // Too small to be an external AI agent code write (e.g. empty New File)
      }
      if (fileBytes <= 512 * 1024) {
        const content = fs.readFileSync(uri.fsPath, 'utf8');
        for (const ln of content.split('\n')) {
          if (ln.trim().length > 0) {
            nonEmptyLines += 1;
            if (nonEmptyLines >= MIN_EXTERNAL_AI_WRITE_LINES) {
              break;
            }
          }
        }
      } else {
        nonEmptyLines = MIN_EXTERNAL_AI_WRITE_LINES;
      }
    } catch {
      return;
    }

    if (nonEmptyLines < MIN_EXTERNAL_AI_WRITE_LINES) {
      return;
    }

    const prevLines = this.lastLineCounts.get(key) ?? 0;
    const currentLines = openDoc ? openDoc.lineCount : Math.max(prevLines + nonEmptyLines, nonEmptyLines);
    const estAdded = Math.max(nonEmptyLines, Math.abs(currentLines - prevLines));
    this.lastLineCounts.set(key, currentLines);

    // Track full modified span as AI_GENERATED for subsequent human diff surgery
    this.lastAiWriteMs = now;
    this.addAiInterval(key, 0, Math.max(20, currentLines), now);

    void this.ipc.send('ai.generation', {
      project_root: this.resolveProjectRoot(uri),
      ai_lines_inserted: estAdded,
      ai_gen_events: 1,
      ai_harness: this.ide.isAgenticIde ? this.ide.aiHarness : 'external-agent',
      attribution_source: 'disk_write',
      file_path: vscode.workspace.asRelativePath(uri, false),
      language: openDoc?.languageId ?? '',
      timestamp_ms: now,
    });
  }

  private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const doc = event.document;
    if (doc.uri.scheme !== 'file' || event.contentChanges.length === 0) {
      return;
    }

    const now = Date.now();
    const key = doc.uri.toString();

    // Exclusion Gate 1: Git checkout reload
    if (now <= this.gitReloadUntilMs) {
      this.lastLineCounts.set(key, doc.lineCount);
      return;
    }

    // Exclusion Gate 2: Save-time formatter (clang-format, Prettier, etc.)
    if ((this.formattingUntil.get(key) ?? 0) >= now) {
      this.lastLineCounts.set(key, doc.lineCount);
      return;
    }

    // Exclusion Gate 3: Undo / Redo (never misclassify as AI; detect rollback recovery!)
    if (
      event.reason === vscode.TextDocumentChangeReason.Undo ||
      event.reason === vscode.TextDocumentChangeReason.Redo
    ) {
      if (event.reason === vscode.TextDocumentChangeReason.Undo && this.hasActiveDiagnosticsErrors) {
        this.undoStreakAfterError += 1;
        if (this.undoStreakAfterError >= 3) {
          this.undoStreakAfterError = 0;
          void this.ipc.send('struggle.emit', {
            source: 'vscode',
            project_root: this.resolveProjectRoot(doc.uri),
            event_type: 'SIG_ROLLBACK_RECOVER',
            points_hint: 5.0,
            language: doc.languageId,
            ai_harness: this.ide.aiHarness,
            timestamp_ms: now,
          });
        }
      }
      this.lastLineCounts.set(key, doc.lineCount);
      return;
    }

    const projectRoot = this.resolveProjectRoot(doc.uri);
    const relPath = vscode.workspace.asRelativePath(doc.uri, false);

    // Measure total inserted lines & multi-hunk WorkspaceEdit signature
    let totalInsertedLines = 0;
    let totalInsertedChars = 0;
    let firstEditLine = Number.MAX_SAFE_INTEGER;
    let lastEditLine = 0;

    for (const change of event.contentChanges) {
      totalInsertedChars += change.text.length;
      const newLines = change.text.split('\n').length - 1;
      totalInsertedLines += newLines;
      firstEditLine = Math.min(firstEditLine, change.range.start.line);
      lastEditLine = Math.max(lastEditLine, change.range.start.line + newLines);
    }

    const isMultiHunkWorkspaceEdit = event.contentChanges.length >= 2 && totalInsertedLines >= 4;
    const isLargeAgentOrInlineCompletion =
      totalInsertedLines >= 5 || (totalInsertedChars >= 160 && totalInsertedLines >= 2);

    // Multi-Factor Attribution: WorkspaceEdit or non-clipboard AI completion
    if (isMultiHunkWorkspaceEdit || isLargeAgentOrInlineCompletion) {
      this.lastLineCounts.set(key, doc.lineCount);
      const insertedText = event.contentChanges.length === 1 ? event.contentChanges[0].text : '';

      const recordAiGen = (): void => {
        this.lastAiWriteMs = now;
        this.addAiInterval(key, firstEditLine, lastEditLine, now);
        void this.ipc.send('ai.generation', {
          project_root: projectRoot,
          ai_lines_inserted: Math.max(1, totalInsertedLines),
          ai_gen_events: 1,
          ai_harness: this.ide.isAgenticIde ? this.ide.aiHarness : 'external-agent',
          attribution_source: isMultiHunkWorkspaceEdit ? 'workspace_edit' : 'inline_completion',
          file_path: relPath,
          language: doc.languageId,
          timestamp_ms: now,
        });
      };

      // Distinguish human Ctrl+V clipboard pastes from AI inline completions strictly in RAM
      if (!isMultiHunkWorkspaceEdit && insertedText.length > 0) {
        void vscode.env.clipboard.readText().then(
          (clip) => {
            const normClip = clip.replace(/\r\n/g, '\n').trim();
            const normIns = insertedText.replace(/\r\n/g, '\n').trim();
            if (normClip.length > 0 && normClip === normIns) {
              // Human clipboard paste — stay in normal Hackatime mode
              this.lastHumanEditMs = now;
              return;
            }
            recordAiGen();
          },
          () => {
            recordAiGen();
          }
        );
      } else {
        recordAiGen();
      }
      return;
    }

    // Natural human typing cadence (1-15 char bursts, or deliberate deletions)
    const isNaturalHumanEdit =
      event.contentChanges.length === 1 && totalInsertedChars <= 15;
    if (!isNaturalHumanEdit) {
      // Single-hunk medium paste (16-159 chars, <5 lines): excluded from both AI penalty and manual farming
      this.lastLineCounts.set(key, doc.lineCount);
      return;
    }

    this.lastHumanEditMs = now;

    // Record touched lines for cross-signal save-time persistence corroboration
    if (doc.uri.scheme === 'file') {
      let lineSet = this.editedLinesSinceSave.get(key);
      if (!lineSet) {
        lineSet = new Set<number>();
        this.editedLinesSinceSave.set(key, lineSet);
      }
      for (let ln = firstEditLine; ln <= Math.min(lastEditLine, firstEditLine + 50); ln++) {
        lineSet.add(ln);
      }
    }

    // Check if human edit is performing Post-AI Diff Surgery inside/adjacent to an AI interval
    if (this.intersectsAiInterval(key, firstEditLine, now)) {
      if (now - this.lastManualEmitMs >= 8000) {
        this.lastManualEmitMs = now;
        void this.ipc.send('struggle.emit', {
          source: 'vscode',
          project_root: projectRoot,
          event_type: 'SIG_DIFF_SURGERY',
          points_hint: 4.5,
          persisted_diff_lines: Math.max(1, totalInsertedLines + 1),
          file_path: relPath,
          language: doc.languageId,
          ai_harness: this.ide.aiHarness,
          timestamp_ms: now,
        });
      }
      this.lastLineCounts.set(key, doc.lineCount);
      return;
    }

    // Pure Manual Authoring accumulation (SIG_MANUAL_CODE — requires persisted diff lines to score)
    const deltaMs = now - this.lastManualKeystrokeMs;
    if (deltaMs >= 30 && deltaMs <= 4000) {
      this.manualCharsBuffer += Math.max(1, totalInsertedChars);
      this.manualBurstsCount += 1;
    } else {
      this.manualCharsBuffer = Math.max(1, totalInsertedChars);
      this.manualBurstsCount = 1;
    }
    this.lastManualKeystrokeMs = now;

    if ((this.manualCharsBuffer >= 24 || this.manualBurstsCount >= 12) && now - this.lastManualEmitMs >= 12000) {
      this.lastManualEmitMs = now;
      const pts = Math.min(3.5, Math.max(1.5, this.manualCharsBuffer / 20));
      this.manualCharsBuffer = 0;
      this.manualBurstsCount = 0;

      // Note: persisted_diff_lines is populated upon real file save (onDidSaveTextDocument)
      // so unsaved / net-zero typing churn is recorded in the ledger as gated_no_diff until persisted.
      void this.ipc.send('struggle.emit', {
        source: 'vscode',
        project_root: projectRoot,
        event_type: 'SIG_MANUAL_CODE',
        points_hint: pts,
        persisted_diff_lines: 0,
        file_path: relPath,
        language: doc.languageId,
        ai_harness: this.ide.aiHarness,
        timestamp_ms: now,
      });
    }

    this.lastLineCounts.set(key, doc.lineCount);
  }

  private handleVisibleRangeChange(event: vscode.TextEditorVisibleRangesChangeEvent): void {
    const doc = event.textEditor.document;
    if (doc.uri.scheme !== 'file' || event.visibleRanges.length === 0) {
      return;
    }

    const now = Date.now();
    const key = doc.uri.toString();
    const topLine = event.visibleRanges[0].start.line;
    const prev = this.lastScrollState.get(key);
    this.lastScrollState.set(key, { line: topLine, ts: now });

    if (!prev) {
      return;
    }
    const elapsedSec = (now - prev.ts) / 1000;
    const lineDelta = Math.abs(topLine - prev.line);
    if (elapsedSec < 0.4 || lineDelta < 5) {
      return;
    }

    const linesPerSec = lineDelta / elapsedSec;
    const isHumanReadingPace = linesPerSec >= 3 && linesPerSec <= 45;
    if (!isHumanReadingPace) {
      return;
    }

    const projectRoot = this.resolveProjectRoot(doc.uri);
    const hasRecentAi = this.pruneIntervals(key, now).length > 0;

    // Reading-pace diff review over recently AI-modified file -> Moderate SIG_DIFF_SURGERY (+1.5 SP)
    if (hasRecentAi && now - this.lastDiffScrollEmitMs >= 20000) {
      this.lastDiffScrollEmitMs = now;
      void this.ipc.send('struggle.emit', {
        source: 'vscode',
        project_root: projectRoot,
        event_type: 'SIG_DIFF_SURGERY',
        points_hint: 1.5,
        language: doc.languageId,
        ai_harness: this.ide.aiHarness,
        timestamp_ms: now,
      });
      return;
    }

    // Deliberate codebase exploration scrolling -> SIG_CODE_EXPLORE (+2.0 SP)
    if (now - this.lastExploreEmitMs >= 30000) {
      this.lastExploreEmitMs = now;
      void this.ipc.send('struggle.emit', {
        source: 'vscode',
        project_root: projectRoot,
        event_type: 'SIG_CODE_EXPLORE',
        points_hint: 2.0,
        language: doc.languageId,
        ai_harness: this.ide.aiHarness,
        timestamp_ms: now,
      });
    }
  }

  private handleActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const now = Date.now();
    const uriStr = editor.document.uri.toString();
    const projectRoot = this.resolveProjectRoot(editor.document.uri);

    if (uriStr !== this.lastFileUri) {
      this.lastFileUri = uriStr;
      this.recentTabSwitches += 1;

      if (this.recentTabSwitches >= 3 && now - this.lastExploreEmitMs >= 25000) {
        this.recentTabSwitches = 0;
        this.lastExploreEmitMs = now;
        void this.ipc.send('struggle.emit', {
          source: 'vscode',
          project_root: projectRoot,
          event_type: 'SIG_CODE_EXPLORE',
          points_hint: 2.0,
          language: editor.document.languageId,
          ai_harness: this.ide.aiHarness,
          timestamp_ms: now,
        });
      }
    }

    void this.ipc.send('focus.update', {
      project_root: projectRoot,
      focused: vscode.window.state.focused,
      focus_context: this.hasActiveDiagnosticsErrors ? 'error' : 'code',
      language: editor.document.languageId,
      ai_harness: this.ide.aiHarness,
      timestamp_ms: now,
    });
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
