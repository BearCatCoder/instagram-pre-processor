param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string]$ConfigBase64
)

$ErrorActionPreference = 'Stop'

try {
    $photoshop = New-Object -ComObject Photoshop.Application
    $photoshop.Visible = $true
    $script = [System.IO.File]::ReadAllText($ScriptPath, [System.Text.Encoding]::UTF8)
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($ConfigBase64))
    $payload = "var RPP_CONFIG = $json;`n" + $script
    $null = $photoshop.DoJavaScript($payload)
    exit 0
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $photoshop) {
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($photoshop) | Out-Null
    }
}
