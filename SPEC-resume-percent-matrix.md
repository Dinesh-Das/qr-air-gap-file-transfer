# Required interruption percentage matrix

Exercise 0%, 1%, 25%, 50%, 99%, and all payload durable before completion.
Use a virtual stream of exactly 100 equal 60 KiB blocks, including metadata and
footer, so each requested point is an exact byte percentage. Admit only the
chosen prefix. At nonzero points, lose the last durable commit's ACK and abort
the first sender before sender-complete. Drain accepted writes, close and reopen
the same repository, and verify the exact receipt prefix and resumed-byte count.

The next sender must transmit exactly the missing indices, with batched durable
ACKs. It must send sender-complete only after payload completion. At 100% it must
send no payload after reconnect. Verify the whole stream and validated tree,
then independently inspect every payload byte against the fixture's offset
pattern. Retain existing timeout, ACK validation, corruption and browser gates.

This is a deterministic in-memory repository/data-channel model of protocol and
receipt behavior. It does not establish OPFS flush/power-loss durability, native
filesystem behavior, large-file memory bounds, or real network recovery. Those
need their separate browser and physical evidence.
