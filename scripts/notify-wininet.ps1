$code = @'
using System;
using System.Runtime.InteropServices;
public class WinINetNotifier {
    [DllImport("wininet.dll", SetLastError = true)]
    public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
    public static void Notify() {
        InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0);
    }
}
'@

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
    [WinINetNotifier]::Notify()
    Write-Host "[OK] Proxy settings successfully refreshed!"
} catch {
    Write-Host "[WARN] Failed to refresh: $($_.Exception.Message)"
}
