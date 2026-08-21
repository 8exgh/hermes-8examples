import type { Resources } from './provisioner/resources.js';

export type CapabilityId =
  | 'email'
  | 'calendar'
  | 'sms'
  | 'phone'
  | 'webdev'
  | 'paperwork';

/**
 * Where the person talks to their worker. Every tenant is reachable through
 * Rocket.Chat (the bridge speaks to the worker's API server); Telegram is
 * native to Hermes and switches on once a real bot token is in place.
 */
export type ChannelId = 'rocketchat' | 'telegram';

export interface CapabilityState {
  enabled: boolean;
  enabledAt?: string;
}

export type NudgeKind = 'offer' | 'deepen';

export interface NudgeRecord {
  /** e.g. "offer:email" or "deepen:calendar" */
  id: string;
  kind: NudgeKind;
  capability: CapabilityId;
  text: string;
  createdAt: string;
}

export interface AppliedRelease {
  imageRef: string;
  managedVersion: string;
  appliedAt: string;
}

export type Tier = 'container';

export interface Tenant {
  id: string;
  name: string;
  contact: { phone?: string; email?: string };
  channel: ChannelId;
  /**
   * Host port the worker's OpenAI-compatible API server (container 8642) is
   * published on, loopback only. The Rocket.Chat bridge talks to it.
   */
  gatewayPort: number;
  /**
   * Host port the worker's webhook listener (container 8644) is published on,
   * on loopback and the tailnet. The phone gateway wakes the worker here.
   */
  hookPort: number;
  tier?: Tier;
  /** Operator override; omitted means derived from enabled capabilities. */
  resources?: Partial<Resources>;
  /** Telegram numeric user ids allowed to reach this bot; empty/absent = open to anyone. */
  telegramAllowFrom?: string[];
  createdAt: string;
  capabilities: Partial<Record<CapabilityId, CapabilityState>>;
  nudgeLog: NudgeRecord[];
  applied?: AppliedRelease;
  /** Set when the tenant is offboarded; excluded from rollouts and nudging. */
  offboardedAt?: string;
}

export interface Fleet {
  /**
   * The image every tenant runs. Built locally from image/ on top of the
   * upstream nousresearch/hermes-agent image (see image/Dockerfile), so
   * `update` rebuilds with --pull and tags the result.
   */
  image: string;
  /** Upstream base the image is built FROM; `update` pulls its newest digest. */
  baseImage: string;
  /** Build-pinned tag resolved at the last `update`, so the whole fleet runs one build. */
  pinnedImageRef?: string;
  /** What the fleet ran before the last update — the one-command rollback target. */
  previousImageRef?: string;
  nextPort: number;
  /** Ports reclaimed from offboarded tenants, reused before nextPort advances. */
  freePorts?: number[];
}
