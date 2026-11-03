# Script test rules

- PTY harnesses must consume split/repeated terminal queries and finish cursor
  restoration before sending interaction keys. Drain follow-up inline output with
  a bounded quiet wait; neither a title substring nor a fixed count of reads proves
  a draw is complete. Keep waits bounded and report the captured output on failure.
- Declare terminal color capabilities in the test child when asserting ANSI RGB
  output; runner log preferences such as NO_COLOR must not change the fixture.
