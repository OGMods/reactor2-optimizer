/**
 * Public surface of the component tree — what `App.svelte` mounts.
 *
 * Components that are only ever rendered by a sibling in their own folder
 * (`TerrainPalette`, `BuildingUnlockCard`, `GridControls`, …) are deliberately
 * not re-exported: they are imported directly by their parent, and listing them
 * here would just be an export nothing consumes.
 */

export { default as Header } from "./header/Header.svelte";
export { default as PreviewBanner } from "./header/PreviewBanner.svelte";
export { default as PixiCanvas } from "./canvas/PixiCanvas.svelte";
export { default as HudToolbar } from "./hud/HudToolbar.svelte";
export { default as BoardStatsCard } from "./inspector/BoardStatsCard.svelte";
export { default as ConfigSidebar } from "./sidebar/ConfigSidebar.svelte";
export { default as ShareModal } from "./modals/ShareModal.svelte";
export { default as ImportModal } from "./modals/ImportModal.svelte";
export { default as SettingsModal } from "./modals/SettingsModal.svelte";
export { default as SolveModal } from "./modals/SolveModal.svelte";
export { default as SolveModeInfoModal } from "./modals/SolveModeInfoModal.svelte";
