/** Public account status only. Kit tokens and Gateway keys stay in main. */
export interface KitSnapshot {
  readonly state: "disconnected" | "signing-in" | "connected" | "failed";
  readonly message?: string;
  readonly signInUrl?: string;
  readonly account?: string;
  readonly connections: readonly { readonly service: string; readonly name: string }[];
}

export const KIT_PROVIDER_ID = "kit-ai-gateway";
