import { requireNativeModule } from "expo";
import { Platform, ToastAndroid } from "react-native";

const SAVABLE_IMAGE_MIME_TYPE = /^image\/(png|jpe?g|gif|webp|heic|heif)$/i;

type SaveToDeviceModule = {
  saveImageToLibrary(uri: string, mimeType: string, name: string): Promise<void>;
  saveFileToDownloads(uri: string, name: string): Promise<void>;
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

/** Adds a local image file to Photos on iOS or Pictures/T3 Code on Android. */
export function saveImageToLibrary(uri: string, mimeType: string, name: string): Promise<void> {
  return requireNativeModule<SaveToDeviceModule>("T3NativeControls").saveImageToLibrary(
    uri,
    baseMimeType(mimeType),
    name,
  );
}

// The iOS share sheet already offers Save to Files; Android's has no on-device target.
export function canSaveFileToDownloads(): boolean {
  return Platform.OS === "android" && Platform.Version >= 29;
}

/** Copies a local `file:` or `content:` URI into Android's public Downloads folder. */
export async function saveFileToDownloads(uri: string, name: string) {
  await requireNativeModule<SaveToDeviceModule>("T3NativeControls").saveFileToDownloads(uri, name);
  ToastAndroid.show(`Saved ${name} to Downloads`, ToastAndroid.SHORT);
}
