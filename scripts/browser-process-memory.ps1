$ErrorActionPreference = 'Stop'
$memoryProcessIds = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($memoryProcessIds.Count -lt 1 -or $memoryProcessIds.Count -gt 64) {
    throw 'Invalid process ID list.'
}
foreach ($memoryProcessId in $memoryProcessIds) {
    if ($memoryProcessId -isnot [ValueType] -or $memoryProcessId -ne [math]::Truncate($memoryProcessId) -or
        $memoryProcessId -lt 1 -or $memoryProcessId -gt 2147483647) {
        throw 'Invalid process ID list.'
    }
}
$memoryStarted = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$memoryResults = @()
$memoryMissing = @()
foreach ($memoryProcessId in ($memoryProcessIds | Select-Object -Unique)) {
    $memoryProcess = Get-Process -Id ([int]$memoryProcessId) -ErrorAction SilentlyContinue
    if ($null -eq $memoryProcess) { $memoryMissing += [int]$memoryProcessId; continue }
    try {
        $memoryProcess.Refresh()
        $memoryResults += @{ id = $memoryProcess.Id; privateBytes = $memoryProcess.PrivateMemorySize64;
            workingSetBytes = $memoryProcess.WorkingSet64 }
    } finally { $memoryProcess.Dispose() }
}
@{ sampleStartedAtMs = $memoryStarted; sampleFinishedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
    processes = @($memoryResults); missingIds = @($memoryMissing) } | ConvertTo-Json -Depth 4 -Compress
