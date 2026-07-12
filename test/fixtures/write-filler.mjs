/** Writes `line` (repeated) to `stream` until at least `targetBytes` have been written. Used by fixtures that need to exercise a buffer-size cap. */
export function writeFiller(stream, line, targetBytes) {
  let written = 0;
  while (written < targetBytes) {
    stream.write(line);
    written += Buffer.byteLength(line);
  }
}
