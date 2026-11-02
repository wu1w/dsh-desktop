# Uses only Windows/.NET assemblies. Honor the machine's PowerShell execution policy.
# Manual invocation requires powershell.exe -Mta; the application uses a fixed MTA bootstrap.
# No profile, remote module, registry, service, elevation or UIAccess changes.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions
    $references = @(
        [System.Windows.Automation.AutomationElement].Assembly.Location,
        [System.Windows.Automation.InvokePatternIdentifiers].Assembly.Location,
        [System.Windows.Rect].Assembly.Location,
        [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location,
        [System.Linq.Enumerable].Assembly.Location,
        [System.ComponentModel.Component].Assembly.Location
    ) | Select-Object -Unique
    Add-Type -Path (Join-Path $PSScriptRoot 'computer-helper.windows.cs') -ReferencedAssemblies $references
    [DshComputer.WindowsAdapter]::Run()
} catch {
    # Never forward exception text: UI Automation exceptions can contain app content.
    [Console]::Error.WriteLine('COMPUTER_NATIVE_UNAVAILABLE')
    exit 1
}
