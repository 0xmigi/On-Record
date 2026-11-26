// sBPF versions on the stats page: one figure per network for each version,
// drawn by ToolchainView as paired meters (mainnet solid, devnet hatched).
// Each figure is where the share went over the window, first half → second
// half, when both halves were read enough to compare; else the window's share.

export type VersionNet = {
  net: "mainnet" | "devnet" | null;
  /** programs at this version over the window */
  n: number;
  /** share of the window, 0-100 */
  share: number;
  /** shares of the first and second half, 0-100, when both were read enough */
  early: number | null;
  late: number | null;
};

export type VersionRow = { version: string; nets: VersionNet[] };
