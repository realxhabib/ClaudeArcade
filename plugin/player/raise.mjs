// Windows only: brings the game window to the front. Windows stops a program
// in the background from taking the foreground (a game popping up while you
// type in the terminal is exactly that), so Chrome's own bringToFront leaves
// the window behind. This asks Windows directly, through PowerShell and
// user32: restore the browser's windows, lift them to the top of the stack
// (topmost for an instant, then back to normal), and hand over the keyboard
// (an Alt tap first is the usual way past the foreground lock).

import { spawn } from "node:child_process";

const SCRIPT = (pid) => `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ArcadeWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static int Raise(uint pid) {
    int raised = 0;
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      ShowWindow(h, 9);
      SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x43);
      SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x43);
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(h);
      raised++;
      return true;
    }, IntPtr.Zero);
    return raised;
  }
}
"@
[ArcadeWindow]::Raise(${Number(pid)})
`;

/** Raises the windows of browser process `pid` (no-op off Windows). Resolves to how many it raised. */
export function raiseWindow(pid) {
  if (process.platform !== "win32" || !pid) return Promise.resolve(0);
  const encoded = Buffer.from(SCRIPT(pid), "utf16le").toString("base64");
  return new Promise((resolve) => {
    let out = "";
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    ps.stdout.on("data", (d) => (out += d));
    ps.on("error", () => resolve(0));
    ps.on("exit", () => resolve(Number.parseInt(out.trim(), 10) || 0));
  });
}
