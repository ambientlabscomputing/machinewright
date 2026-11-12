/**
 * TS wrapper around `MachinewrightShortcutsModule`: app-wide keyboard
 * chords that must fire regardless of which surface (React Native views,
 * the CodeMirror WebView, the terminal WebView) currently owns focus.
 * Chords are the canonical strings from `commands/chords.ts`.
 */
import { NativeEventEmitter, NativeModules } from "react-native";

interface MachinewrightShortcutsNativeModule {
  setChords(chords: readonly string[]): void;
  focusSurface(urlFragment: string): Promise<boolean>;
  focusedSurface(): Promise<string | null>;
}

const EVENT_NAME = "MachinewrightShortcut";

function nativeModule(): MachinewrightShortcutsNativeModule {
  const native = NativeModules.MachinewrightShortcutsModule as MachinewrightShortcutsNativeModule | undefined;
  if (!native) {
    throw new Error("MachinewrightShortcutsModule native module is not linked — check macos/ target membership");
  }
  return native;
}

/** Declares which chords the native layer should intercept (replaces any previous set). */
export function setInterceptedChords(chords: readonly string[]): void {
  nativeModule().setChords(chords);
}

/** Subscribes to intercepted chords; returns the unsubscribe function. */
export function onShortcut(listener: (chord: string) => void): () => void {
  const emitter = new NativeEventEmitter(NativeModules.MachinewrightShortcutsModule);
  const subscription = emitter.addListener(EVENT_NAME, (event: { chord: string }) => listener(event.chord));
  return () => subscription.remove();
}

/** The bundled WebView surfaces, by the URL fragment that identifies each. */
export type Surface = "editor" | "terminal" | "viewport";

/** Makes the named WebView surface the window's first responder (script-level focus alone cannot). */
export function focusSurface(surface: Surface): Promise<boolean> {
  return nativeModule().focusSurface(`web/${surface}/`);
}

/** Which WebView surface holds keyboard focus right now, or null if focus is in a native view. */
export async function focusedSurface(): Promise<Surface | null> {
  const url = await nativeModule().focusedSurface();
  if (!url) return null;
  for (const surface of ["editor", "terminal", "viewport"] as const) {
    if (url.includes(`web/${surface}/`)) return surface;
  }
  return null;
}
