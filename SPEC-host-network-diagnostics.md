# Test-only host snapshot after navigation buffer failure

Hosted run40086419522 failed before the first document loaded with
`net::ERR_NO_BUFFER_SPACE`. Its trace contains no OS memory or TCP statistics.
The root cause remains unknown. Passing local tests do not clear that failure.

Questions for a future occurrence: what host memory was available shortly
afterward, what were the system-wide IPv4 TCP counters, and when were they
collected? These observations provide context, not a cause or capacity limit.

The pairing test file has one afterEach hook. It does no sampling or attachment
unless TestInfo contains this specific native error. One matching test produces
at most one attachment, regardless of duplicate error entries. The hook does
not navigate, retry, change assertions, increase test deadlines, skip tests or
modify TestInfo errors. Product code and browser launch policy are unchanged.

The snapshot includes collection start/end timestamps, host free/total memory,
the Node test worker's RSS (not browser memory), and six allowlisted IPv4 TCP
counters. The Windows collector runs one static PowerShell command with a
2second timeout and16KiB output cap. Other platforms explicitly report TCP
unsupported; native errors or malformed counters report unavailable. Only
finite nonnegative safe integer counters are accepted. No hostname, process
list, remote addresses, request URL, credentials or raw error text is retained.
Sampling and attachment failures preserve the original test error.

The hook runs after the test and may follow browser-context teardown. Its data
is not a measurement at the failed navigation, a browser process memory bound,
or proof of buffer exhaustion, a leak, a product fix or product innocence.
Windows IPv4 TCP counters are system-wide cumulative/current statistics, not
application connection counts. Their API is documented in
[Microsoft's GetTcpIPv4Statistics reference](https://learn.microsoft.com/en-us/dotnet/api/system.net.networkinformation.ipglobalproperties.gettcpipv4statistics).

Six unit controls cover inert successful/unrelated tests, duplicate errors,
error-text exclusion, sampler failure, attachment failure and native-output
validation. A real Windows collector smoke and synthetic TestInfo error check
exercise the native collector/attachment; they do not reproduce the original
navigation failure. The existing complete unit/browser gate remains required.
