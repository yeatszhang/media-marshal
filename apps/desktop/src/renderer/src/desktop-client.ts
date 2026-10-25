import { createIdentifier } from "@yeatz/app-framework/ioc";
import type { DesktopApi } from "@media-marshal/contracts";

export const DesktopClient = createIdentifier<DesktopApi>("renderer.desktop-client");
