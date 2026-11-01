import type { CoreDatabase } from "@media-marshal/media-core";
import type { ManagedRootGrant, TransferItem } from "@media-marshal/contracts/internal";
import type { CloudRoots } from "../../../../packages/media-core/dist/cloud/roots.js";
export interface DownloadFixture {
  jobId: string;
  itemId: string;
  attemptId: string;
  root: ReturnType<CloudRoots["files"]["get"]>;
  item: TransferItem;
  plan: { attemptId: string; targetGrantId: string; items: TransferItem[] };
}
export function seedDownloadPlan(
  database: CoreDatabase,
  roots: CloudRoots,
  grant: ManagedRootGrant,
  content: Buffer,
  options?: { blockedTarget?: boolean; filename?: string },
): DownloadFixture;
export function publishDownloadPlan(
  database: CoreDatabase,
  roots: CloudRoots,
  fixture: DownloadFixture,
  content: Buffer,
): Promise<void>;
