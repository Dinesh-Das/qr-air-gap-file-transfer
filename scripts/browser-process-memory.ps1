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
$memoryMissingReasons = @()
foreach ($memoryProcessId in ($memoryProcessIds | Select-Object -Unique)) {
    $memoryLookupErrors = @()
    $memoryProcess = Get-Process -Id ([int]$memoryProcessId) -ErrorAction SilentlyContinue -ErrorVariable memoryLookupErrors
    if ($null -eq $memoryProcess) {
        $memoryMissing += [int]$memoryProcessId
        $memoryLookupError = @($memoryLookupErrors) | Select-Object -First 1
        $memoryReasonMessage = 'Get-Process returned no process and no error record.'
        $memoryReasonId = ''
        $memoryReasonType = ''
        $memoryReasonCategory = 'NoErrorRecord'
        if ($null -ne $memoryLookupError) {
            $memoryReasonMessage = [string]$memoryLookupError.Exception.Message
            $memoryReasonId = [string]$memoryLookupError.FullyQualifiedErrorId
            $memoryReasonType = [string]$memoryLookupError.Exception.GetType().FullName
            $memoryReasonCategory = [string]$memoryLookupError.CategoryInfo.Category
        }
        $memoryMissingReasons += @{ id = [int]$memoryProcessId;
            message = $memoryReasonMessage.Substring(0, [Math]::Min(256, $memoryReasonMessage.Length));
            errorId = $memoryReasonId.Substring(0, [Math]::Min(128, $memoryReasonId.Length));
            exceptionType = $memoryReasonType.Substring(0, [Math]::Min(128, $memoryReasonType.Length));
            category = $memoryReasonCategory.Substring(0, [Math]::Min(64, $memoryReasonCategory.Length)) }
        continue
    }
    try {
        $memoryProcess.Refresh()
        $memoryResults += @{ id = $memoryProcess.Id; privateBytes = $memoryProcess.PrivateMemorySize64;
            workingSetBytes = $memoryProcess.WorkingSet64 }
    } finally { $memoryProcess.Dispose() }
}
@{ sampleStartedAtMs = $memoryStarted; sampleFinishedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
    processes = @($memoryResults); missingIds = @($memoryMissing); missingReasons = @($memoryMissingReasons) } | ConvertTo-Json -Depth 4 -Compress
