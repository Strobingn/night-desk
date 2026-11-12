/** Installed desk release. A crash card shows only when the report was recorded on this version. */
export const APP_VERSION = "13.33";

export interface ClientCrash {
  at: number;
  version: string;
  brief: string;
  /** Full report. Home shows the short brief. Settings shows this. */
  text: string;
  /** Hidden on Home. The stored record is not deleted. */
  dismissed: boolean;
}

/** Home card. Older versions and a dismissed report stay off the card. */
export function crashOnHome(crash: { version: string; dismissed?: boolean } | null | undefined, installed: string): boolean {
  if (!crash || crash.dismissed) return false;
  const version = crash.version.trim();
  return version.length > 0 && version === installed.trim();
}
