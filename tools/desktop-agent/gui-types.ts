import type { Page } from "@playwright/test";
export interface GuiWindow {
  windowId: string;
  generation: number;
  observable: boolean;
  unavailableReason?: string;
  bounds: { x: number; y: number; width: number; height: number };
  focused: boolean;
  visible: boolean;
  minimized: boolean;
  zoomFactor: number;
}
export interface DocumentState {
  documentId: string;
  revision: number;
  url: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  scroll: { x: number; y: number };
  focused: boolean;
}
export interface GuiNode {
  ref: string;
  parent?: string;
  depth: number;
  role: string;
  name?: string;
  text?: string;
  placeholder?: string;
  valueMasked?: boolean;
  actionable: boolean;
  duplicateName?: boolean;
  state: Record<string, boolean | string | number>;
  box?: { x: number; y: number; width: number; height: number };
}
export interface GuiSnapshot {
  snapshotId: string;
  sessionId: string;
  runId: string;
  buildId?: string;
  time: string;
  window: GuiWindow;
  document: DocumentState;
  nodes: GuiNode[];
  truncated: boolean;
  coordinateSystem: "viewport-css-pixels";
}
export interface SnapshotHandle {
  snapshot: GuiSnapshot;
  page: Page;
  targets: Map<string, string>;
}
