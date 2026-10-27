import type { DesktopApi } from "@media-marshal/contracts";
declare global {
  interface Window {
    desktopApi: DesktopApi;
  }
}
export {};
