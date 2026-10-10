param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(0, 100)]
  [int]$Level
)

$ErrorActionPreference = "Stop"

$coreAudio = @'
using System;
using System.Runtime.InteropServices;

namespace VoicePilot.WindowsAudio {
    public enum DataFlow { Render = 0, Capture = 1, All = 2 }
    public enum Role { Console = 0, Multimedia = 1, Communications = 2 }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        void EnumAudioEndpoints(DataFlow dataFlow, uint stateMask, out IntPtr devices);
        void GetDefaultAudioEndpoint(DataFlow dataFlow, Role role, out IMMDevice endpoint);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
        void RegisterEndpointNotificationCallback(IntPtr client);
        void UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        void Activate(ref Guid interfaceId, uint classContext, IntPtr activationParams, [MarshalAs(UnmanagedType.Interface)] out IAudioEndpointVolume volume);
        void OpenPropertyStore(uint access, out IntPtr properties);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out uint state);
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioEndpointVolume {
        void RegisterControlChangeNotify(IntPtr notify);
        void UnregisterControlChangeNotify(IntPtr notify);
        void GetChannelCount(out uint channelCount);
        void SetMasterVolumeLevel(float levelDb, ref Guid eventContext);
        void SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        void GetMasterVolumeLevel(out float levelDb);
        void GetMasterVolumeLevelScalar(out float level);
        void SetChannelVolumeLevel(uint channel, float levelDb, ref Guid eventContext);
        void SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        void GetChannelVolumeLevel(uint channel, out float levelDb);
        void GetChannelVolumeLevelScalar(uint channel, out float level);
        void SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        void GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        void GetVolumeStepInfo(out uint step, out uint stepCount);
        void VolumeStepUp(ref Guid eventContext);
        void VolumeStepDown(ref Guid eventContext);
        void QueryHardwareSupport(out uint hardwareSupportMask);
        void GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
    }

    public static class MasterVolume {
        private static IAudioEndpointVolume GetEndpointVolume() {
            var enumeratorType = Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), true);
            var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(enumeratorType);
            IMMDevice endpoint = null;
            try {
                enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia, out endpoint);
                var interfaceId = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
                IAudioEndpointVolume volume;
                endpoint.Activate(ref interfaceId, 23, IntPtr.Zero, out volume);
                return volume;
            } finally {
                if (endpoint != null && Marshal.IsComObject(endpoint)) Marshal.ReleaseComObject(endpoint);
                if (enumerator != null && Marshal.IsComObject(enumerator)) Marshal.ReleaseComObject(enumerator);
            }
        }

        public static int SetAndRead(int percent) {
            var volume = GetEndpointVolume();
            try {
                var eventContext = Guid.Empty;
                volume.SetMasterVolumeLevelScalar(percent / 100.0f, ref eventContext);
                float actual;
                volume.GetMasterVolumeLevelScalar(out actual);
                return (int)Math.Round(actual * 100.0f, MidpointRounding.AwayFromZero);
            } finally {
                if (Marshal.IsComObject(volume)) Marshal.ReleaseComObject(volume);
            }
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $coreAudio -Language CSharp -ErrorAction Stop
  $actualLevel = [VoicePilot.WindowsAudio.MasterVolume]::SetAndRead($Level)
  @{ level = $actualLevel } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine("Windows master volume could not be set: $($_.Exception.Message)")
  exit 1
}
