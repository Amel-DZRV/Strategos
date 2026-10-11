import type { ProcSample } from '@strategos/shared';

export type { ProcSample };

/** Injected file writer. The daemon wires safe-fs here; platform code never writes files itself (lint rule). */
export interface PlatformWriter {
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type LocateResult = { exe: string; version: string } | { error: string };

export interface Platform {
  paths: {
    strategosHome(): string;
    claudeConfigDir(): string;
    canonical(p: string): string;
    projectDirName(cwd: string): string;
  };
  locateClaude(cfg: { claudePath?: string }): Promise<LocateResult>;
  proc: {
    isAlive(pid: number, startTime?: string): Promise<boolean>;
    startTime(pid: number): Promise<string | null>;
    killTree(pid: number): Promise<void>;
    sample(): AsyncIterable<ProcSample[]>;
  };
  openExternal(urlOrPath: string): Promise<void>;
  openAppWindow(url: string): Promise<void>;
  autostart: { get(): Promise<boolean>; set(on: boolean): Promise<void> };
}

export interface PlatformOptions {
  writer?: PlatformWriter;
  /** Command line that autostart should launch: [exe, ...args]. Default: node + daemon main.ts + "start". */
  autostartCommand?: () => string[];
  /** Sampler period; default 5000 ms. */
  sampleIntervalMs?: number;
}
