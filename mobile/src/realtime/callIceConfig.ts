/**
 * MOVED → src/calls/shared/callIceConfig.ts (calls-module separation —
 * ICE/TURN config is shared by both the 1:1 call screen and the group/meeting
 * mesh). This shim preserves the historical import path; new code should
 * import from "../calls/shared/callIceConfig" directly.
 */
export * from "../calls/shared/callIceConfig";