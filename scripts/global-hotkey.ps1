$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.Net.Http;
using System.Runtime.InteropServices;

public static class VoicePilotGlobalHotkey {
    [StructLayout(LayoutKind.Sequential)]
    private struct Message {
        public IntPtr window;
        public uint id;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);

    public static int Run(string endpoint) {
        const int id = 0x5650;
        const uint alt = 0x0001;
        const uint keyM = 0x4D;
        if (!RegisterHotKey(IntPtr.Zero, id, alt, keyM)) return Marshal.GetLastWin32Error();
        try {
            using (var client = new HttpClient()) {
                client.Timeout = TimeSpan.FromSeconds(3);
                Message message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
                    if (message.id != 0x0312) continue;
                    try {
                        using (var response = client.PostAsync(endpoint, null).GetAwaiter().GetResult()) { }
                    } catch { }
                }
            }
            return 0;
        } finally {
            UnregisterHotKey(IntPtr.Zero, id);
        }
    }
}
'@

$endpoint = if ($env:VOICEPILOT_HOTKEY_ENDPOINT) { $env:VOICEPILOT_HOTKEY_ENDPOINT } else { "http://127.0.0.1:8787/api/hotkey/toggle" }
$result = [VoicePilotGlobalHotkey]::Run($endpoint)
if ($result -ne 0) { throw "Could not register Alt+M as a Windows global hotkey (Win32 error $result). Another app may already own it." }
