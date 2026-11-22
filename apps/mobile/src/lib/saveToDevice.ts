import { msg } from "gt-react-native";
import { Platform, ToastAndroid } from "react-native";

import { m } from "../i18n/messages";

const SAVABLE_IMAGE_MIME_TYPE = /^image\/(png|jpe?g|gif|webp|heic|heif)$/i;

type SaveToDeviceModule = {
  saveImageToLibrary(uri: string, mimeType: string, name: string): Promise<void>;
  saveFileToDownloads(uri: string, name: string): Promise<string>;
};

function baseMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim() ?? "";
}

// Android 9 and older need a storage permission to add photos, so they keep the share sheet.
export function canSaveImageToLibrary(mimeType: string): boolean {
  return (
    SAVABLE_IMAGE_MIME_TYPE.test(baseMimeType(mimeType)) &&
    (Platform.OS === "ios" || (Platform.OS === "android" && Platform.Version >= 29))
  );
}

// Loaded on use so screens importing the platform checks stay renderable in jsdom tests.
async function nativeModule() {
  const { requireNativeModule } = await import("expo");
  return requireNativeModule<SaveToDeviceModule>("T3NativeControls");
}

/** Adds a local image file to Photos on iOS or Pictures/T3 Code on Android. */
export async function saveImageToLibrary(uri: string, mimeType: string, name: string) {
  await (await nativeModule()).saveImageToLibrary(uri, baseMimeType(mimeType), name);
}

// The iOS share sheet already offers Save to Files; Android's has no on-device target.
export function canSaveFileToDownloads(): boolean {
  return Platform.OS === "android" && Platform.Version >= 29;
}

export function showDownloadStarted(name: string) {
  ToastAndroid.show(m(msg("Downloading {name}…", { name })), ToastAndroid.SHORT);
}

/** Copies a local `file:` or `content:` URI into Android's public Downloads folder. */
export async function saveFileToDownloads(uri: string, name: string, signal: AbortSignal) {
  const native = await nativeModule();
  if (signal.aborted) return;
  const saved = await native.saveFileToDownloads(uri, name);
  ToastAndroid.show(m(msg("Saved {saved} to Downloads", { saved })), ToastAndroid.SHORT);
}
