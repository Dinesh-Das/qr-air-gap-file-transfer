# Preserve Windows process-observer failure context

The development-only Windows memory sampler must keep every missing requested
PID in `missingIds`. Add `missingReasons` as bounded diagnostic context: PID,
Windows error category, error identifier, exception type and message. Use an
explicit unknown reason if no error record exists. Never invent zero counters,
exclude auxiliary processes, retry until green, or change summary validity.

Cap message/error-ID/exception/category strings at 256/128/128/64 characters.
Clear the reason array for each request, including the resident observer loop.
Successful observations return an empty reason array. Keep native counters,
timestamps, duplicate-ID handling, input limits and fatal counter errors intact.

Controlled live/exited-process tests and native integration tests must distinguish
observed lookup failures from an assumed cause. Earlier Chrome process gaps lack
the error records, so they remain unexplained and their measurements stay failed.
This change does not alter the transfer application, client assets or packaged
runtime; unchanged bundle browser gates retain their original execution scope.
Physical, GUI, hosted CI, full resource/throughput and 50–100 GB gates remain open.
