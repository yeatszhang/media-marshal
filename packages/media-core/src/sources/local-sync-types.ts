import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { SourceSnapshot } from "../files/source-root.js";

export interface Plan {
  source: ManagedRootGrant;
  snapshot: SourceSnapshot;
  sourceSegments: string[];
  targetSegments: string[];
  target: ManagedRootGrant;
  variant: string;
}
export interface Operation {
  id: string;
  identity_key: string;
  source_namespace: string;
  source_object_key: string;
  source_version_key: string;
  version_json: string;
  target_directory_id: string;
  target_slot: string;
  plan_json: string;
  attempt_id: string;
  phase: string;
  evidence_json: string | null;
}
