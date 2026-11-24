# Bring the terminal window that hosts the herdr client to the front (Windows).
# ShiftBoss runs this after `herdr agent focus`, so "Open in herdr" lands on the right pane, visibly.
# It only restores and raises a window; it sends no keys to the terminal.
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SbWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@

# The herdr client is the herdr.exe that is not the server.
$client = Get-CimInstance Win32_Process -Filter "Name='herdr.exe'" |
  Where-Object { $_.CommandLine -notmatch '\sserver(\s|$)' } | Select-Object -First 1
if (-not $client) { Write-Output 'no-client'; exit 0 }

# Walk up the parents to the first process that owns a window (Windows Terminal, conhost, ...).
$id = $client.ProcessId
for ($i = 0; $i -lt 8 -and $id; $i++) {
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $h = $proc.MainWindowHandle
    if ([SbWin]::IsIconic($h)) { [void][SbWin]::ShowWindow($h, 9) } # SW_RESTORE
    # Windows only lets the foreground app hand focus away; a tap of Alt lifts that lock.
    [SbWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [SbWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][SbWin]::SetForegroundWindow($h)
    Write-Output "raised $($proc.ProcessName)"
    exit 0
  }
  $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id").ParentProcessId
}
Write-Output 'no-window'
