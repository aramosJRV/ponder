// Delivers an already-generated journal export to the user.
//
// On the web this is a plain Blob-URL download — the browser owns the save
// dialog. That trick is a silent no-op on Android/iOS: Capacitor's WebView
// has no Downloads folder to hit and never surfaces the anchor's `download`
// attribute, so the button used to appear to do nothing on-device. Native
// platforms instead write the file into the app's cache dir via
// @capacitor/filesystem and hand it to @capacitor/share, which opens the
// OS share sheet (Save to Files / Drive / AirDrop / etc.) — the standard
// Capacitor pattern for "download" on mobile, since neither platform lets a
// web view write straight into a user-visible folder.
import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/**
 * Save (web) or share (native) the journal markdown.
 *
 * Throws on failure — callers are expected to run this through their normal
 * error-reporting path (AccountSection's `run()`) rather than swallow it.
 * The old version didn't, which is why a native failure showed nothing at
 * all: not even the fact that something had gone wrong.
 */
export async function saveJournalExport(markdown: string): Promise<void> {
  const filename = `ponder-journal-${new Date().toISOString().slice(0, 10)}.md`;

  if (Capacitor.isNativePlatform()) {
    const written = await Filesystem.writeFile({
      path: filename,
      data: markdown,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({
      title: "Ponder journal",
      dialogTitle: "Save your journal",
      url: written.uri,
    });
    return;
  }

  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
